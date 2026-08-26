'use strict';

require('dotenv').config();

/**
 * READER-ONLY bridge — the build that runs on a staff PC.
 *
 * Why this file exists at all
 * ---------------------------
 * A USB reader is only visible to the machine it is plugged into. The Chainway
 * R1 desktop reader lives on a staff PC, so the process that opens it must run
 * on that staff PC — the gate bridge on the server physically cannot see it
 * (UsbOpen() enumerates the local USB bus, nothing more).
 *
 * But the gate bridge is the WRONG thing to ship to a staff PC. It carries the
 * movement outbox, passage/IR detection, the Supabase read forward, the board
 * feed, TTS and the CP30 printer — none of which belong on a desk, and two of
 * which (outbox, Supabase forward) WRITE to shared systems. A misconfigured
 * copy on someone's laptop could push gate movements or tag scans that never
 * physically happened.
 *
 * So this is a separate entry point rather than a `ROLE=reader` flag on
 * server.js: the dangerous modules are not required, not constructed, and have
 * no env var that could switch them back on by accident. What isn't in the file
 * cannot be turned on by a stray .env line.
 *
 * What runs here
 * --------------
 *   Controller (src/controller.js)  — the single serialized DLL owner
 *   driver     (src/driver.js)      — UHFAPI.dll via koffi
 *   express + ws                    — the HTTP/WS face Nexus already speaks
 *
 * Idle cost is near zero: with a desktop reader `hasGpio` resolves to false, so
 * the control loop takes the cheap branch — a liveness probe every 5s, loop
 * delay 500ms (controller.js `_tick`). Disconnected, it is a 250ms no-op.
 *
 * What is deliberately ABSENT
 * ---------------------------
 *   outbox / passage / IR    gate-only, and the outbox writes to Nexus
 *   Supabase forward         writes rfid_reads / operations_tag_scan
 *   board feed, TTS          wallboard kiosk concerns
 *   printer (/printer/*)     Nexus points printing at the SERVER bridge
 *   POST /connect (TCP)      see the 501 stub below
 *
 * Pairing with Nexus
 * ------------------
 * Nexus addresses the reader and the printer separately: reader calls go to
 * this process on localhost, printer calls stay on the server bridge. See
 * src/lib/printer-bridge.ts in the Nexus repo.
 */

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Controller } = require('./controller');

const PORT = Number(process.env.PORT || 3001);

const controller = new Controller();

// --- silence the idle liveness probe ------------------------------------------
//
// The R1 chirps its buzzer on every command it receives, and while connected but
// idle the controller polls isReaderAlive() every 5 seconds — which sends TWO
// commands (getRegion + getProtocolType). The result is a beep every 5 seconds,
// all shift, at whoever is sitting next to it. Confirmed on the bench: the
// beeping tracked this poll exactly, stopping the moment the reader link closed.
//
// That probe exists for the GATE. A UR4 sits on a TCP link that can die silently
// while still looking connected, and the gate must notice or it stops logging
// movements. A USB desktop reader has no equivalent failure mode: if it is
// unplugged the next call fails immediately, and connectUsb() already proves a
// real reader answered before reporting success.
//
// The trade-off, stated plainly: with no idle probe, an unplugged reader keeps
// reporting connected:true until the next real operation fails, so the UI can
// show "reader on" when the cable is out. That is a strictly better failure than
// beeping at an operator for eight hours, and any actual read or write surfaces
// it at once. Set READER_IDLE_PROBE=1 to restore polling.
//
// Overridden on THIS INSTANCE rather than in controller.js, which is shared with
// the gate bridge — the gate keeps its liveness detection untouched.
const IDLE_PROBE = process.env.READER_IDLE_PROBE === '1';
if (!IDLE_PROBE) {
  controller._pollAlive = async () => {};
  controller.log('Idle liveness probe disabled — the reader beeps on every command it receives.');
}

// --- HTTP / Express -----------------------------------------------------------
const app = express();
app.use(express.json());

