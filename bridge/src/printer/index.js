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

  setConfig(partial = {}) {
    for (const k of CONFIG_KEYS) {
      if (partial[k] === undefined) continue;
      if (k === 'port') this.config.port = Number(partial.port) || 9100;
      else if (k === 'barcode') this.config.barcode = Boolean(partial.barcode);
      else if (k === 'widthDots' || k === 'heightDots')
        this.config[k] = partial[k] == null || partial[k] === '' ? null : Number(partial[k]);
      else if (k === 'topOffsetDots' || k === 'leftOffsetDots')
        this.config[k] = Math.max(0, Number(partial[k]) || 0);
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

  /** Print one label and encode its EPC. Auto-generates the next test EPC if none given. */
  async printLabel({ epc, title, copies } = {}) {
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
    this.lastPrint = { epc: epcHex, at: new Date().toISOString(), transport: res.transport, target: res.target };
    this._save();
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
