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
const net = require('net');
const os = require('os');
const uhf = require('./driver'); // dll or sidecar, per UHF_DRIVER
const { UdpListener } = require('./udp-listener');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Controller extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.connected = false;
    this.reading = false;
    this.readingUntil = null; // timestamp for IR burst end; null = indefinite (manual)
    this.mode = 'manual'; // 'manual' | 'ir' | 'hw'
    this.irDurationMs = opts.irDurationMs ?? 500;
    this.irMinGapMs = opts.irMinGapMs ?? 200;
    this.irTriggerInput = 1; // GPI used for reader-side HW trigger mode
    // Two-beam direction: whichever beam breaks FIRST decides the passage
    // direction — GPI1 first = 'in', GPI2 first = 'out'. The passage stays
    // open (and tags inherit its direction) until the burst ends with both
    // beams clear.
    this.passage = null; // { id, direction: 'in'|'out'|null, input, startedAt }
    this._passageSeq = 0; // passage id: nexus dedups to one event per EPC per passage
    // 150ms: hardware shows beam breaks as short as ~100ms; 300ms missed fast swipes.
    this.gpiIntervalMs = opts.gpiIntervalMs ?? 150;

    // HW trigger mode (reader-side trigger, tags pushed to us over UDP)
    this.udpPort = opts.udpPort ?? 9090;
    this.destIp = opts.destIp ?? null; // null = auto-detect NIC on reader subnet
    this.resolvedDestIp = null;
    this.lastReaderIp = null;
    this.lastUdpAt = 0;
    this.udp = new UdpListener();
    this.udp.on('listening', (port) => this.log(`UDP listener bound on 0.0.0.0:${port}.`));
    this.udp.on('error', (err) => this.log(`UDP listener error: ${err.message}`, 'error'));
    this.udp.on('datagram', (d) => this._onUdpDatagram(d));

    // null = not probed yet on this link; set by _detectGpio at connect.
    // The UR4 gate has GPIO (the IR beams); desktop readers (R3/R1) do not.
    this.hasGpio = null;

    this.lastGpi1 = false;
    this.lastGpi2 = false;
    this.lastTriggerAt = 0;
    this.lastGpi = { gpi1: null, gpi2: null, raw: '' };
    this._lastGpiPollAt = 0;

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
    Promise.resolve()
      .then(() => uhf.load())
      .then(() => uhf.setLogLevel(0))
      .catch((err) => this.log(`driver load failed: ${err.message}`, 'error'));
    this._tick();
    this.log('Controller started.');
  }

  async stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    this.udp.stop();
    if (this.reading) await this.stopReading().catch(() => {});
    if (this.connected) await this.disconnect().catch(() => {});
  }

  async connect(ip, port) {
    if (this.reading) await this.stopReading();
    const rc = await this._withLock(() => uhf.connect(ip, Number(port)));
    this.connected = rc === 0;
    if (this.connected) {
      this._wantConnected = true;
      this.lastTransport = 'tcp';
    }
    this.log(`TCPConnect(${ip}, ${port}) -> ${rc} (${rc === 0 ? 'OK' : 'FAIL'})`);
    if (this.connected) {
      // Reset the reader to a known-good state for command-mode reading. After
      // IR/work-mode experiments (some of which persist to flash) or an
      // ungraceful shutdown, the reader can be left mid-inventory or in a
      // non-command work mode, which stops tags flowing over TCP.
      await this._withLock(async () => {
        try {
          const stopRc = await uhf.stopInventory(); // clear any leftover inventory
          const wmBefore = await uhf.getWorkMode();
          const wmRc = await uhf.setWorkMode(0); // force command mode
          const ver = await uhf.getSoftwareVersion();
          const pwr = await uhf.getPower();
          this.log(
            `Reader reset: stopGet=${stopRc}, workMode ${wmBefore}->0 (rc=${wmRc}), version=${ver}, power=${pwr}dBm`
          );
          if (pwr != null && pwr < 5) {
            this.log(`WARNING: read power is very low (${pwr}dBm) — tags may not be detected.`, 'warn');
          }
          const ants = await uhf.getAntennas();
          const link = await uhf.getAntennaLink();
          this.log(`Antennas enabled: [${ants ?? '?'}], physically connected: [${link ?? '?'}]`);
        } catch (e) {
          this.log(`reset warning: ${e.message}`, 'warn');
        }
      });
      this.lastReaderIp = ip;
      this.lastReaderPort = Number(port);
      this._gpiFailCount = 0;
      await this._withLock(() => this._detectGpio());
      // Connect reset forces work mode 0; if HW trigger mode is selected,
      // re-arm it now so the reader goes back to pushing tags over UDP.
      if (this.mode === 'hw') {
        await this._enterHwMode().catch((e) => this.log(`HW mode re-arm failed: ${e.message}`, 'error'));
      }
    }
    this._emitStatus();
    return rc;
  }

  async connectUsb() {
    if (this.reading) await this.stopReading();
    const rc = await this._withLock(() => uhf.connectUsb());
    this.log(`UsbOpen() -> ${rc} (${rc === 0 ? 'OK' : 'FAIL'})`);
    // UsbOpen() returns 0 with NOTHING plugged in (verified 2026-08-06), and a
    // tag operation on that phantom link segfaults the whole bridge — so rc
    // alone must never set `connected`. Require a reader to actually answer.
    if (rc === 0 && !(uhf.isReaderAlive ? await this._withLock(() => uhf.isReaderAlive()) : true)) {
      await this._withLock(() => uhf.disconnect());
      this.connected = false;
      this.log('UsbOpen() succeeded but no reader answered — treating as NOT connected.', 'error');
      this._emitStatus();
      return 2; // ERR_CONNECT_FAILURE, matching the SDK's "reader unreachable"
    }
    this.connected = rc === 0;
    if (this.connected) {
      this._wantConnected = true;
      this.lastTransport = 'usb';
      // Same known-good reset as TCP connect: clear any leftover inventory and
      // force command mode so tags flow through the poll loop.
      await this._withLock(() => {
        try {
          const stopRc = uhf.stopInventory();
          const wmBefore = uhf.getWorkMode();
          const wmRc = uhf.setWorkMode(0);
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
      this._gpiFailCount = 0;
      await this._withLock(() => this._detectGpio());
    }
    this._emitStatus();
    return rc;
  }

  async disconnect() {
    this._wantConnected = false; // intentional — stop any auto-reconnect
    if (this.reading) await this.stopReading();
    await this._withLock(() => uhf.disconnect());
    this.connected = false;
    this.log('Disconnected.');
    this._emitStatus();
  }

  async startReading(durationMs = null) {
    if (!this.connected) throw new Error('not connected');
    if (this.mode === 'hw') throw new Error('reader is in HW trigger mode — it reads by itself on IR trigger (switch to Manual to poll)');
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

  async setMode(cfg = {}) {
    const prev = this.mode;
    // Both IR modes trigger off a GPI beam. On a reader with no GPIO the mode
    // would sit there silently never firing, which reads as "the rig is broken"
    // rather than "wrong reader for the job".
    if ((cfg.mode === 'ir' || cfg.mode === 'hw') && this.hasGpio === false) {
      throw new Error(`this reader has no GPIO — ${cfg.mode.toUpperCase()} triggering needs a gate reader (UR4). Use manual mode.`);
    }
    if (cfg.mode === 'manual' || cfg.mode === 'ir' || cfg.mode === 'hw') this.mode = cfg.mode;
    if (Number.isFinite(cfg.irDurationMs)) this.irDurationMs = cfg.irDurationMs;
    if (Number.isFinite(cfg.irMinGapMs)) this.irMinGapMs = cfg.irMinGapMs;
    if (Number.isFinite(cfg.udpPort) && cfg.udpPort > 0) this.udpPort = cfg.udpPort;
    if (typeof cfg.destIp === 'string') this.destIp = cfg.destIp || null;
    this.log(`Mode = ${this.mode} (burst ${this.irDurationMs}ms, gap ${this.irMinGapMs}ms).`);

    try {
      if (this.mode === 'hw') {
        await this._enterHwMode(); // idempotent; also re-applies changed params
      } else if (prev === 'hw') {
        await this._exitHwMode();
      }
      // Leaving IR mode while in an IR burst? let the burst finish naturally.
    } finally {
      this._emitStatus();
    }
    return this.getStatus();
  }

  /**
   * Enter HW trigger mode: the reader itself watches GPI and inventories for
   * the configured burst, pushing tag data over UDP to us (work mode 2 never
   * outputs tags on the TCP link — doc UHFSetWorkModePara param[5]).
   */
  async _enterHwMode() {
    if (uhf.capabilities && !uhf.capabilities.hw) {
      throw new Error('HW trigger mode requires the DLL driver (UHF_DRIVER=dll on Windows) — use IR (bridge) mode here');
    }
    if (!this.connected) {
      this.log('HW trigger mode selected — will arm on next connect.', 'warn');
      return;
    }
    if (this.reading) {
      // direct stop (not stopReading) — mode is already 'hw'
      await this._withLock(() => uhf.stopInventory());
      this.reading = false;
      this.readingUntil = null;
    }
    const dest = this.destIp || this._hostIpForReader(this.lastReaderIp) || '192.168.99.100';
    this.resolvedDestIp = dest;
    this.udp.start(this.udpPort);
    await this._withLock(() => {
      const rcPara = uhf.setWorkModePara(this.irTriggerInput - 1, this.irDurationMs, this.irMinGapMs, 1 /* UDP */);
      const rcDest = uhf.setDestIp(dest, this.udpPort);
      const rcMode = uhf.setWorkMode(2);
      this.log(
        `HW trigger armed: workModePara(GPI${this.irTriggerInput}, ${this.irDurationMs}ms, gap ${this.irMinGapMs}ms, UDP) rc=${rcPara}; destIp ${dest}:${this.udpPort} rc=${rcDest}; workMode(2) rc=${rcMode}.`
      );
      if (rcMode !== 0) throw new Error(`UHFSetWorkMode(2) failed (rc=${rcMode})`);
      if (rcDest !== 0) this.log(`UHFSetDestIp rc=${rcDest} — reader may push UDP to a stale destination.`, 'warn');
      if (rcPara !== 0) this.log(`UHFSetWorkModePara rc=${rcPara} — trigger params may be stale.`, 'warn');
      // Verify the reader actually stored what we sent (destIp encoding bit us once).
      const back = uhf.getDestIp();
      if (back) {
        this.log(`destIp readback: ${back.ip}:${back.port} (raw ${back.rawIp}/${back.rawPort}).`);
        if (back.ip !== dest || back.port !== this.udpPort) {
          this.log(`destIp MISMATCH — reader stored ${back.ip}:${back.port}, wanted ${dest}:${this.udpPort}. UDP will not arrive.`, 'error');
        }
      } else {
        this.log('destIp readback unavailable.', 'warn');
      }
    });
    this.log(`HW trigger live. Break the IR beam — datagrams should appear from ${this.lastReaderIp || 'reader'}.`);
  }

  /** Back to command mode; stop the UDP listener. */
  async _exitHwMode() {
    this.udp.stop();
    this.resolvedDestIp = null;
    if (this.connected) {
      await this._withLock(() => {
        const rc = uhf.setWorkMode(0);
        this.log(`Left HW trigger mode: workMode(0) rc=${rc}.`);
      });
    }
  }

  /** Reader stopped answering: mark down and start auto-reconnect. */
  _onLinkLost() {
    if (!this.connected) return;
    this.connected = false;
    this.reading = false;
    this.readingUntil = null;
    this._gpiFailCount = 0;
    this.log('Reader link lost (power cycle / cable?). Auto-reconnecting...', 'warn');
    this._emitStatus();
    this._reconnectLoop();
  }

  /** Probe with a plain Node socket — never hammer the DLL while the reader is down. */
  _tcpProbe(ip, port) {
    return new Promise((resolve) => {
      const s = net.connect({ host: ip, port, timeout: 1500 });
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => { s.destroy(); resolve(false); });
      s.on('timeout', () => { s.destroy(); resolve(false); });
    });
  }

  async _reconnectLoop() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    const ip = this.lastReaderIp;
    const port = this.lastReaderPort || 8888;
    try {
      // clear the DLL's dead socket once
      await this._withLock(() => {
        try { uhf.disconnect(); } catch (_) { /* already dead */ }
      });

      // A USB reader has no IP to probe. Re-opening it is the only way back —
      // and connectUsb() verifies a reader actually answers, so this waits for
      // the real device rather than latching onto UsbOpen()'s phantom success.
      if (this.lastTransport === 'usb') {
        while (this._running && this._wantConnected && !this.connected) {
          try {
            await this.connectUsb();
          } catch (err) {
            this.log(`USB reconnect attempt failed: ${err.message}`, 'warn');
          }
          if (!this.connected) await sleep(5000);
        }
        if (this.connected) this.log('Auto-reconnect OK — reader is back.');
        return;
      }

      while (this._running && this._wantConnected && !this.connected && ip) {
        if (await this._tcpProbe(ip, port)) {
          await sleep(1500); // let the reader finish booting
          try {
            await this.connect(ip, port); // full reset + hw re-arm if needed
          } catch (err) {
            this.log(`reconnect attempt failed: ${err.message}`, 'warn');
          }
        }
        if (!this.connected) await sleep(5000);
      }
      if (this.connected) this.log('Auto-reconnect OK — reader is back.');
    } finally {
      this._reconnecting = false;
    }
  }

  /** Find our IPv4 on the same /24 as the reader (direct-cable setup). */
  _hostIpForReader(readerIp) {
    if (!readerIp) return null;
    const prefix = readerIp.split('.').slice(0, 3).join('.') + '.';
    for (const addrs of Object.values(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal && a.address.startsWith(prefix)) return a.address;
      }
    }
    return null;
  }

  /** Reader pushed a UDP datagram (HW trigger burst output). */
  _onUdpDatagram(d) {
    const now = Date.now();
    const ts = new Date().toISOString();
    // Burst detection: a datagram after a quiet period = the reader triggered.
    const newBurst = now - this.lastUdpAt > Math.max(500, this.irDurationMs);
    this.lastUdpAt = now;
    if (newBurst) {
      this.log(`HW TRIGGER: UDP burst started (from ${d.from}).`);
      this.emit('message', { type: 'trigger', input: this.irTriggerInput, source: 'hw', timestamp: ts });
    }
    this.emit('message', {
      type: 'udp',
      raw: d.raw,
      len: d.len,
      from: d.from,
      parsed: Boolean(d.parsed && d.parsed.epc),
      epc: d.parsed?.epc ?? null,
      timestamp: ts,
    });
    if (d.parsed && d.parsed.epc) {
      this._totalReads = (this._totalReads || 0) + 1;
      this.emit('message', {
        type: 'tag',
        epc: d.parsed.epc,
        antenna: d.parsed.antenna,
        rssi: d.parsed.rssi,
        tid: d.parsed.tid,
        direction: null, // HW trigger mode is single-GPI — no direction info
        source: 'udp',
        timestamp: ts,
      });
    }
  }

  getStatus() {
    return {
      connected: this.connected,
      reading: this.reading,
      mode: this.mode,
      // null until a link is open. false = desktop reader: no GPI, no IR modes.
      hasGpio: this.hasGpio,
      irDurationMs: this.irDurationMs,
      irMinGapMs: this.irMinGapMs,
      gpi: this.lastGpi,
      passage: this.passage,
      udp: {
        listening: this.udp.listening,
        port: this.udpPort,
        frames: this.udp.frames,
        destIp: this.resolvedDestIp,
      },
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
          // Keep watching the beams while reading — the second beam of a
          // passage breaks DURING the burst, and the dashboard wants live GPI.
          if (this.mode === 'ir' && Date.now() - this._lastGpiPollAt >= this.gpiIntervalMs) {
            this._lastGpiPollAt = Date.now();
            await this._withLock(() => this._pollGpiOnce());
          }
          if (this.readingUntil && Date.now() >= this.readingUntil) {
            await this.stopReading();
            // IR level-extension: if EITHER beam is still broken when the
            // burst expires, the pallet is still in the doorway — keep
            // reading instead of waiting for a fresh clear->broken edge.
            if (this.mode === 'ir' && this.connected) {
              const g = await this._withLock(() => uhf.getGpi());
              if (g && g.rc === 0) {
                this.lastGpi1 = g.gpi1 === true;
                this.lastGpi2 = g.gpi2 === true;
                if (g.gpi1 === true || g.gpi2 === true) {
                  this.log('IR burst extended — beam still broken.');
                  await this.startReading(this.irDurationMs);
                } else {
                  this._endPassage();
                }
              } else {
                this._endPassage();
              }
            } else {
              this._endPassage();
            }
          }
          delay = got > 0 ? 0 : 10; // keep draining while tags flow
        } else if (this.hasGpio === false) {
          // No GPIO to poll. Idle cheaply and check liveness occasionally
          // rather than hammering a call this reader will never answer.
          await this._withLock(() => this._pollAlive());
          delay = 500;
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
  async _drainTags() {
    const tags = await uhf.drainTags(100);
    let n = 0;
    for (const tag of tags) {
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
        direction: this.passage ? this.passage.direction : null,
        passageId: this.passage ? this.passage.id : null,
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

  /**
   * Decide once, per link, whether this reader has GPIO at all.
   *
   * The UR4 gate does — GPI1/GPI2 are the IR beams. A desktop reader (R3/R1)
   * does NOT, so every GPI read fails, and treating that as a health signal
   * declared a perfectly working reader dead within half a second and flipped
   * `connected` to false under live requests. Verified on an R3, 2026-08-06.
   */
  async _detectGpio() {
    // try/catch, not .catch() — the DLL driver is synchronous and returns a
    // plain object, only the sidecar returns a promise. `await` handles both.
    let gpi;
    try {
      gpi = await uhf.getGpi();
    } catch (_) {
      gpi = { rc: -1 };
    }
    this.hasGpio = Boolean(gpi && gpi.rc === 0);
    this.log(
      this.hasGpio
        ? 'Reader has GPIO — GPI polling and IR trigger modes available.'
        : 'Reader has no GPIO (desktop reader) — GPI polling off; IR modes unavailable.'
    );
    return this.hasGpio;
  }

  /**
   * Liveness for readers without GPIO. Cheap, infrequent, and uses a call the
   * SDK actually answers on both families — unlike GPI, which is UR4-only.
   */
  async _pollAlive() {
    const now = Date.now();
    if (now - (this._lastAliveAt || 0) < 5000) return;
    this._lastAliveAt = now;
    let alive = true;
    try {
      if (uhf.isReaderAlive) alive = await uhf.isReaderAlive();
    } catch (_) {
      alive = false;
    }
    if (alive) {
      this._gpiFailCount = 0;
      return;
    }
    this._gpiFailCount = (this._gpiFailCount || 0) + 1;
    if (this._gpiFailCount >= 3) this._onLinkLost();
  }

  /** Read GPI once, broadcast, and (in IR mode) detect the trigger edge. */
  async _pollGpiOnce() {
    const gpi = await uhf.getGpi();

    // Link health: a power-cycled reader leaves the DLL with a dead socket
    // that the bridge can't otherwise see. 3 consecutive failed reads = lost.
    // Only meaningful on a reader that HAS GPIO — see _detectGpio.
    if (gpi.rc !== 0) {
      if (this.hasGpio === false) return;
      this._gpiFailCount = (this._gpiFailCount || 0) + 1;
      if (this._gpiFailCount >= 3) this._onLinkLost();
      return;
    }
    this._gpiFailCount = 0;

    this.lastGpi = { gpi1: gpi.gpi1, gpi2: gpi.gpi2, raw: gpi.raw };
    this.emit('message', {
      type: 'gpi',
      gpi1: gpi.gpi1,
      gpi2: gpi.gpi2,
      raw: gpi.raw,
      timestamp: new Date().toISOString(),
    });

    // Edge detect: clear (false) -> broken (true), on both beams.
    const broken1 = gpi.gpi1 === true;
    const broken2 = gpi.gpi2 === true;
    const edge1 = broken1 && !this.lastGpi1;
    const edge2 = broken2 && !this.lastGpi2;
    this.lastGpi1 = broken1;
    this.lastGpi2 = broken2;

    if (this.mode !== 'ir') return;

    // Safety: a passage left open with no burst running and both beams clear
    // (e.g. startReading failed) would block all future triggers — close it.
    if (this.passage && !this.reading && !broken1 && !broken2) this._endPassage();

    // First edge while no passage is open decides direction:
    // GPI1 (outside beam) first = 'in', GPI2 (inside beam) first = 'out'.
    if (!this.passage && (edge1 || edge2)) {
      const now = Date.now();
      if (now - this.lastTriggerAt >= this.irMinGapMs) {
        this.lastTriggerAt = now;
        // Both edges landing in the same poll tick = order unknown. Still
        // burst (we want the tag reads) but leave direction null — nexus
        // treats direction-less reads as strays.
        const direction = edge1 && edge2 ? null : edge1 ? 'in' : 'out';
        const input = edge1 ? 1 : 2;
        this.passage = { id: ++this._passageSeq, direction, input, startedAt: now };
        if (direction) {
          this.log(`IR TRIGGER: GPI${input} beam broken first -> direction ${direction.toUpperCase()}, starting burst.`);
        } else {
          this.log('IR TRIGGER: both beams broke in the same poll — direction unknown, starting burst anyway.', 'warn');
        }
        this.emit('message', { type: 'trigger', input, direction, timestamp: new Date().toISOString() });
        // start burst (schedule outside lock via microtask; loop will pick up READING)
        this.startReading(this.irDurationMs).catch((e) => this.log(e.message, 'error'));
      }
    }
  }

  /** Burst ended with both beams clear — close the passage. */
  _endPassage() {
    if (!this.passage) return;
    const { direction, startedAt } = this.passage;
    this.passage = null;
    this.log(`Passage closed (direction ${direction ?? 'unknown'}, ${Date.now() - startedAt}ms).`);
    this.emit('message', { type: 'passage-end', direction, timestamp: new Date().toISOString() });
  }
}

module.exports = { Controller };
