'use strict';

/**
 * Printer manager for the Chainway CP30: builds ZPL and sends it over the
 * configured transport.
 *
 *   usb -> the OS print queue named in config.printerName:
 *            Windows: RAW datatype via winspool ("Generic / Text Only" driver)
 *            Linux:   CUPS `lp -o raw` (raw queue, no filter)
 *   tcp -> raw socket to <host>:9100 (printer on Ethernet/Wi-Fi).
 *
 * Config + the test-EPC counter persist to bridge/data/printer.json so EPCs
 * stay unique across restarts.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile, spawn } = require('child_process');
const zpl = require('./zpl');
const tspl = require('./tspl');

const IS_WINDOWS = process.platform === 'win32';

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
  // Closed-loop print verification (TCP transport only — USB RAW is one-way and
  // can't hear the printer back). When on, each label is checked against the
  // printer's ~HQES error status before it's recorded as printed.
  verify: true,
  // How many times the BRIDGE reprints a carton (same EPC) when the printer
  // reports a recoverable fault (e.g. a void encode) before it gives up and
  // halts the run. Layered on top of the printer's own internal retries.
  reprintRetries: 1,
  // When on, each print waits until the label has PHYSICALLY finished (the
  // printer's receive buffer drains, via ~HS) before returning — so a caller's
  // progress reflects labels actually out, not just accepted. TCP + verify only.
  trackPhysical: true,
  // Pallet-tag printer — a SEPARATE device from the CP30. Barcode-only pallet
  // tags print on the Gprinter (TSPL, 203 dpi) through its own OS print queue;
  // carton labels keep going to the main printer above. Sizes are mm because
  // TSPL SIZE takes mm and the tag design scales to any media. leftOffsetMm is
  // per-unit head↔media alignment (the current test unit needs 5).
  palletPrinterName: process.env.PALLET_PRINTER_NAME || 'Gprinter Test',
  palletWidthMm: Number(process.env.PALLET_WIDTH_MM || 75),
  palletHeightMm: Number(process.env.PALLET_HEIGHT_MM || 130),
  palletLeftOffsetMm: Number(process.env.PALLET_LEFT_OFFSET_MM || 0),
  // Printhead density of the pallet printer. MUST match the hardware: TSPL
  // element coordinates are dots, so a wrong value prints the design at the
  // wrong scale with no error anywhere. 203 for the Gprinter test unit and most
  // TSC desktops; 300 for the 300 dpi models. Confirm per unit by running
  // SELFTEST on the printer and reading the dpi off its config label.
  palletDpi: Number(process.env.PALLET_DPI || 203),
};

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

// Per-print layout overrides (same sanitisation as setConfig). Only fields the
// caller actually sent override the stored config for that one label — a client
// that sends none behaves exactly as before, so old Nexus builds are unaffected.
function sanitizeLayout(body = {}) {
  const out = {};
  for (const k of ['widthDots', 'heightDots']) {
    if (body[k] !== undefined) out[k] = body[k] == null || body[k] === '' ? null : Number(body[k]);
  }
  for (const k of ['topOffsetDots', 'leftOffsetDots']) {
    if (body[k] !== undefined) out[k] = Math.round(Number(body[k]) || 0);
  }
  return out;
}

// Linux 'usb' transport: pipe raw ZPL into a CUPS queue (`lp -o raw`), the
// moral equivalent of the Windows RAW-datatype spool job. The queue is usually
// auto-created by CUPS/usblp when the CP30 is plugged in; `-o raw` bypasses any
// filter so the printer gets our ZPL bytes untouched.
function sendRawCups(printerName, data) {
  return new Promise((resolve, reject) => {
    const child = spawn('lp', ['-d', printerName, '-o', 'raw', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`lp spawn failed: ${e.message} (is CUPS installed?)`)));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`lp exited ${code}: ${(err || out).trim()}`));
      // "request id is CP30-42 (1 file(s))" — job id when CUPS prints one
      const m = /request id is (\S+)/.exec(out + err);
      resolve({ jobId: m ? m[1] : null, bytes: Buffer.byteLength(data) });
    });
    child.stdin.end(data);
  });
}

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

// Send bytes over TCP and READ whatever the printer sends back (unlike sendTcp,
// which is fire-and-forget). Used for the closed-loop verify: we push the label
// + a ~HQES status query in one connection, then wait for the printer's status
// reply. Resolves as soon as `until` matches (the reply arrived) or after
// `quietMs` of silence following the last byte, whichever comes first; hard-caps
// at `timeoutMs`. Returns '' if the printer says nothing at all (older/clone
// firmware that ignores host queries) — callers treat '' as "no confirmation
// available" (degraded mode), never as a failure.
function sendTcpAndRead(host, port, data, { timeoutMs = 8000, quietMs = 1200, until = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let out = '';
    let quiet = null;
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (quiet) clearTimeout(quiet);
      socket.destroy();
      if (err) reject(err);
      else resolve(out);
    };
    const armQuiet = () => {
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => finish(), quietMs);
    };
    // Overall cap: if the printer never replies, resolve empty (not an error) so
    // a silent printer degrades gracefully instead of blocking the run.
    socket.setTimeout(timeoutMs, () => finish());
    socket.on('connect', () => {
      socket.write(data);
      armQuiet();
    });
    socket.on('data', (chunk) => {
      out += chunk.toString('latin1');
      if (until && until.test(out)) return finish();
      armQuiet();
    });
    socket.on('error', (e) => finish(e));
    socket.on('close', () => finish());
  });
}

// Parse a ZPL ~HQES ("Host Query — Error Status") reply into a human fault
// reason, or null if the printer is healthy / didn't answer. ~HQES returns two
// hex flag groups on an ERRORS line; we decode the common physical faults. NOTE:
// exact bit positions vary a little by model — verify against the real CP30 once
// it's on the LAN and adjust the map if needed. A blank/unrecognized reply → null
// (no confirmation, not a failure — the degraded path).
function parseHqesFault(text) {
  if (!text) return null;
  const m = /ERROR[S]?:\s*\d\s+([0-9A-Fa-f]{8})\s+([0-9A-Fa-f]{8})/.exec(text);
  if (!m) return null;
  const hi = parseInt(m[1], 16) || 0; // second-group flags (RFID etc. on some models)
  const lo = parseInt(m[2], 16) || 0; // first-group flags (media/head/paused…)
  if (!hi && !lo) return null; // no errors set → healthy
  const reasons = [];
  if (lo & 0x00000001) reasons.push('media/paper out');
  if (lo & 0x00000002) reasons.push('ribbon out');
  if (lo & 0x00000004) reasons.push('printhead open');
  if (lo & 0x00000008) reasons.push('cutter fault');
  if (lo & 0x00000010) reasons.push('printhead over temperature');
  if (hi) reasons.push(`rfid/other error (0x${m[1]})`);
  if (!reasons.length) reasons.push(`printer error (0x${m[2]})`);
  return { reason: reasons.join(', '), hardware: /out|open|jam|cutter/i.test(reasons.join(' ')) };
}

// Parse a ~HS ("Host Status") string-1 reply. Field 5 (0-based index 4) is the
// number of label formats still in the receive buffer — i.e. sent-but-not-yet-
// finished-printing. 0 means the printer has drained everything we gave it.
// Field 4 (index 3) is the printer's OWN calibrated label length in dots.
// Format: <STX>aaa,b,c,dddd,eee,...  → we read dddd and eee. Null if unparseable.
function parseHsBuffer(text) {
  if (!text) return null;
  const first = text.replace(/[\x02\x03]/g, '').split(/\r?\n/)[0] || '';
  const f = first.split(',');
  if (f.length < 5) return null;
  return {
    paperOut: f[1] === '1',
    paused: f[2] === '1',
    labelLengthDots: Number(f[3]) > 0 ? Number(f[3]) : null, // dddd — calibrated length
    formatsInBuffer: Number(f[4]) || 0, // eee — 0 = buffer drained
  };
}

// Poll ~HS until the printer's receive buffer is empty — i.e. every label format
// we sent has finished printing — so the caller only returns once the label is
// PHYSICALLY out, not merely accepted. Best-effort and bounded: if the printer
// stops answering or we hit the timeout, we stop waiting (never hang a print).
async function waitBufferDrained(host, port, { timeoutMs = 15000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // Small initial delay so a just-sent format has registered in the buffer before
  // the first read (otherwise a fast reply could read 0 prematurely).
  await new Promise((r) => setTimeout(r, 150));
  while (Date.now() < deadline) {
    let reply = '';
    try {
      reply = await sendTcpAndRead(host, port, '~HS\r\n', { timeoutMs: 3000, quietMs: 350 });
    } catch {
      return; // printer stopped answering — don't block the run
    }
    const hs = parseHsBuffer(reply);
    if (!hs) return; // unparseable → can't track; give up gracefully
    if (hs.formatsInBuffer === 0 && !hs.paused) return; // drained = physically done
    await new Promise((r) => setTimeout(r, pollMs));
  }
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

  /** Recent pallet tags that PHYSICALLY printed, newest first — the reprint
   *  picker's source. Collapsed to one row per pallet code (a pallet reprinted
   *  three times is still one pallet), carrying that pallet's newest batchRef so
   *  a reprint reproduces the label the operator actually held. Read straight
   *  off the durable log, so it survives a bridge restart. */
  recentPalletPrints({ limit = 12 } = {}) {
    const byCode = new Map();
    for (const e of this.readPrintLog()) {
      if (e.kind !== 'pallet' || !e.palletCode) continue;
      const prior = byCode.get(e.palletCode);
      // Re-inserting keeps a Map key in its ORIGINAL slot, so delete first —
      // otherwise a reprinted pallet keeps the position of its first print and
      // never rises to the top of the list.
      byCode.delete(e.palletCode);
      // The log is append-ordered, so a later line is always the newer print.
      byCode.set(e.palletCode, {
        palletCode: e.palletCode,
        batchRef: e.batchRef ?? prior?.batchRef ?? null,
        at: e.at ?? prior?.at ?? null,
        prints: (prior?.prints ?? 0) + 1,
      });
    }
    return [...byCode.values()].reverse().slice(0, Math.max(1, Number(limit) || 12));
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
      else if (k === 'verify') this.config.verify = Boolean(partial.verify);
      else if (k === 'trackPhysical') this.config.trackPhysical = Boolean(partial.trackPhysical);
      else if (k === 'reprintRetries')
        this.config.reprintRetries = Math.max(0, Math.min(5, Math.round(Number(partial.reprintRetries) || 0)));
      else if (k === 'palletWidthMm' || k === 'palletHeightMm')
        this.config[k] = Number(partial[k]) > 0 ? Number(partial[k]) : DEFAULT_CONFIG[k];
      else if (k === 'palletLeftOffsetMm') this.config[k] = Math.max(0, Number(partial[k]) || 0);
      // Whitelisted rather than free-numeric: a typo'd density silently
      // rescales every tag, and these are the only heads that exist on TSPL
      // hardware we'd use.
      else if (k === 'palletDpi') this.config.palletDpi = [203, 300, 600].includes(Number(partial[k])) ? Number(partial[k]) : DEFAULT_CONFIG.palletDpi;
      else this.config[k] = String(partial[k]);
    }
    if (this.config.transport !== 'tcp') this.config.transport = 'usb';
    // A config change may point us at a different/fixed printer — re-probe whether
    // it answers status queries instead of staying latched in degraded mode.
    this._statusMute = false;
    this._readyCache = null;
    this._palletReadyCache = null;
    this._save();
    this.log(`config updated: ${JSON.stringify(this.config)}`);
    return this.config;
  }

  getStatus() {
    return {
      config: this.config,
      nextEpc: zpl.testEpc(this.config.epcPrefix, this.counter + 1),
      lastPrint: this.lastPrint,
      // Capability flag: this bridge accepts per-print layout overrides on
      // /printer/print. Lets clients fall back to pushing /printer/config
      // before a run when talking to an older bridge that lacks this.
      layoutPerPrint: true,
      // Capability flag: /printer/print-pallet-tag prints TSPL to the dedicated
      // pallet-tag printer (mm sizes) — same contract as the Gprinter test bridge.
      palletTag: true,
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

  /** Same trust model as checkReady(), but for the pallet-tag printer's queue.
   * Always a spooler/CUPS queue — the Gprinter has no TCP transport here. */
  async checkPalletReady() {
    const cache = this._palletReadyCache;
    if (cache && Date.now() - cache.at < 5000) return cache.result;
    const name = this.config.palletPrinterName;
    const result = !name
      ? { ready: false, detail: 'no pallet printer configured (palletPrinterName)' }
      : IS_WINDOWS
        ? await this._probeQueueWindows(name)
        : await this._probeReadyCups(name);
    this._palletReadyCache = { at: Date.now(), result };
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
    if (!IS_WINDOWS) return this._probeReadyCups(this.config.printerName);
    return this._probeQueueWindows(this.config.printerName);
  }

  /** Windows spooler-queue readiness, by queue name (main CP30 queue or the
   *  pallet-tag queue — the trust model is identical for both). */
  _probeQueueWindows(queueName) {
    // `Get-Printer` is NOT trustworthy here — with the CP30 unplugged it
    // still reports PrinterStatus Normal / WorkOffline blank (verified
    // 2026-07-15). Two signals that DO tell the truth:
    //   1. WMI Win32_Printer.WorkOffline flips True when the device is absent.
    //   2. Jobs that never drain: anything sitting in the queue older than a
    //      few seconds means nothing is consuming it.
    // DetectedErrorState catches paper-out/jam-style errors as a bonus.
    const name = queueName.replace(/'/g, "''").replace(/"/g, '`"');
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
            return resolve({ ready: false, detail: `print queue "${queueName}" not found` });
          }
          const [workOffline = '', errorState = '0', jobCount = '0', stuck = '0'] = out.split('|');
          if (/true/i.test(workOffline)) {
            return resolve({
              ready: false,
              detail: `queue "${queueName}" reports the printer offline — is it plugged in and on?`,
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
              detail: `${jobCount} job(s) stuck in queue "${queueName}" — printer not consuming (clear the queue after reconnecting)`,
            });
          }
          resolve({ ready: true, detail: `queue "${queueName}" ready (${jobCount} job(s) in queue)` });
        }
      );
    });
  }

  /**
   * Linux/CUPS readiness. Same trust model as the Windows path: CUPS ACCEPTS
   * jobs with the printer unplugged, so "queue exists" proves nothing — we
   * check the queue is enabled and that jobs are actually draining.
   */
  _probeReadyCups(name) {
    return new Promise((resolve) => {
      execFile('lpstat', ['-p', name], { timeout: 10000 }, (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`;
        if (err || /unable to locate|invalid destination/i.test(out)) {
          return resolve({ ready: false, detail: `CUPS queue "${name}" not found (lpstat -p)` });
        }
        if (/disabled/i.test(out)) {
          return resolve({ ready: false, detail: `CUPS queue "${name}" is disabled — cupsenable it after reconnecting the printer` });
        }
        // Queue enabled — now the draining check. A job in the queue is normal
        // for a moment mid-run; one still there ~15s later means nothing is
        // consuming it (USB unplugged leaves jobs stuck in "processing"). Same
        // threshold as the Windows path, tracked by job id across probes since
        // lpstat's submit-time format is locale-dependent.
        execFile('lpstat', ['-o', name], { timeout: 10000 }, (err2, stdout2) => {
          const now = Date.now();
          const ids = err2
            ? []
            : (stdout2 || '')
                .split(/\r?\n/)
                .map((l) => l.split(/\s+/)[0])
                .filter(Boolean);
          // Tracked per queue: probing the pallet queue must not reset the
          // main queue's stuck-job clocks (and vice versa).
          this._cupsJobsSeenByQueue = this._cupsJobsSeenByQueue || {};
          const seen = this._cupsJobsSeenByQueue[name] || {};
          const next = {};
          let stuck = 0;
          for (const id of ids) {
            next[id] = seen[id] || now;
            if (now - next[id] >= 15000) stuck++;
          }
          this._cupsJobsSeenByQueue[name] = next;
          if (stuck > 0) {
            return resolve({
              ready: false,
              detail: `${stuck} job(s) stuck in CUPS queue "${name}" — printer not consuming (cancel -a '${name}' after reconnecting)`,
            });
          }
          resolve({ ready: true, detail: `CUPS queue "${name}" ready (${ids.length} job(s) in queue)` });
        });
      });
    });
  }

  /**
   * Print one label over TCP and confirm the outcome with the printer before
   * returning. The whole point of the error-management work: a spooler/socket
   * "accept" is NOT proof the label printed or the chip encoded — so here we ask
   * the printer (~HQES) and act on the truth.
   *
   *   healthy / silent  → success (silent = older firmware that ignores queries;
   *                        we degrade to "assume printed" so a mute printer never
   *                        blocks the line — matches the agreed fallback).
   *   recoverable fault  → reprint the SAME EPC up to config.reprintRetries, then
   *                        halt if it still fails (e.g. a stubborn bad tag).
   *   hardware fault     → halt immediately (paper out / head open / jam): a
   *                        reprint can't fix it; the operator must, then Resume.
   *
   * Throws on any unresolved fault so the caller never logs the carton as printed.
   */
  async _printAndVerify(zplText) {
    const { host, port } = this.config;
    const target = `${host}:${port}`;
    const maxAttempts = 1 + (Number.isFinite(this.config.reprintRetries) ? this.config.reprintRetries : 1);
    // Skip the status query on printers we've already learned are mute — pay the
    // timeout once, not on every label (keeps throughput up in degraded mode).
    let lastReason = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Push the label and a status query in one connection; wait for the
      // "PRINTER STATUS" reply (or fall through on a mute printer).
      const probe = this._statusMute ? '' : '\n~HQES\n';
      const reply = await sendTcpAndRead(host, port, zplText + probe, {
        timeoutMs: 12000,
        quietMs: 1500,
        until: /PRINTER STATUS/i,
      }).catch((e) => {
        // A real socket failure (printer unreachable) is a hard fault — do not
        // pretend it printed.
        throw new Error(`print to ${target} failed: ${e.message}`);
      });

      if (!this._statusMute && !/PRINTER STATUS/i.test(reply)) {
        // First time we see no status reply: this printer ignores host queries.
        // Latch degraded mode so later labels don't each wait the full timeout.
        this._statusMute = true;
        this.log(`verify: printer at ${target} did not answer ~HQES — degrading to no-confirm (spooler/auto-void only)`);
      }

      const fault = this._statusMute ? null : parseHqesFault(reply);
      if (!fault) {
        // No fault → optionally wait until the label PHYSICALLY prints (buffer
        // drains) so the caller's progress tracks real output, not just accept.
        if (!this._statusMute && this.config.trackPhysical) {
          await waitBufferDrained(host, port).catch(() => {});
        }
        return { transport: 'tcp', target, confirmed: !this._statusMute };
      }

      lastReason = fault.reason;
      if (fault.hardware) throw new Error(`Printer fault — ${fault.reason}`);
      // Recoverable (e.g. RFID void): loop to reprint, unless we're out of tries.
      this.log(
        `verify: fault "${fault.reason}" on attempt ${attempt}/${maxAttempts} — ${attempt < maxAttempts ? 'reprinting same EPC' : 'giving up'}`,
      );
    }
    throw new Error(`Encode not confirmed after ${maxAttempts} attempt(s) — ${lastReason}`);
  }

  /**
   * The printer's OWN calibrated label length, in dots (~HS field 4).
   *
   * Label geometry has to be computed against SOME canvas, and when width/height
   * are unset the code fell back to an assumed media size. Assume wrong and the
   * layout is laid out on a canvas that is not the paper — a canvas shorter than
   * the label leaves a blank band along the bottom, a longer one runs the last
   * row off the edge. The printer already knows the real number from its own
   * label calibration, so ask it instead of guessing.
   *
   * Cached for the process (including a null result) — it changes only when the
   * media changes, which means recalibrating and restarting anyway. TCP only:
   * a USB spooler queue is write-only, so there is nobody to answer.
   */
  async labelLengthDots() {
    if (this.config.transport !== 'tcp') return null;
    if (this._labelLen !== undefined) return this._labelLen;
    try {
      const reply = await sendTcpAndRead(this.config.host, this.config.port, '~HS\r\n', {
        timeoutMs: 3000,
        quietMs: 350,
      });
      const hs = parseHsBuffer(reply);
      this._labelLen = hs?.labelLengthDots ?? null;
      if (this._labelLen) this.log(`printer reports calibrated label length ${this._labelLen} dots`);
    } catch {
      this._labelLen = null; // unreachable / no answer → fall back to the assumed size
    }
    return this._labelLen;
  }

  /** Send a ZPL string over the configured transport. */
  async send(zplText) {
    if (this.config.transport === 'tcp') {
      await sendTcp(this.config.host, this.config.port, zplText);
      return { transport: 'tcp', target: `${this.config.host}:${this.config.port}` };
    }
    // 'usb' = the OS print queue: winspool RAW job on Windows, CUPS raw on Linux.
    const { jobId, bytes } = IS_WINDOWS
      ? require('./winspool').sendRaw(this.config.printerName, zplText)
      : await sendRawCups(this.config.printerName, zplText);
    return { transport: 'usb', target: this.config.printerName, jobId, bytes };
  }

  /** Build the label ZPL without sending (does not consume the EPC counter). */
  preview({ epc, title, boxId, productName, itemNo, poRef, cartonNo, cartonTotal, copies } = {}) {
    const hex = epc ? zpl.validateEpcHex(epc) : zpl.testEpc(this.config.epcPrefix, this.counter + 1);
    return { epc: hex, zpl: this._buildLabel(hex, { title, boxId, productName, itemNo, poRef, cartonNo, cartonTotal, copies }) };
  }

  _buildLabel(epcHex, { title, boxId, productName, itemNo, poRef, cartonNo, cartonTotal, copies, layout = {} } = {}) {
    // layout = sanitized per-print overrides; anything absent falls back to the
    // stored config, so config-only callers print exactly as before. content
    // (boxId/productName/itemNo/poRef) selects the carton-label layout in
    // zpl.js; title-only callers get the legacy layout.
    const cfg = { ...this.config, ...layout };
    return zpl.buildLabel({
      epc: epcHex,
      title,
      boxId,
      productName,
      itemNo,
      poRef,
      cartonNo,
      cartonTotal,
      copies,
      barcode: cfg.barcode,
      widthDots: cfg.widthDots,
      heightDots: cfg.heightDots,
      topOffsetDots: cfg.topOffsetDots,
      leftOffsetDots: cfg.leftOffsetDots,
      extraZpl: cfg.extraZpl,
    });
  }

  /** Print one label and encode its EPC. Auto-generates the next test EPC if none
   * given. `jobId`/`boxId` are metadata recorded in the durable print log so
   * Nexus can reconcile which cartons actually printed after any interruption. */
  async printLabel({ epc, title, productName, itemNo, poRef, cartonNo, cartonTotal, copies, jobId, boxId, widthDots, heightDots, topOffsetDots, leftOffsetDots } = {}) {
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
    const layout = sanitizeLayout({ widthDots, heightDots, topOffsetDots, leftOffsetDots });
    // Nobody specified a label height — neither this print nor the stored config
    // — so use the printer's own calibrated length rather than an assumed size.
    // Best-effort: a null answer leaves the assumed size in place.
    if (layout.heightDots == null && this.config.heightDots == null) {
      const len = await this.labelLengthDots();
      if (len) layout.heightDots = len;
    }
    const text = this._buildLabel(epcHex, { title, boxId, productName, itemNo, poRef, cartonNo, cartonTotal, copies, layout });
    // TCP + verify on → closed loop: print, read the printer's status back, and
    // reprint/halt on a fault BEFORE recording anything. Any other case (USB, or
    // verify off) keeps the original one-way behaviour. A thrown error here means
    // nothing is logged as printed, so Nexus's Resume repaints exactly this carton.
    const res =
      this.config.transport === 'tcp' && this.config.verify
        ? await this._printAndVerify(text)
        : await this.send(text);
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
  async printBatch({ count = 2, title, productName, itemNo, poRef, widthDots, heightDots, topOffsetDots, leftOffsetDots } = {}) {
    const readiness = await this.checkReady().catch((e) => ({ ready: false, detail: e.message }));
    if (!readiness.ready) throw new Error(`Printer not ready — ${readiness.detail}`);
    const n = Math.max(1, Math.min(50, Number(count) || 1));
    const layout = sanitizeLayout({ widthDots, heightDots, topOffsetDots, leftOffsetDots });
    const epcs = [];
    const parts = [];
    for (let i = 1; i <= n; i++) {
      const epcHex = zpl.testEpc(this.config.epcPrefix, this.counter + i);
      epcs.push(epcHex);
      parts.push(this._buildLabel(epcHex, { title, productName, itemNo, poRef, copies: 1, layout }));
    }
    const text = parts.join('');
    const res = await this.send(text);
    this.counter += n;
    this.lastPrint = { epc: epcs[epcs.length - 1], at: new Date().toISOString(), transport: res.transport, target: res.target };
    this._save();
    this.log(`printed + encoded batch of ${n}: ${epcs[0]}..${epcs[n - 1]} via ${res.transport} -> ${res.target}`);
    return { count: n, epcs, ...res, nextEpc: zpl.testEpc(this.config.epcPrefix, this.counter + 1) };
  }

  /** Barcode-only pallet tag on the DEDICATED pallet printer (Gprinter, TSPL) —
   * never the CP30: pallet tags are plain paper with no RFID encode, and the
   * two devices hold different media. Sizes are mm; per-request overrides win
   * over the stored pallet config. Idempotent by jobId so an offline restart or
   * operator retry cannot print a second label for an already-recorded job. */
  async printPalletTag({ palletCode, palletLabel, batchRef, jobId, copies = 1, force = false, widthMm, heightMm, leftOffsetMm, dpi } = {}) {
    if (!palletCode) throw new Error('palletCode is required');
    palletCode = String(palletCode).trim();
    jobId = jobId || `pallet:${palletCode}`;
    const prior = this.readPrintLog({ jobId }).find((entry) => entry.kind === 'pallet' && entry.palletCode === palletCode);
    if (prior && !force) return { palletCode, jobId, replayed: true, at: prior.at };
    const readiness = await this.checkPalletReady().catch((e) => ({ ready: false, detail: e.message }));
    if (!readiness.ready) throw new Error(`Pallet printer not ready — ${readiness.detail}`);
    const { data, layout } = await tspl.buildPalletTag({
      palletCode,
      palletLabel,
      batchRef,
      widthMm: Number(widthMm) > 0 ? Number(widthMm) : this.config.palletWidthMm,
      heightMm: Number(heightMm) > 0 ? Number(heightMm) : this.config.palletHeightMm,
      leftOffsetMm: Number.isFinite(Number(leftOffsetMm)) ? Number(leftOffsetMm) : this.config.palletLeftOffsetMm,
      // Per-request dpi is for bench-testing a second printer without
      // repointing the bridge; the configured head is the normal path.
      dpi: Number(dpi) > 0 ? Number(dpi) : this.config.palletDpi,
      copies,
    });
    const queue = this.config.palletPrinterName;
    const res = IS_WINDOWS
      ? require('./winspool').sendRaw(queue, data, 'nexus-pallet-tag')
      : await sendRawCups(queue, data);
    const at = new Date().toISOString();
    this._appendLog({ kind: 'pallet', palletCode, batchRef: batchRef || null, jobId, at });
    this.log(`printed pallet ${palletCode} (${layout} layout, ${this.config.palletDpi} dpi) -> queue "${queue}"`);
    // res.jobId is the OS spooler's job number — kept under its own name so it
    // can never clobber the logical jobId the caller dedupes/broadcasts by.
    return { palletCode, jobId, at, transport: 'usb', target: queue, bytes: res.bytes ?? null, spoolJobId: res.jobId ?? null, replayed: false };
  }

  /**
   * Make the PALLET printer print its own configuration label (TSPL SELFTEST).
   *
   * This is the only way to learn the printhead density, which `palletDpi` must
   * match: USB RAW is one-way, so the bridge cannot ask. The printer answers on
   * paper instead — the config label lists dpi along with the sensor and media
   * settings. Deliberately NOT written to the durable print log: that log's
   * contract is "every line is a pallet tag that physically exists", and a
   * diagnostic page in it would corrupt the reconcile oracle.
   */
  async palletSelfTest() {
    const readiness = await this.checkPalletReady().catch((e) => ({ ready: false, detail: e.message }));
    if (!readiness.ready) throw new Error(`Pallet printer not ready — ${readiness.detail}`);
    const queue = this.config.palletPrinterName;
    const data = Buffer.from('SELFTEST\r\n', 'ascii');
    const res = IS_WINDOWS
      ? require('./winspool').sendRaw(queue, data, 'nexus-pallet-selftest')
      : await sendRawCups(queue, data);
    this.log(`pallet SELFTEST config label sent -> queue "${queue}"`);
    return { queue, at: new Date().toISOString(), spoolJobId: res.jobId ?? null };
  }

  /** Send arbitrary ZPL verbatim (tuning/experiments, e.g. ^RS write power). */
  async sendRaw(zplText) {
    const res = await this.send(zplText);
    this.log(`raw ZPL sent (${zplText.length} chars) via ${res.transport} -> ${res.target}`);
    return res;
  }

  /** List OS print queue names (for the dashboard's USB queue picker):
   *  Windows spooler queues, or CUPS destinations on Linux (`lpstat -e`). */
  listQueues() {
    return new Promise((resolve, reject) => {
      const [cmd, args] = IS_WINDOWS
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name']]
        : ['lpstat', ['-e']];
      execFile(cmd, args, { timeout: 10000 }, (err, stdout) => {
        if (err) return reject(new Error(`queue listing failed: ${err.message}`));
        resolve(
          stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean)
        );
      });
    });
  }
}

module.exports = { PrinterManager };
