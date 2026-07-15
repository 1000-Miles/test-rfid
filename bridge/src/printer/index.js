'use strict';

/**
 * Printer manager for the Chainway CP30: builds ZPL and sends it over the
 * configured transport.
 *
 *   usb -> Windows print queue (RAW datatype via winspool), queue name in
 *          config.printerName. Works with the "Generic / Text Only" driver.
 *   tcp -> raw socket to <host>:9100 (printer on Ethernet/Wi-Fi).
 *
 * Config + the test-EPC counter persist to bridge/data/printer.json so EPCs
 * stay unique across restarts.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');
const zpl = require('./zpl');

const STATE_PATH = path.join(__dirname, '..', '..', 'data', 'printer.json');
// Append-only durable log of every physical print — the airtight source of truth
// for reconcile: a carton recorded here WAS printed, even if the browser/PC died
// before it could tell Nexus. One JSON object per line, so a crash mid-append
// only tears the last line (skipped on read).
const LOG_PATH = path.join(__dirname, '..', '..', 'data', 'print-log.jsonl');
// Past this size the log rotates to print-log.jsonl.1 (one archive kept), so the
// on-disk log + each reconcile read stay bounded at ~2x this. ~5 MB ≈ 50k prints
// per file, so current + archive ≈ 100k prints of history — far more than any
// realistic resume window (buildPrintPlan caps a job at 10k cartons).
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const DEFAULT_CONFIG = {
  transport: process.env.PRINTER_TRANSPORT || 'usb', // 'usb' | 'tcp'
  printerName: process.env.PRINTER_NAME || 'Chainway CP30',
  host: process.env.PRINTER_HOST || '192.168.99.201',
  port: Number(process.env.PRINTER_TCP_PORT || 9100),
  epcPrefix: 'AA00',
  barcode: true,
  widthDots: null,
  heightDots: null,
  topOffsetDots: 0,
  leftOffsetDots: 0,
  extraZpl: '',
};

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

function sendTcp(host, port, data, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }, () => socket.end(data));
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`TCP send to ${host}:${port} timed out`)));
    socket.on('error', reject);
    socket.on('close', (hadError) => {
      if (!hadError) resolve();
    });
  });
}

class PrinterManager {
  constructor(opts = {}) {
    this.log = opts.log || ((text) => console.log(`[printer] ${text}`));
    this.config = { ...DEFAULT_CONFIG };
    this.counter = 0; // last used test-EPC counter
    this.lastPrint = null;
    this._load();
  }

  _load() {
    try {
      const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      for (const k of CONFIG_KEYS) {
        if (state.config && state.config[k] !== undefined) this.config[k] = state.config[k];
      }
      if (Number.isFinite(state.counter)) this.counter = state.counter;
      if (state.lastPrint) this.lastPrint = state.lastPrint;
    } catch {
      // first run: no state file yet
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
      fs.writeFileSync(
        STATE_PATH,
        JSON.stringify({ config: this.config, counter: this.counter, lastPrint: this.lastPrint }, null, 2)
      );
    } catch (err) {
      this.log(`state save failed: ${err.message}`, 'warn');
    }
  }

  // Append one print to the durable log (crash-safe, one JSON per line). Rotates
  // before appending once the file is large, so it never grows without bound.
  _appendLog(entry) {
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      // Rotate current -> .1 (overwriting any prior archive) via atomic rename.
      // Best-effort: if rotation fails we still append to the current file, so
      // the durable record is never skipped.
      try {
        if (fs.statSync(LOG_PATH).size >= MAX_LOG_BYTES) {
          try { fs.unlinkSync(LOG_PATH + '.1'); } catch { /* no prior archive */ }
          fs.renameSync(LOG_PATH, LOG_PATH + '.1');
        }
      } catch { /* file doesn't exist yet — nothing to rotate */ }
      fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n');
    } catch (err) {
      this.log(`print-log append failed: ${err.message}`, 'warn');
    }
  }

  /** Read the durable print log (archive + current), optionally filtered to one
   *  jobId. Reading both means a job's entries survive a rotation between prints. */
  readPrintLog({ jobId } = {}) {
    const out = [];
    for (const p of [LOG_PATH + '.1', LOG_PATH]) {
      let raw;
      try {
        raw = fs.readFileSync(p, 'utf8');
      } catch {
        continue; // archive or current not present yet
      }
      for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          if (!jobId || e.jobId === jobId) out.push(e);
        } catch {
          // torn last line from a crash mid-append — skip
        }
      }
    }
    return out;
  }

  setConfig(partial = {}) {
    for (const k of CONFIG_KEYS) {
      if (partial[k] === undefined) continue;
      if (k === 'port') this.config.port = Number(partial.port) || 9100;
      else if (k === 'barcode') this.config.barcode = Boolean(partial.barcode);
      else if (k === 'widthDots' || k === 'heightDots')
        this.config[k] = partial[k] == null || partial[k] === '' ? null : Number(partial[k]);
      else if (k === 'topOffsetDots' || k === 'leftOffsetDots')
        // may be negative — moves content up / left (final coord clamped in zpl.js)
        this.config[k] = Math.round(Number(partial[k]) || 0);
      else this.config[k] = String(partial[k]);
    }
    if (this.config.transport !== 'tcp') this.config.transport = 'usb';
    this._save();
    this.log(`config updated: ${JSON.stringify(this.config)}`);
    return this.config;
  }

  getStatus() {
    return {
      config: this.config,
      nextEpc: zpl.testEpc(this.config.epcPrefix, this.counter + 1),
      lastPrint: this.lastPrint,
    };
  }

  /**
   * Is a printer actually reachable behind the configured transport?
   *
   * The Windows spooler ACCEPTS a RAW job even when the printer is unplugged —
   * it just queues it — so a successful sendRaw() proves nothing. Without this
   * check the bridge reports "printed + encoded" (and durably logs it) for
   * labels that never existed, and Nexus marks the cartons printed.
   *
   *   usb -> the queue must exist and not be Offline / paused / WorkOffline.
   *   tcp -> a quick socket connect to <host>:9100 must succeed.
   *
   * Cached for a few seconds so the per-print guard doesn't add a PowerShell
   * round-trip to every label in a run.
   */
  async checkReady() {
    const cache = this._readyCache;
    if (cache && Date.now() - cache.at < 5000) return cache.result;
    const result = await this._probeReady();
    this._readyCache = { at: Date.now(), result };
    return result;
  }

  async _probeReady() {
    if (this.config.transport === 'tcp') {
      const { host, port } = this.config;
      try {
        await new Promise((resolve, reject) => {
          const socket = net.connect({ host, port });
          socket.setTimeout(3000, () => socket.destroy(new Error('timed out')));
          socket.on('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.on('error', reject);
        });
        return { ready: true, detail: `tcp ${host}:${port} reachable` };
      } catch (err) {
        return { ready: false, detail: `printer at ${host}:${port} unreachable (${err.message})` };
      }
    }
    // usb: `Get-Printer` is NOT trustworthy here — with the CP30 unplugged it
    // still reports PrinterStatus Normal / WorkOffline blank (verified
    // 2026-07-15). Two signals that DO tell the truth:
    //   1. WMI Win32_Printer.WorkOffline flips True when the device is absent.
    //   2. Jobs that never drain: anything sitting in the queue older than a
    //      few seconds means nothing is consuming it.
    // DetectedErrorState catches paper-out/jam-style errors as a bonus.
    const name = this.config.printerName.replace(/'/g, "''").replace(/"/g, '`"');
    const script =
      `$p = Get-CimInstance Win32_Printer -Filter "Name='${name}'"; ` +
      `if (-not $p) { Write-Output 'MISSING' } else { ` +
      `$jobs = @(Get-PrintJob -PrinterName '${name}' -ErrorAction SilentlyContinue); ` +
      `$stuck = @($jobs | Where-Object { $_.SubmittedTime -lt (Get-Date).AddSeconds(-15) }).Count; ` +
      `Write-Output "$($p.WorkOffline)|$($p.DetectedErrorState)|$($jobs.Count)|$stuck" }`;
    return new Promise((resolve) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 10000 },
        (err, stdout) => {
          const out = (stdout || '').trim();
          if (err || out === 'MISSING') {
            return resolve({ ready: false, detail: `print queue "${this.config.printerName}" not found` });
          }
          const [workOffline = '', errorState = '0', jobCount = '0', stuck = '0'] = out.split('|');
          if (/true/i.test(workOffline)) {
            return resolve({
              ready: false,
              detail: `queue "${this.config.printerName}" reports the printer offline — is it plugged in and on?`,
            });
          }
          if (Number(errorState) >= 3) {
            // CIM enum: 0 Unknown / 1 Other / 2 No Error are fine; 3+ are real
            // faults (3 low paper, 4 no paper, 7 door open, 8 jammed, 9 offline…)
            return resolve({ ready: false, detail: `printer error state ${errorState} (jam / paper out / offline?)` });
          }
          if (Number(stuck) > 0) {
            return resolve({
              ready: false,
              detail: `${jobCount} job(s) stuck in queue "${this.config.printerName}" — printer not consuming (clear the queue after reconnecting)`,
            });
          }
          resolve({ ready: true, detail: `queue "${this.config.printerName}" ready (${jobCount} job(s) in queue)` });
        }
      );
    });
  }

  /** Send a ZPL string over the configured transport. */
  async send(zplText) {
    if (this.config.transport === 'tcp') {
      await sendTcp(this.config.host, this.config.port, zplText);
      return { transport: 'tcp', target: `${this.config.host}:${this.config.port}` };
    }
    const { jobId, bytes } = require('./winspool').sendRaw(this.config.printerName, zplText);
    return { transport: 'usb', target: this.config.printerName, jobId, bytes };
  }

  /** Build the label ZPL without sending (does not consume the EPC counter). */
  preview({ epc, title, copies } = {}) {
    const hex = epc ? zpl.validateEpcHex(epc) : zpl.testEpc(this.config.epcPrefix, this.counter + 1);
    return { epc: hex, zpl: this._buildLabel(hex, title, copies) };
  }

  _buildLabel(epcHex, title, copies) {
    return zpl.buildLabel({
      epc: epcHex,
      title,
      copies,
      barcode: this.config.barcode,
      widthDots: this.config.widthDots,
      heightDots: this.config.heightDots,
      topOffsetDots: this.config.topOffsetDots,
      leftOffsetDots: this.config.leftOffsetDots,
      extraZpl: this.config.extraZpl,
    });
  }

  /** Print one label and encode its EPC. Auto-generates the next test EPC if none
   * given. `jobId`/`boxId` are metadata recorded in the durable print log so
   * Nexus can reconcile which cartons actually printed after any interruption. */
  async printLabel({ epc, title, copies, jobId, boxId } = {}) {
    // Refuse before touching the counter or the durable log: a queued-but-not-
    // printed label must never be recorded as printed.
    const readiness = await this.checkReady().catch((e) => ({ ready: false, detail: e.message }));
    if (!readiness.ready) throw new Error(`Printer not ready — ${readiness.detail}`);
    let usedCounter = null;
    let epcHex;
    if (epc) {
      epcHex = zpl.validateEpcHex(epc);
    } else {
      usedCounter = this.counter + 1;
      epcHex = zpl.testEpc(this.config.epcPrefix, usedCounter);
    }
    const text = this._buildLabel(epcHex, title, copies);
    const res = await this.send(text);
    if (usedCounter != null) this.counter = usedCounter;
    const at = new Date().toISOString();
    this.lastPrint = { epc: epcHex, at, transport: res.transport, target: res.target };
    this._save();
    // Durable record of the physical print — written by the process that did it,
    // so it survives a browser/PC crash the response never reached.
    this._appendLog({ epc: epcHex, jobId: jobId || null, boxId: boxId || null, at });
    this.log(`printed + encoded EPC ${epcHex} via ${res.transport} -> ${res.target}${res.jobId ? ` (job ${res.jobId})` : ''}`);
    return { epc: epcHex, zpl: text, ...res, nextEpc: zpl.testEpc(this.config.epcPrefix, this.counter + 1) };
  }

  /**
   * Print a run of N labels (sequential auto EPCs) as one job. Convenience for
   * printing a run in a single call.
   * NOTE: this does NOT reduce the wasted-blank overhead. Tested 2026-07-09: the
   * CP30 still sacrifices adjacent tags per encode even within one continuous
   * stream, because at this label's short pitch the antenna can't isolate a
   * single chip (minimum-transponder-pitch limit). The only real fix is
   * longer-pitch RFID media.
   */
  async printBatch({ count = 2, title } = {}) {
    const readiness = await this.checkReady().catch((e) => ({ ready: false, detail: e.message }));
    if (!readiness.ready) throw new Error(`Printer not ready — ${readiness.detail}`);
    const n = Math.max(1, Math.min(50, Number(count) || 1));
    const epcs = [];
    const parts = [];
    for (let i = 1; i <= n; i++) {
      const epcHex = zpl.testEpc(this.config.epcPrefix, this.counter + i);
      epcs.push(epcHex);
      parts.push(this._buildLabel(epcHex, title, 1));
    }
    const text = parts.join('');
    const res = await this.send(text);
    this.counter += n;
    this.lastPrint = { epc: epcs[epcs.length - 1], at: new Date().toISOString(), transport: res.transport, target: res.target };
    this._save();
    this.log(`printed + encoded batch of ${n}: ${epcs[0]}..${epcs[n - 1]} via ${res.transport} -> ${res.target}`);
    return { count: n, epcs, ...res, nextEpc: zpl.testEpc(this.config.epcPrefix, this.counter + 1) };
  }

  /** Send arbitrary ZPL verbatim (tuning/experiments, e.g. ^RS write power). */
  async sendRaw(zplText) {
    const res = await this.send(zplText);
    this.log(`raw ZPL sent (${zplText.length} chars) via ${res.transport} -> ${res.target}`);
    return res;
  }

  /** List Windows print queue names (for the dashboard's USB queue picker). */
  listQueues() {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'],
        { timeout: 10000 },
        (err, stdout) => {
          if (err) return reject(new Error(`queue listing failed: ${err.message}`));
          resolve(
            stdout
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean)
          );
        }
      );
    });
  }
}

module.exports = { PrinterManager };
