'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Controller } = require('./controller');

const PORT = Number(process.env.PORT || 3001);
const DEFAULT_IP = process.env.UR4_IP || '192.168.254.202';
const DEFAULT_PORT = Number(process.env.UR4_PORT || 8888);

// --- Supabase forwarding (optional) ------------------------------------------
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_ANON_KEY || '';
const SB_TABLE = process.env.SUPABASE_TABLE || 'rfid_reads';
const SB_ENABLED = Boolean(SB_URL && SB_KEY);

async function forwardToSupabase(tag) {
  if (!SB_ENABLED) return;
  try {
    const res = await fetch(`${SB_URL.replace(/\/$/, '')}/rest/v1/${SB_TABLE}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        epc: tag.epc,
        antenna: tag.antenna,
        rssi: tag.rssi,
        timestamp: tag.timestamp,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      controller.log(`Supabase POST ${res.status}: ${body.slice(0, 200)}`, 'warn');
    }
  } catch (err) {
    controller.log(`Supabase forward error: ${err.message}`, 'warn');
  }
}

// --- Controller ---------------------------------------------------------------
const controller = new Controller();

// --- Printer (Chainway CP30, ZPL) ----------------------------------------------
const { PrinterManager } = require('./printer');
const printer = new PrinterManager({ log: (text, level) => controller.log(`[printer] ${text}`, level) });

// --- Mock Nexus (warehouse check-in simulation) --------------------------------
const { MockNexus } = require('./nexus');
const nexus = new MockNexus({
  dedupMs: Number(process.env.NEXUS_DEDUP_MS || 5000),
  quietMs: Number(process.env.NEXUS_QUIET_MS || 700),
  maxWindowMs: Number(process.env.NEXUS_MAX_WINDOW_MS || 4000),
  location: process.env.NEXUS_LOCATION || 'WH-ENTRANCE-1',
  url: process.env.NEXUS_URL || '',
  apiKey: process.env.NEXUS_API_KEY || '',
  authHeader: process.env.NEXUS_AUTH_HEADER || '',
});
nexus.on('log', (text) => controller.log(`[nexus] ${text}`));
nexus.on('movement', (event) => {
  controller.log(
    `[nexus] ${event.type === 'entry' ? 'CHECK-IN ' : 'CHECK-OUT'} ${event.item.sku} (${
      event.known ? event.item.name : 'UNKNOWN EPC'
    }) dir=${event.direction} via=${event.method} ants=[${event.antennas}] epc=${event.epc}`
  );
  broadcast(event); // event.type is already 'entry' | 'exit'
});

// --- HTTP / Express -----------------------------------------------------------
const app = express();
app.use(express.json());

// permissive CORS for the local Vite dev server
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.post('/connect', async (req, res) => {
  const ip = req.body?.ip || DEFAULT_IP;
  const port = req.body?.port || DEFAULT_PORT;
  try {
    const rc = await controller.connect(ip, port);
    res.json({ ok: rc === 0, code: rc, ...controller.getStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Open a USB desktop reader (e.g. Chainway R1) — same DLL as the TCP path.
app.post('/connect-usb', async (_req, res) => {
  try {
    const rc = await controller.connectUsb();
    res.json({ ok: rc === 0, code: rc, ...controller.getStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/disconnect', async (_req, res) => {
  try {
    await controller.disconnect();
    res.json({ ok: true, ...controller.getStatus() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/mode', async (req, res) => {
  try {
    const status = await controller.setMode(req.body || {});
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, ...controller.getStatus() });
  }
});

app.get('/status', (_req, res) => {
  res.json({ ...controller.getStatus(), supabase: SB_ENABLED, defaults: { ip: DEFAULT_IP, port: DEFAULT_PORT } });
});

// Diagnostic: raw GPI/IO bytes to calibrate the GPI bit mapping against hardware.
app.get('/debug/io', async (_req, res) => {
  try {
    const uhf = require('./driver');
    const io = await controller._withLock(async () => ({
      ioStatus: await uhf.readIOStatus(),
      gpi: await uhf.getGpi(),
      gpiConfig: uhf.getGpiConfig(),
      workMode: await uhf.getWorkMode(),
    }));
    res.json({ ok: true, ...io });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Diagnostic: reader-side work mode / trigger params / UDP destination.
app.get('/debug/workmode', async (_req, res) => {
  try {
    const uhf = require('./driver');
    const info = await controller._withLock(async () => ({
      workMode: await uhf.getWorkMode(), // 0 command, 1 auto, 2 trigger
      workModePara: await uhf.getWorkModePara(),
      destIp: await uhf.getDestIp(),
    }));
    res.json({ ok: true, ...info, udp: controller.getStatus().udp });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Diagnostic: adjust GPI bit mapping live, e.g. { "gpi1Byte":0, "activeHigh":false }
app.post('/debug/gpi-config', (req, res) => {
  const uhf = require('./driver');
  res.json({ ok: true, gpiConfig: uhf.setGpiConfig(req.body || {}) });
});

// --- Printer endpoints ----------------------------------------------------------
app.get('/printer/status', async (_req, res) => {
  // printerReady says whether a printer is actually reachable behind the
  // transport — the spooler accepts jobs even with nothing attached, so
  // clients must gate print runs on this, not on ok:true (= bridge is up).
  const readiness = await printer.checkReady().catch((e) => ({ ready: false, detail: e.message }));
  res.json({ ok: true, ...printer.getStatus(), printerReady: readiness.ready, printerDetail: readiness.detail });
});

app.post('/printer/config', (req, res) => {
  try {
    res.json({ ok: true, config: printer.setConfig(req.body || {}) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Print one label + encode its EPC. Body: { epc?, title?, productName?,
// itemNo?, poRef?, copies?, jobId?, boxId?, widthDots?, heightDots?,
// topOffsetDots?, leftOffsetDots? }. productName/itemNo/poRef select the
// carton-label layout (name / ITEM No. / PO Number / EPC / barcode); title
// alone keeps the legacy layout. Layout fields override the stored config for
// this print only (label-size profiles live in Nexus and travel with each
// request). Omit epc to auto-generate the next sequential test EPC.
app.post('/printer/print', async (req, res) => {
  try {
    const result = await printer.printLabel(req.body || {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Generated ZPL for the next label without sending it. Query: ?epc=...&title=...
app.get('/printer/preview', (req, res) => {
  try {
    res.json({ ok: true, ...printer.preview(req.query || {}) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Print a run of N labels as one continuous job. Body: { count, title? }.
app.post('/printer/batch', async (req, res) => {
  try {
    const result = await printer.printBatch(req.body || {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Send arbitrary ZPL verbatim (tuning: ^RS write power, offsets, ~HS, ...).
app.post('/printer/raw', async (req, res) => {
  const zplText = req.body?.zpl;
  if (!zplText || typeof zplText !== 'string') {
    return res.status(400).json({ ok: false, error: 'body must be { "zpl": "^XA...^XZ" }' });
  }
  try {
    res.json({ ok: true, ...(await printer.sendRaw(zplText)) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Durable print log — the airtight reconcile source. ?jobId= filters to one job.
// Nexus pulls this before resuming to mark cartons that printed but whose "done"
// signal never reached it (browser/PC crash), so they're never reprinted.
app.get('/printer/log', (req, res) => {
  try {
    res.json({ ok: true, entries: printer.readPrintLog({ jobId: req.query.jobId }) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Windows print queue names, for the USB queue picker.
app.get('/printer/queues', async (_req, res) => {
  try {
    res.json({ ok: true, queues: await printer.listQueues() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Mock Nexus routes ----------------------------------------------------------
// Demo/testing: simulate a tag read end-to-end (nexus check-in + WS + voice + TV)
// without hardware. Body: { epc? } — omit epc for a random catalog tag.
app.post('/debug/mock-tag', (req, res) => {
  const catalogEpcs = Object.keys(nexus.catalog);
  const epc =
    req.body?.epc ||
    (catalogEpcs.length ? catalogEpcs[Math.floor(Math.random() * catalogEpcs.length)] : 'AA00000000000000000000FF');
  const msg = {
    type: 'tag',
    epc: String(epc).toUpperCase(),
    antenna: Number(req.body?.antenna) || 1,
    rssi: -55 - Math.round(Math.random() * 20),
    tid: null,
    source: 'mock',
    timestamp: new Date().toISOString(),
  };
  controller.emit('message', msg); // flows through broadcast + nexus like a real read
  res.json({ ok: true, epc: msg.epc, antenna: msg.antenna });
});

// Demo: simulate a full IR passage (GPI1 first = in, GPI2 first = out).
// Emits the trigger + direction-stamped tag reads, exactly like the
// controller does during a real two-beam passage. Body: { epc?, direction? }.
app.post('/debug/mock-passage', async (req, res) => {
  const catalogEpcs = Object.keys(nexus.catalog);
  const epc = String(
    req.body?.epc || (catalogEpcs.length ? catalogEpcs[Math.floor(Math.random() * catalogEpcs.length)] : 'AA00000000000000000000FF')
  ).toUpperCase();
  const dir = req.body?.direction === 'out' ? 'out' : 'in';
  const input = dir === 'in' ? 1 : 2;
  const passageId = `mock-${Date.now()}`; // unique per call, like a real passage id
  controller.emit('message', { type: 'trigger', input, direction: dir, source: 'mock', timestamp: new Date().toISOString() });
  const fire = () =>
    controller.emit('message', {
      type: 'tag', epc, antenna: 1, rssi: -60, tid: null, direction: dir, passageId, source: 'mock', timestamp: new Date().toISOString(),
    });
  fire();
  setTimeout(fire, 300);
  res.json({ ok: true, epc, direction: dir });
});

// Read power: GET current, POST { dBm } to set (1..30, persisted).
app.get('/power', async (_req, res) => {
  try {
    const uhf = require('./driver');
    const dBm = await controller._withLock(() => uhf.getPower());
    res.json({ ok: dBm != null, dBm });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/power', async (req, res) => {
  try {
    const dBm = Number(req.body?.dBm);
    if (!Number.isInteger(dBm) || dBm < 1 || dBm > 30) return res.status(400).json({ ok: false, error: 'dBm must be 1..30' });
    // reader ignores config commands mid-inventory — pause any active read
    if (controller.reading) await controller.stopReading();
    const uhf = require('./driver');
    const result = await controller._withLock(async () => {
      const rc = await uhf.setPower(dBm, true);
      return { rc, dBm: await uhf.getPower() };
    });
    controller.log(`Read power set to ${result.dBm}dBm (rc=${result.rc}).`);
    res.json({ ok: result.rc === 0, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Antenna config: which ports are enabled + physically connected.
app.get('/antennas', async (_req, res) => {
  try {
    const uhf = require('./driver');
    const info = await controller._withLock(async () => ({
      enabled: await uhf.getAntennas(),
      connected: await uhf.getAntennaLink(),
    }));
    res.json({ ok: true, ...info });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/antennas', async (req, res) => {
  try {
    const uhf = require('./driver');
    const ports = req.body?.ports;
    if (!Array.isArray(ports) || ports.length === 0) return res.status(400).json({ ok: false, error: 'ports: number[] required' });
    const result = await controller._withLock(async () => {
      const rc = await uhf.setAntennas(ports, true);
      return { rc, enabled: await uhf.getAntennas() };
    });
    res.json({ ok: result.rc === 0, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/nexus/summary', (_req, res) => res.json({ ok: true, ...nexus.summary() }));
app.get('/nexus/inventory', (_req, res) => res.json({ ok: true, inventory: nexus.getInventory() }));
app.get('/nexus/events', (req, res) => res.json({ ok: true, events: nexus.getEvents(Number(req.query.limit) || 50) }));
app.post('/nexus/reset', (_req, res) => {
  nexus.reset();
  res.json({ ok: true, ...nexus.summary() });
});
app.post('/nexus/catalog/reload', (_req, res) => res.json({ ok: true, catalog: nexus.loadCatalog() }));
app.post('/nexus/config', (req, res) => {
  const summary = nexus.setConfig(req.body || {});
  controller.log(`[nexus] config: dedup=${summary.dedupMs}ms quiet=${summary.quietMs}ms maxWindow=${summary.maxWindowMs}ms`);
  res.json({ ok: true, ...summary });
});


// --- WebSocket ----------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  controller.log(`WS client connected (${wss.clients.size} total).`);
  // send a snapshot immediately
  ws.send(JSON.stringify({ type: 'status', ...controller.getStatus(), timestamp: new Date().toISOString() }));
  ws.on('close', () => controller.log(`WS client disconnected (${wss.clients.size} total).`));
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

controller.on('message', (msg) => {
  broadcast(msg);
  if (msg.type === 'tag') {
    forwardToSupabase(msg);
    nexus.tagSeen(msg); // warehouse check-in (dedup + catalog inside)
  }
});

// --- boot ---------------------------------------------------------------------
server.listen(PORT, () => {
  controller.log(`Bridge listening on http://localhost:${PORT}  (WS: ws://localhost:${PORT}/ws)`);
  controller.log(`Reader defaults: ${DEFAULT_IP}:${DEFAULT_PORT}. Supabase forwarding: ${SB_ENABLED ? 'ON' : 'off'}.`);
  try {
    controller.start();
  } catch (err) {
    controller.log(`Failed to start controller: ${err.message}`, 'error');
  }
});

process.on('SIGINT', async () => {
  controller.log('Shutting down...');
  await controller.stop();
  process.exit(0);
});
