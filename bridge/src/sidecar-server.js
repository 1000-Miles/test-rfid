'use strict';

/**
 * Windows reader sidecar: hosts UHFAPI.dll next to a USB/COM desktop reader
 * and serves the sidecar HTTP contract, so a bridge on ANOTHER machine can
 * drive this reader with UHF_DRIVER=sidecar UHF_SIDECAR_URL=http://<this-pc>:3010.
 *
 * The contract is whatever uhf-sidecar.js (the bridge-side client) calls — the
 * same one the Java/Linux sidecar answers. Params arrive as QUERY STRINGS even
 * on POST (that is how the client encodes them), so every handler reads
 * req.query, never req.body.
 *
 * Concurrency: koffi calls are synchronous on Node's single thread, so DLL
 * calls can never truly interleave. Ordering (e.g. "stop inventory before a
 * tag write") is the bridge controller's job, exactly as with the local DLL.
 */

const express = require('express');
const uhf = require('./uhf');
const { autoConnect } = require('./reader-connect');

const PORT = Number(process.env.SIDECAR_PORT || process.argv[2] || 3010);

const app = express();

// ── inventory pump ───────────────────────────────────────────────────────────
// Tags drain from the DLL's buffer into this queue; GET /tags pops batches.
// Same shape as the Java sidecar: the client polls, we accumulate.

const MAX_QUEUE = 5000;
let queue = [];
let dropped = 0;
let reading = false;
let pumpTimer = null;

function pumpOnce() {
  if (!reading) return;
  try {
    // Bounded per tick so a tag flood cannot starve the event loop.
    for (let i = 0; i < 200; i++) {
      const tag = uhf.pollTag();
      if (!tag) break;
      queue.push(tag);
      if (queue.length > MAX_QUEUE) {
        queue.shift();
        dropped++;
      }
    }
  } catch (err) {
    log(`pump error: ${err.message}`, 'error');
  }
  pumpTimer = setTimeout(pumpOnce, 10);
}

function startPump() {
  if (reading) return;
  reading = true;
  pumpOnce();
}

function stopPump() {
  reading = false;
  if (pumpTimer) clearTimeout(pumpTimer);
  pumpTimer = null;
}