// Nexus is served from another origin (Vercel), so the browser preflights these
// calls. Localhost is a "potentially trustworthy" origin, which is the only
// reason an HTTPS Nexus page is allowed to call this plain-HTTP server at all.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  // Chrome Private Network Access. Being a secure context is NOT sufficient: a
  // page on a PUBLIC origin (Nexus on Vercel) reaching a LOOPBACK address is a
  // private-network request, so Chrome sends a preflight carrying
  // `Access-Control-Request-Private-Network: true` and requires this header back.
  // Without it the request never leaves the browser and the page sees a generic
  // network failure — indistinguishable from "the bridge is not running", which
  // is exactly how it presented: curl worked, the Nexus Test button did not.
  res.header('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --- link lifecycle -----------------------------------------------------------

// The only connect path a staff PC gets. No IP, no port: the reader is whatever
// is plugged into this machine.
app.post('/connect-usb', async (_req, res) => {
  try {
    const rc = await controller.connectUsb();
    res.json({ ok: rc === 0, code: rc, ...controller.getStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * The gate reader is NOT reachable from here — on purpose.
 *
 * A staff PC could technically TCP-connect to the UR4 at the doorway, and the
 * DLL would happily let it: the reader accepts one control link, so a desk
 * clicking "connect" would steal the gate's session and silently stop movement
 * logging for the whole warehouse. The gate belongs to the server bridge alone.
 *
 * 501 rather than 404 so the Nexus error surfaces as this sentence instead of
 * "Print bridge error (404)".
 */
app.post('/connect', (_req, res) => {
  res.status(501).json({
    ok: false,
    error: 'This is the desktop-reader bridge — it only opens the USB reader on this PC. The gate reader is driven by the server bridge.',
  });
});

// Same reasoning: IR / hardware-trigger work modes exist for the gate's beams.
// A desktop reader reports hasGpio:false and has nothing to trigger on.
app.post('/mode', (_req, res) => {
  res.status(501).json({ ok: false, error: 'Work modes (IR / hardware trigger) are gate-only. This reader runs in manual mode.' });
});

app.post('/disconnect', async (_req, res) => {
  try {
    await controller.disconnect();
    res.json({ ok: true, ...controller.getStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- inventory (the live tag stream feeding Tag Station / Receiving / Transfers)
app.post('/inventory/start', async (_req, res) => {
  try {
    const rc = await controller.startReading();
    res.json({ ok: rc === 0, code: rc, ...controller.getStatus() });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});

app.post('/inventory/stop', async (_req, res) => {
  try {
    const rc = await controller.stopReading();
    res.json({ ok: rc === 0, code: rc, ...controller.getStatus() });
  } catch (err) {
    res.status(409).json({ ok: false, error: err.message });
  }
});

// `defaults` (the gate's IP/port) is omitted — there is no network reader here.
// Nexus treats it as optional; no screen reads it.
app.get('/status', (_req, res) => {
  // idleProbe is reported so "is it still beeping at me?" is answerable without
  // reading the log or trusting that an env var took effect.
  res.json({ ...controller.getStatus(), role: 'reader', idleProbe: IDLE_PROBE });
});

// --- single-tag access (writing pallet tags) ----------------------------------
// Carried over verbatim from server.js. Every write is addressed by TID and
// verified by read-back, which is what stops a neighbouring tag from being the
// one programmed — do not "simplify" that away.

/** Shared guard: tag ops need the radio idle, and a filter that is real. */
async function withTagAccess(res, fn) {
  const uhf = require('./driver');
  if (!controller.connected) {
    res.status(409).json({ ok: false, error: 'not connected' });
    return;
  }
  if (!uhf.readBank) {
    res.status(501).json({ ok: false, error: 'the active driver does not implement tag access' });
    return;
  }
  // The reader ignores commands mid-inventory, so a read/write issued during a
  // burst would silently do nothing.
  if (controller.reading) await controller.stopReading();
  try {
    res.json({ ok: true, ...(await controller._withLock(() => fn(uhf))) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

/** Turn a request body's filter spec into a driver filter, or null. */
function filterFrom(body, uhf) {
  if (body?.tid) return uhf.filterByTid(body.tid);
  if (body?.epc) return uhf.filterByEpc(body.epc);
  return null;
}

// GET /tag — singulate one tag and report PC + EPC (+ TID when readable).
app.get('/tag', async (_req, res) => {
  await withTagAccess(res, async (uhf) => {
    const single = await uhf.inventorySingle();
    if (!single) return { tag: null };
    const filter = uhf.filterByEpc(single.epc);
    const tid = await uhf.readBank({ bank: uhf.BANK.TID, ptr: 0, words: 6, filter });
    return {
      tag: { ...single, epcWords: uhf.epcWordsFromPc(single.pc), tid: tid.rc === 0 ? tid.hex : null },
    };
  });
});

// POST /tag/read  { bank, ptr, words, tid?|epc?, accessPwd? }
app.post('/tag/read', async (req, res) => {
  const { bank, ptr = 0, words = 1, accessPwd } = req.body ?? {};
  if (!Number.isInteger(bank) || bank < 0 || bank > 3) {
    return res.status(400).json({ ok: false, error: 'bank must be 0 (RESERVED), 1 (EPC), 2 (TID) or 3 (USER)' });
  }
  await withTagAccess(res, (uhf) =>
    uhf.readBank({ bank, ptr: Number(ptr), words: Number(words), filter: filterFrom(req.body, uhf), accessPwd })
  );
});

// POST /tag/write  { bank, ptr, data, tid?|epc?, accessPwd? }
// Addressing by `tid` is strongly preferred: an EPC filter matches whatever
// currently carries that EPC, a TID filter matches one physical chip.
app.post('/tag/write', async (req, res) => {
  const { bank, ptr = 0, data, accessPwd, attempts } = req.body ?? {};
  if (!Number.isInteger(bank) || bank < 0 || bank > 3) {
    return res.status(400).json({ ok: false, error: 'bank must be 0 (RESERVED), 1 (EPC), 2 (TID) or 3 (USER)' });
  }
  if (typeof data !== 'string' || !data.trim()) return res.status(400).json({ ok: false, error: 'data (hex) required' });

  // Retry by default. A Gen2 write needs materially more RF energy than a read,
  // so a tag that inventories fine can still drop a single write — measured at
  // -65dBm on the bench, roughly one miss in five. Retrying is safe precisely
  // because every attempt is verified: we rewrite the SAME bytes and stop the
  // moment the tag reads them back, so a retry can never compound a bad write.
  const maxAttempts = Math.max(1, Math.min(5, Number(attempts) || 3));

  await withTagAccess(res, async (uhf) => {
    const filter = filterFrom(req.body, uhf);
    const expected = data.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
    const words = expected.length / 4;
    const tries = [];

    for (let i = 1; i <= maxAttempts; i++) {
      const rc = await uhf.writeBank({ bank, ptr: Number(ptr), dataHex: expected, filter, accessPwd });
      // Always read back — a write rc of 0 is not evidence that it stuck.
      const back = await uhf.readBank({ bank, ptr: Number(ptr), words, filter, accessPwd });
      tries.push({ attempt: i, rc, readBack: back.hex });
      if (rc === 0 && back.hex === expected) {
        return { rc, wrote: expected, readBack: back.hex, verified: true, attempts: i, tries };
      }
      // Let the tag re-power before trying again — back-to-back writes on a
      // marginal link tend to fail the same way.
      if (i < maxAttempts) await new Promise((r) => setTimeout(r, 60));
    }

    const last = tries[tries.length - 1];
    return { rc: last.rc, wrote: expected, readBack: last.readBack, verified: false, attempts: tries.length, tries };
  });
});

// Reader output power in dBm. GET reads it; POST sets it for this session only
// (save=false) — a bench power bump must not silently persist to the device.
app.get('/tag/power', async (_req, res) => {
  await withTagAccess(res, async (uhf) => ({ dBm: await uhf.getPower() }));
});

app.post('/tag/power', async (req, res) => {
  const dBm = Number(req.body?.dBm);
  if (!Number.isInteger(dBm) || dBm < 1 || dBm > 30) return res.status(400).json({ ok: false, error: 'dBm must be 1..30' });
  await withTagAccess(res, async (uhf) => {
    const rc = await uhf.setPower(dBm, false);
    return { rc, dBm: await uhf.getPower() };
  });
});

/**
 * Graceful shutdown, for the installer to call before it replaces files.
 *
 * This exists because force-killing the process is genuinely destructive to the
 * hardware state: Stop-Process -Force never runs the SIGTERM handler, so
 * UsbClose() is skipped and the reader is left with its USB endpoint claimed.
 * The next UsbOpen() then returns 0 while the reader answers nothing — a phantom
 * link that only a physical replug clears. Learned the hard way: repeated
 * force-kills during testing wedged the reader and needed the cable pulled.
 *
 * Responds BEFORE closing the reader so the caller gets its answer even though
 * the process is about to exit.
 */
app.post('/shutdown', (_req, res) => {
  res.json({ ok: true, stopping: true });
  controller.log('Shutdown requested — closing the reader link before exit.');
  setTimeout(async () => {
    try {
      await controller.stop(); // stops inventory, then UsbClose()
    } catch (err) {
      controller.log(`shutdown error: ${err.message}`, 'warn');
    }
    process.exit(0);
  }, 100);
});

// Client-side error reports. Running as a background service there is no console
// for the operator to read, so this is the one way a browser-side failure on
// this PC reaches the service log.
app.post('/client-log', (req, res) => {
  const { source = 'client', stage = '?', message = '', ua = '' } = req.body || {};
  controller.log(`[${source}] ${stage}: ${String(message).slice(0, 300)} (ua: ${String(ua).slice(0, 120)})`, 'warn');
  res.json({ ok: true });
});

// --- listeners ----------------------------------------------------------------
// BOTH loopback addresses, and deliberately NOT 0.0.0.0.
//
// Loopback-only is the security boundary: on 0.0.0.0 anyone on the warehouse LAN
// could drive this reader and write pallet tags.
//
// Both families, because "localhost" is not one address. On Windows it resolves
// to ::1 before 127.0.0.1, so a v4-only listener refuses connections from any
// client that doesn't fall back — measured with PowerShell's Invoke-RestMethod,
// which does not. Browsers usually do fall back, which is exactly what makes
// this the kind of bug that works on the dev's machine and fails on a staff PC.
//
// The tag stream broadcasts to every socket across both listeners. That is
// correct here in a way it is NOT on the shared server bridge: this process
// serves one PC, so every client is the same operator (the Nexus tab, plus a
// reload's leftover socket).
const sockets = new Set();

function attach(host) {
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    sockets.add(ws);
    controller.log(`WS client connected (${sockets.size} total).`);
    ws.send(JSON.stringify({ type: 'status', ...controller.getStatus(), timestamp: new Date().toISOString() }));
    ws.on('close', () => {
      sockets.delete(ws);
      controller.log(`WS client disconnected (${sockets.size} total).`);
    });
  });

  server.on('error', (err) => {
    // A PC with IPv6 disabled cannot bind ::1. That is not a failure — the v4
    // listener still serves everything. Any other error is real.
    if (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') {
      controller.log(`${host} unavailable (${err.code}) — skipping that listener.`, 'warn');
      return;
    }
    if (err.code === 'EADDRINUSE') {
      controller.log(`Port ${PORT} is already in use on ${host} — is another copy running?`, 'error');
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, host, () => controller.log(`Listening on http://${host.includes(':') ? `[${host}]` : host}:${PORT}`));
}

controller.on('message', (msg) => {
  const data = JSON.stringify(msg);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(data);
  }
});

// --- boot ---------------------------------------------------------------------
controller.log(`Desktop-reader bridge on http://localhost:${PORT}  (WS: ws://localhost:${PORT}/ws)`);
controller.log('Reader-only build: no gate, no movement push, no Supabase, no printer.');
attach('127.0.0.1');
attach('::1');
controller.start();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    controller.log(`${sig} — shutting down.`);
    try {
      await controller.stop();
    } catch (err) {
      controller.log(`shutdown error: ${err.message}`, 'warn');
    }
    process.exit(0);
  });
}
