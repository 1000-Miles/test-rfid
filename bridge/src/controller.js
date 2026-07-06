'use strict';

/**
 * Reader controller: owns ALL access to the DLL and runs a single serialized
 * control loop so koffi calls never overlap and we never issue other commands
 * while an inventory is running (the reader ignores them mid-inventory — doc 1503).
 *
 * States:
 *   IDLE    (connected, not reading) -> poll GPI every gpiIntervalMs, push status.
 *                                       In IR mode, a GPI1 clear->broken edge
 *                                       starts a timed inventory burst.
 *   READING (manual or IR burst)     -> drain tags fast, push each over events.
 *
 * Emits 'message' events (plain objects) that the server relays to WS clients:
 *   { type:'tag', epc, antenna, rssi, tid, timestamp }
 *   { type:'gpi', gpi1, gpi2, raw, timestamp }
 *   { type:'trigger', input, timestamp }
 *   { type:'status', ...getStatus() }
 *   { type:'log', level, text, timestamp }
 */

const EventEmitter = require('events');
const uhf = require('./uhf');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Controller extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.connected = false;
    this.reading = false;
    this.readingUntil = null; // timestamp for IR burst end; null = indefinite (manual)
    this.mode = 'manual'; // 'manual' | 'ir'
    this.irDurationMs = opts.irDurationMs ?? 500;
    this.irMinGapMs = opts.irMinGapMs ?? 200;
    this.irTriggerInput = 1; // GPI1
    this.gpiIntervalMs = opts.gpiIntervalMs ?? 300;

    this.lastGpi1 = false;
    this.lastTriggerAt = 0;
    this.lastGpi = { gpi1: null, gpi2: null, raw: '' };

    this._running = false;
    this._lock = Promise.resolve(); // serializes DLL access
    this._timer = null;
  }

  // --- logging ---------------------------------------------------------------
  log(text, level = 'info') {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] ${text}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    this.emit('message', { type: 'log', level, text, timestamp: ts });
  }

  // --- DLL access serialization ----------------------------------------------
  /** Run fn with exclusive access to the DLL. Returns fn's result. */
  _withLock(fn) {
    const run = this._lock.then(() => fn());
    // keep the chain alive even if fn throws
    this._lock = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  // --- lifecycle -------------------------------------------------------------
  start() {
    if (this._running) return;
    this._running = true;
    try {
      uhf.load();
      uhf.setLogLevel(0);
    } catch (err) {
      this.log(`DLL load failed: ${err.message}`, 'error');
      throw err;
    }
    this._tick();
    this.log('Controller started.');
  }

  async stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    if (this.reading) await this.stopReading().catch(() => {});
    if (this.connected) await this.disconnect().catch(() => {});
  }

  async connect(ip, port) {
    if (this.reading) await this.stopReading();
    const rc = await this._withLock(() => uhf.connect(ip, Number(port)));
    this.connected = rc === 0;
    this.log(`TCPConnect(${ip}, ${port}) -> ${rc} (${rc === 0 ? 'OK' : 'FAIL'})`);
    if (this.connected) {
      // Reset the reader to a known-good state for command-mode reading. After
      // IR/work-mode experiments (some of which persist to flash) or an
      // ungraceful shutdown, the reader can be left mid-inventory or in a
      // non-command work mode, which stops tags flowing over TCP.
      await this._withLock(() => {
        try {
          const stopRc = uhf.stopInventory(); // clear any leftover inventory
          const wmBefore = uhf.getWorkMode();
          const wmRc = uhf.setWorkMode(0); // force command mode
          const ver = uhf.getSoftwareVersion();
          const pwr = uhf.getPower();
          this.log(
            `Reader reset: stopGet=${stopRc}, workMode ${wmBefore}->0 (rc=${wmRc}), version=${ver}, power=${pwr}dBm`
          );
          if (pwr != null && pwr < 5) {
            this.log(`WARNING: read power is very low (${pwr}dBm) — tags may not be detected.`, 'warn');
          }
        } catch (e) {
          this.log(`reset warning: ${e.message}`, 'warn');
        }
      });
    }
    this._emitStatus();
    return rc;
  }

  async disconnect() {
    if (this.reading) await this.stopReading();
    await this._withLock(() => uhf.disconnect());
    this.connected = false;
    this.log('Disconnected.');
    this._emitStatus();
  }

  async startReading(durationMs = null) {
    if (!this.connected) throw new Error('not connected');
    if (this.reading) return 0;
    const rc = await this._withLock(() => uhf.startInventory());
    if (rc === 0) {
      this.reading = true;
      this.readingUntil = durationMs ? Date.now() + durationMs : null;
      this._firstTagLogged = false;
      this._readStartAt = Date.now();
      this._lastActivityLog = 0;
      this.log(`Inventory started${durationMs ? ` (burst ${durationMs}ms)` : ' (manual)'}.`);
    } else {
      this.log(`UHFInventory() -> ${rc} (FAIL)`, 'warn');
    }
    this._emitStatus();
    return rc;
  }

  async stopReading() {
    if (!this.reading) return 0;
    const rc = await this._withLock(() => uhf.stopInventory());
    this.reading = false;
    this.readingUntil = null;
    this.log(`Inventory stopped -> ${rc}.`);
    this._emitStatus();
    return rc;
  }

  setMode(cfg = {}) {
    if (cfg.mode === 'manual' || cfg.mode === 'ir') this.mode = cfg.mode;
    if (Number.isFinite(cfg.irDurationMs)) this.irDurationMs = cfg.irDurationMs;
    if (Number.isFinite(cfg.irMinGapMs)) this.irMinGapMs = cfg.irMinGapMs;
    this.log(`Mode = ${this.mode} (burst ${this.irDurationMs}ms, gap ${this.irMinGapMs}ms).`);
    // Leaving IR mode while in an IR burst? let the burst finish naturally.
    this._emitStatus();
    return this.getStatus();
  }

  getStatus() {
    return {
      connected: this.connected,
      reading: this.reading,
      mode: this.mode,
      irDurationMs: this.irDurationMs,
      irMinGapMs: this.irMinGapMs,
      gpi: this.lastGpi,
    };
  }

  _emitStatus() {
    this.emit('message', { type: 'status', ...this.getStatus(), timestamp: new Date().toISOString() });
  }

  // --- the control loop ------------------------------------------------------
  async _tick() {
    if (!this._running) return;
    let delay = this.gpiIntervalMs;
    try {
      if (this.connected) {
        if (this.reading) {
          const got = await this._withLock(() => this._drainTags());
          if (this.readingUntil && Date.now() >= this.readingUntil) {
            await this.stopReading();
          }
          delay = got > 0 ? 0 : 10; // keep draining while tags flow
        } else {
          await this._withLock(() => this._pollGpiOnce());
          delay = this.gpiIntervalMs;
        }
      } else {
        delay = 250;
      }
    } catch (err) {
      this.log(`loop error: ${err.message}`, 'error');
      delay = 250;
    }
    this._timer = setTimeout(() => this._tick(), delay);
  }

  /** Drain a batch of tag records. Returns count read this pass. */
  _drainTags() {
    let n = 0;
    let tag;
    while (n < 100 && (tag = uhf.pollTag())) {
      n++;
      if (!tag.epc) continue; // skip malformed frames
      this._totalReads = (this._totalReads || 0) + 1;
      if (!this._firstTagLogged) {
        this._firstTagLogged = true;
        this.log(`First tag: epc=${tag.epc} ant=${tag.antenna} rssi=${tag.rssi}dBm`);
      }
      const msg = {
        type: 'tag',
        epc: tag.epc,
        antenna: tag.antenna,
        rssi: tag.rssi,
        tid: tag.tid,
        timestamp: new Date().toISOString(),
      };
      this.emit('message', msg);
    }

    // Heartbeat while reading, so the terminal shows whether tags are flowing.
    const now = Date.now();
    if (now - (this._lastActivityLog || 0) >= 2000) {
      this._lastActivityLog = now;
      if (this._firstTagLogged) {
        this.log(`reading... ${this._totalReads} total reads`);
      } else if (now - (this._readStartAt || now) >= 2000) {
        this.log('reading, but NO tags received yet — check tag in range / power / antenna.', 'warn');
      }
    }
    return n;
  }

  /** Read GPI once, broadcast, and (in IR mode) detect the trigger edge. */
  _pollGpiOnce() {
    const gpi = uhf.getGpi();
    this.lastGpi = { gpi1: gpi.gpi1, gpi2: gpi.gpi2, raw: gpi.raw };
    this.emit('message', {
      type: 'gpi',
      gpi1: gpi.gpi1,
      gpi2: gpi.gpi2,
      raw: gpi.raw,
      timestamp: new Date().toISOString(),
    });

    // Edge detect: clear (false) -> broken (true) on GPI1.
    const broken = gpi.gpi1 === true;
    const edge = broken && !this.lastGpi1;
    this.lastGpi1 = broken;

    if (edge && this.mode === 'ir') {
      const now = Date.now();
      if (now - this.lastTriggerAt >= this.irMinGapMs) {
        this.lastTriggerAt = now;
        this.log('IR TRIGGER: GPI1 beam broken -> starting burst.');
        this.emit('message', { type: 'trigger', input: 1, timestamp: new Date().toISOString() });
        // start burst (schedule outside lock via microtask; loop will pick up READING)
        this.startReading(this.irDurationMs).catch((e) => this.log(e.message, 'error'));
      }
    }
  }
}

module.exports = { Controller };