function log(msg, level = 'info') {
  const line = `[sidecar] ${msg}`;
  if (level === 'error') console.error(line);
  else console.log(line);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Wrap a handler: catch everything, always answer JSON with an ok flag. */
const route = (fn) => (req, res) => {
  try {
    res.json(fn(req));
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
};

/** Rebuild a driver filter from the wire params (fbank / fptr bits / fdata hex). */
function filterFromQuery(q) {
  if (!q.fdata) return null;
  return {
    bank: Number(q.fbank),
    startBit: Number(q.fptr) || 0,
    data: Buffer.from(String(q.fdata).replace(/[^0-9a-fA-F]/g, ''), 'hex'),
  };
}

// The reader ignores commands mid-inventory, so tag ops and config writes
// pause any active read first (the bridge does the same, but a direct caller
// must not be able to wedge the reader).
function stopReadingForCommand() {
  if (reading) {
    stopPump();
    try {
      uhf.stopInventory();
    } catch (_) {
      /* no link — nothing was reading */
    }
  }
}

// ── contract routes ──────────────────────────────────────────────────────────

app.get('/status', route(() => ({
  ok: true,
  connected: uhf.isConnected(),
  transport: uhf.getLinkType(),
  reading,
  queueDepth: queue.length,
  dropped,
})));

// The client treats a truthy version as "reader alive", so this MUST be gated
// on the region+protocol probe: the DLL hands back a plausible baked-in version
// string on a phantom link (see uhf.isReaderAlive). Returning that raw would
// make a dead reader look alive forever.
app.get('/version', route(() => {
  if (!uhf.isConnected() || !uhf.isReaderAlive()) return { ok: false, version: null };
  return { ok: true, version: uhf.getSoftwareVersion() };
}));

// TCP connect — passthrough for a network reader reachable from THIS machine.
// autoConnect's openAndVerify gates on isReaderAlive, so a listener that is
// not a reader (wrong IP) comes back ok:false instead of a phantom link.
app.post('/connect', route((req) => {
  stopPump();
  const ip = String(req.query.ip || '');
  const port = Number(req.query.port || 8888);
  if (!ip) return { ok: false, error: 'ip required' };
  if (uhf.isConnected()) uhf.disconnect();
  const r = autoConnect({ tcp: `${ip}:${port}`, onAttempt: (l) => log(l) });
  return { ok: r.ok, transport: r.transport };
}));

// USB/COM connect — the reason this sidecar exists. Reuses the shared
// autoConnect sweep (UsbOpen first, then every registered COM port), which
// already refuses UsbOpen()'s phantom rc=0 success.
app.post('/connect-usb', route((req) => {
  stopPump();
  if (uhf.isConnected()) uhf.disconnect();
  const opts = { onAttempt: (l) => log(l) };
  if (req.query.com != null) opts.com = Number(req.query.com);
  if (req.query.baud != null) opts.baud = Number(req.query.baud);
  const r = autoConnect(opts);
  return { ok: r.ok, transport: r.transport };
}));

app.post('/disconnect', route(() => {
  stopPump();
  queue = [];
  if (uhf.isConnected()) uhf.disconnect();
  return { ok: true };
}));

app.post('/inventory/start', route(() => {
  if (reading) return { ok: true };
  const rc = uhf.startInventory();
  if (rc !== 0) return { ok: false, error: `UHFInventory() rc=${rc}` };
  queue = [];
  dropped = 0;
  startPump();
  return { ok: true };
}));

app.post('/inventory/stop', route(() => {
  stopPump();
  const rc = uhf.isConnected() ? uhf.stopInventory() : 0;
  return { ok: rc === 0 };
}));

app.get('/tags', route((req) => {
  const max = Math.max(1, Math.min(1000, Number(req.query.max) || 100));
  const batch = queue.splice(0, max);
  return {
    ok: true,
    tags: batch.map((t) => ({
      epc: t.epc,
      pc: t.pc,
      tid: t.tid,
      user: t.user,
      ant: t.antenna,
      rssi: t.rssi,
    })),
  };
}));

// Wire format: state 0 = beam broken (the client interprets it that way).
// uhf.getGpi already folds the NPN/PNP polarity in, gpi1 true = broken.
app.get('/gpi', route(() => {
  const g = uhf.getGpi();
  if (g.rc !== 0) return { ok: false };
  const state = (broken) => (broken == null ? null : broken ? 0 : 1);
  return {
    ok: true,
    gpi: [
      { name: 'GPI1', state: state(g.gpi1) },
      { name: 'GPI2', state: state(g.gpi2) },
    ],
  };
}));

app.get('/power', route(() => {
  const dBm = uhf.getPower();
  if (dBm == null) return { ok: false };
  return { ok: true, power: [{ ant: 1, dbm: dBm }] };
}));

app.post('/power', route((req) => {
  const dBm = Number(req.query.dbm);
  if (!Number.isInteger(dBm) || dBm < 1 || dBm > 30) return { ok: false, error: 'dbm must be 1..30' };
  stopReadingForCommand();
  const save = req.query.save == null ? true : req.query.save !== '0';
  const rc = uhf.setPower(dBm, save);
  return { ok: rc === 0 };
}));

app.get('/antennas', route(() => {
  const enabled = uhf.getAntennas();
  if (!enabled) return { ok: false };
  return { ok: true, enabled };
}));

app.post('/antennas', route((req) => {
  const ports = String(req.query.ports || '')
    .split(',')
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 1);
  if (!ports.length) return { ok: false, error: 'ports required' };
  stopReadingForCommand();
  const rc = uhf.setAntennas(ports, true);
  return { ok: rc === 0, enabled: uhf.getAntennas() };
}));

app.get('/workmode', route(() => {
  const mode = uhf.getWorkMode();
  return { ok: mode != null, mode };
}));

app.post('/workmode', route((req) => {
  const rc = uhf.setWorkMode(Number(req.query.mode) & 0xff);
  return { ok: rc === 0 };
}));

// ── single-tag access ────────────────────────────────────────────────────────
// Retry/verify policy lives in the BRIDGE's /tag/write route; these are the
// raw one-shot operations it composes.

app.get('/tag/single', route(() => {
  stopReadingForCommand();
  const tag = uhf.inventorySingle();
  return { ok: true, tag };
}));

app.post('/tag/read', route((req) => {
  stopReadingForCommand();
  const r = uhf.readBank({
    bank: Number(req.query.bank),
    ptr: Number(req.query.ptr) || 0,
    words: Number(req.query.words) || 1,
    filter: filterFromQuery(req.query),
    accessPwd: req.query.pwd || undefined,
  });
  if (r.rc !== 0) return { ok: false, rc: r.rc };
  return { ok: true, hex: r.hex };
}));

app.post('/tag/write', route((req) => {
  stopReadingForCommand();
  const rc = uhf.writeBank({
    bank: Number(req.query.bank),
    ptr: Number(req.query.ptr) || 0,
    dataHex: String(req.query.data || ''),
    filter: filterFromQuery(req.query),
    accessPwd: req.query.pwd || undefined,
  });
  return { ok: rc === 0, rc };
}));

// ── startup ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log(`reader sidecar listening on 0.0.0.0:${PORT} (driver: koffi + UHFAPI.dll)`);
  log(`point the bridge at it: UHF_DRIVER=sidecar UHF_SIDECAR_URL=http://<this-pc>:${PORT}`);
});

process.on('SIGINT', () => {
  stopPump();
  try {
    if (uhf.isConnected()) uhf.disconnect();
  } catch (_) {
    /* already gone */
  }
  process.exit(0);
});
