'use strict';

require('dotenv').config();

const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Controller } = require('./controller');

const PORT = Number(process.env.PORT || 3001);
const DEFAULT_IP = process.env.UR4_IP || '192.168.99.202';
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

app.post('/mode', (req, res) => {
  res.json({ ok: true, ...controller.setMode(req.body || {}) });
});

app.get('/status', (_req, res) => {
  res.json({ ...controller.getStatus(), supabase: SB_ENABLED, defaults: { ip: DEFAULT_IP, port: DEFAULT_PORT } });
});

// Diagnostic: raw GPI/IO bytes to calibrate the GPI bit mapping against hardware.
app.get('/debug/io', async (_req, res) => {
  try {
    const uhf = require('./uhf');
    const io = await controller._withLock(() => ({
      ioStatus: uhf.readIOStatus(),
      gpi: uhf.getGpi(),
      gpiConfig: uhf.getGpiConfig(),
      workMode: uhf.getWorkMode(),
    }));
    res.json({ ok: true, ...io });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Diagnostic: adjust GPI bit mapping live, e.g. { "gpi1Byte":0, "activeHigh":false }
app.post('/debug/gpi-config', (req, res) => {
  const uhf = require('./uhf');
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

// Print one label + encode its EPC. Body: { epc?, title?, copies? }.
// Omit epc to auto-generate the next sequential test EPC.
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
  if (msg.type === 'tag') forwardToSupabase(msg);
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
