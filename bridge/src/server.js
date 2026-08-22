'use strict';

require('dotenv').config();

const os = require('os');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Controller } = require('./controller');

// Interface name fragments that mean "not the real LAN link" on this Windows
// warehouse PC — VPN, VirtualBox, and Hyper-V/WSL adapters all show up in
// os.networkInterfaces() with a private-looking address that nothing else on
// the warehouse LAN can actually route to. Picking one of those would produce
// a QR code that silently fails on a phone.
const VIRTUAL_IFACE_PATTERN = /virtualbox|vethernet|hyper-v|vmware|loopback|docker|wsl|tailscale|vpn/i;

/** Best-guess LAN IPv4 for this machine — what a phone on the same network can reach. */
function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (VIRTUAL_IFACE_PATTERN.test(name)) continue;
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return null; // no real NIC found — caller decides how to degrade
}

const PORT = Number(process.env.PORT || 3001);
const DEFAULT_IP = process.env.UR4_IP || '192.168.254.202';
const DEFAULT_PORT = Number(process.env.UR4_PORT || 8888);

// --- Supabase forwarding (optional) ------------------------------------------
const SB_URL = process.env.SUPABASE_URL || '';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SB_TABLE = process.env.SUPABASE_TABLE || 'rfid_reads';
const SB_ENABLED = Boolean(SB_URL && SB_KEY);
let sbForwardDisabled = false; // latched on 404 — table missing, don't spam warnings per read

// --- Push cutover burn-in -----------------------------------------------------
// Until this date the bridge dual-writes movements: the new push to Nexus AND
// the legacy direct insert below. Past it the legacy write goes inert and the
// bridge nags on every boot, so the dead code gets deleted rather than
// quietly living forever. Unset = burn-in already over (push only).
const BURN_IN_UNTIL = process.env.MOVEMENT_BURN_IN_UNTIL || '';
const BURN_IN_ACTIVE = Boolean(BURN_IN_UNTIL) && Date.now() < Date.parse(`${BURN_IN_UNTIL}T23:59:59Z`);

async function forwardToSupabase(tag) {
  if (!SB_ENABLED || sbForwardDisabled) return;
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
      if (res.status === 404) {
        sbForwardDisabled = true;
        controller.log(`Supabase table "${SB_TABLE}" not found (404) — read forwarding disabled for this run.`, 'warn');
      } else {
        controller.log(`Supabase POST ${res.status}: ${body.slice(0, 200)}`, 'warn');
      }
    }
  } catch (err) {
    controller.log(`Supabase forward error: ${err.message}`, 'warn');
  }
}

// LEGACY direct write, kept only for the push cutover burn-in ------------------
// Movement -> Nexus DB: every portal entry/exit is written to
// operations_tag_scan (same table the receiving flow uses). The event check
// constraint allows ship|receive|putaway|transfer, so: in = receive, out =
// ship, with reader='portal' marking gate scans.
//
// SUPERSEDED BY THE OUTBOX. POST /api/movement is now the canonical writer: it
// is the only path that also moves warehouse_carton/warehouse_pallet status,
// and it survives an outage because the outbox journals first. This function
// runs alongside it until MOVEMENT_BURN_IN_UNTIL so that a bug in the new push
// path stays invisible to operations, then it should be DELETED along with its
// call site. Running both is safe (no duplicate rows): the ingest dedupes on
// physical passage time, so even a replayed event collapses onto this row.
async function forwardMovementToSupabase(event) {
  if (!SB_ENABLED || !BURN_IN_ACTIVE) return;
  try {
    const res = await fetch(`${SB_URL.replace(/\/$/, '')}/rest/v1/operations_tag_scan`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        epc: event.epc,
        event: event.direction === 'in' ? 'receive' : 'ship',
        product_code: event.item?.sku ?? null,
        location: event.location,
        reader: 'portal',
        rssi: event.rssi ?? null,
        note: `gate ${event.direction} via ${event.method}${event.known ? '' : ' (unknown EPC)'}`,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      controller.log(`movement -> operations_tag_scan ${res.status}: ${body.slice(0, 200)}`, 'warn');
    }
  } catch (err) {
    controller.log(`movement -> operations_tag_scan error: ${err.message}`, 'warn');
  }
}

// --- Controller ---------------------------------------------------------------
const controller = new Controller();

// --- Printers: carton labels on the Chainway CP30 (ZPL, main config) and
// --- barcode-only pallet tags on the dedicated Gprinter (TSPL, palletPrinterName)
const { PrinterManager } = require('./printer');
const printer = new PrinterManager({ log: (text, level) => controller.log(`[printer] ${text}`, level) });

// --- Passage detection (raw reads -> one movement event per passage) -----------
const { PassageDetector } = require('./passage');
const nexus = new PassageDetector({
  dedupMs: Number(process.env.NEXUS_DEDUP_MS || 5000),
  quietMs: Number(process.env.NEXUS_QUIET_MS || 700),
  maxWindowMs: Number(process.env.NEXUS_MAX_WINDOW_MS || 4000),
  // NO-IR trial ("toggle") defaults — see passage.js. Also switchable live via
  // POST /nexus/config { detectMode: 'toggle' | 'ir' } (the engineering
  // console's No-IR trial tab drives that).
  detectMode: process.env.NEXUS_DETECT_MODE === 'toggle' ? 'toggle' : 'ir',
  toggleDedupMs: Number(process.env.NEXUS_TOGGLE_DEDUP_MS || 60_000),
  absenceMs: Number(process.env.NEXUS_ABSENCE_MS || 30_000),
  minRssi: process.env.NEXUS_MIN_RSSI ? Number(process.env.NEXUS_MIN_RSSI) : null,
  toggleMinReads: Number(process.env.NEXUS_TOGGLE_MIN_READS || 1),
  location: process.env.NEXUS_LOCATION || 'WH-ENTRANCE-1',
  // Tag registry: catalog is loaded from operations_label_tag in this
  // Supabase project (and cached to data/catalog.json for offline boots).
  catalogUrl: SB_URL,
  catalogKey: SB_KEY,
  // "Is any live receiving batch waiting for this product?" — answered by the
  // board feed, which already holds exactly that list. Deliberately a closure
  // over `board` (declared below) rather than a value: it must answer with the
  // board as it is at PASSAGE time, not as it was at boot. Only ever called
  // from a movement decision, long after `board` is initialised.
  expectsInbound: (sku) => board.expectsInbound(sku),
});

// --- Outbox (durable push to Nexus POST /api/movement) -------------------------
// NEXUS_URL is the full ingest URL. The key travels as Authorization: Bearer and
// must equal the MOVEMENT_API_KEY configured on the Nexus deployment — a
// mismatch 401s every event, which shows up as a rising queueDepth in /status
// rather than as lost data.
//
// MOVEMENT_API_KEY is preferred because that is the variable Nexus itself reads;
// NEXUS_API_KEY is the fallback for deployments that only carry the older name.
const { Outbox } = require('./outbox');
// Permanent identity of this gate — the `gateId` half of every movement's
// immutable event id (`gateId:seq`). Falls back to the location tag so a
// single-gate site needs no extra config, but a second gate MUST set GATE_ID
// or the two would mint colliding event ids.
const GATE_ID = process.env.GATE_ID?.trim();
if ((process.env.NEXUS_URL || process.env.NEXUS_BATCH_URL) && !GATE_ID) {
  throw new Error('GATE_ID is required when NEXUS_URL is configured; assign a permanent unique ID to this physical gate.');
}
const outbox = new Outbox({
  url: process.env.NEXUS_URL || '',
  batchUrl: process.env.NEXUS_BATCH_URL || '',
  apiKey: process.env.MOVEMENT_API_KEY || process.env.NEXUS_API_KEY || '',
  gateId: GATE_ID || 'unconfigured-local-gate',
  // Normally unset. Point at a scratch directory (relative to bridge/) to run
  // test passages against a throwaway journal: nothing touches the live
  // movement-log.jsonl, so no test event can drain to Nexus later or hydrate
  // real toggle state on the next boot. Pair with a blank NEXUS_URL, or the
  // pump will still deliver the scratch journal.
  dataDir: process.env.MOVEMENT_DATA_DIR
    ? require('path').resolve(__dirname, '..', process.env.MOVEMENT_DATA_DIR)
    : undefined,
  timeoutMs: Number(process.env.MOVEMENT_TIMEOUT_MS || 10_000),
  baseBackoffMs: Number(process.env.MOVEMENT_BACKOFF_MS || 1_000),
  maxBackoffMs: Number(process.env.MOVEMENT_MAX_BACKOFF_MS || 60_000),
  drainPerSec: Number(process.env.MOVEMENT_DRAIN_PER_SEC || 5),
  // Short code printed into every pallet code (PALLET-G1-001). MUST differ
  // between gates — see _nextPalletCode.
  gateShort: process.env.GATE_SHORT || 'G1',
  batchSettleMs: Number(process.env.MOVEMENT_BATCH_SETTLE_MS || 500),
  toggleBatchQuietMs: Number(process.env.MOVEMENT_TOGGLE_BATCH_QUIET_MS || 1_500),
  togglePalletWindowMs: Number(process.env.MOVEMENT_TOGGLE_PALLET_WINDOW_MS || 120_000),
  log: (text, level) => controller.log(`[outbox] ${text}`, level),
});
outbox.on('batch-sent', (reply) => {
  broadcast({ type: 'passage-complete', timestamp: new Date().toISOString(), ...reply });
});
outbox.on('pallet-open', (pallet) => {
  broadcast({ type: 'pallet-open', ...pallet });
});
// Printing a physical label is an ACTION, and this used to take it on every
// inbound batch with no condition beyond the direction — so a stray read in
// NO-IR mode (where a read IS a movement, with no beam to gate it) opened a
// pallet, settled, and spat out a label for a pallet nobody had loaded. Off by
// default: the card still appears the moment the pallet is ready, and the Print
// button on it is one press away.
//
// PALLET_AUTOPRINT=1 restores the hands-free behaviour for a gate whose read
// zone is tight enough to trust — see NEXUS_MIN_RSSI.
const PALLET_AUTOPRINT = /^(1|true|yes|on)$/i.test(process.env.PALLET_AUTOPRINT || '');

outbox.on('batch-ready', (batch) => {
  broadcast({ type: 'pallet-ready', ...batch });
  if (batch.direction !== 'in') return;
  // The flag gates HANDS-FREE printing — a label nobody asked for. It must not
  // gate a label an operator just pressed for: /movement/pallet/close is the
  // "Close & print" button, so its close reason IS the print request. Without
  // this, that press closed the pallet and printed nothing, and the operator had
  // to press the card's second button to get the label they had already asked
  // for twice.
  const operatorAsked = batch.closeReason === 'operator-print';
  if (!PALLET_AUTOPRINT && !operatorAsked) {
    controller.log(
      `[printer] pallet ${batch.palletCode} ready (${batch.cartonCount} carton(s)) — waiting for Print ` +
        `(PALLET_AUTOPRINT is off)`
    );
    return;
  }
  printer.printPalletTag({ palletCode: batch.palletCode, jobId: batch.requestId })
    .then((result) => broadcast({ type: 'pallet-print', ok: true, ...batch, replayed: result.replayed }))
    .catch((error) => broadcast({ type: 'pallet-print', ok: false, ...batch, error: error.message }));
});

// --- Board feed (real receiving documents for the kiosk) ----------------------
// Base URL defaults to NEXUS_URL with the /api/... path stripped, so a single
// setting covers both the movement push and the document reads.
const { BoardFeed } = require('./board');
const board = new BoardFeed({
  baseUrl: process.env.NEXUS_BASE_URL || deriveNexusBase(process.env.NEXUS_URL || process.env.NEXUS_BATCH_URL || ''),
  token: process.env.OPERATIONS_HANDHELD_TOKEN || '',
  // Kept below the kiosk poll so the faster polling actually returns fresher
  // data. Env-tunable so a site with many screens can back the Nexus read rate
  // off without a code change.
  maxAgeMs: Number(process.env.BOARD_CACHE_MS || 4_000),
  log: (text, level) => controller.log(`[board] ${text}`, level),
  // Receiving went backwards in Nexus (a batch reset, a document removed). Same
  // broadcast the carton-withdrawal path uses, from the other direction: that
  // one sees cartons lose their warehouse rows, this one sees the figures fall.
  // Either is enough for a screen to know its local counts are about to be
  // wrong, and a reset rarely shows up as both.
  onReceivingReset: (info) => {
    // Wipe the gate's own memory FIRST, then tell the screens. Skipping this is
    // what made a redo fail silently: the reader saw every carton and the
    // bridge accepted a couple, because the rest were still inside their re-arm
    // window or still remembered as INSIDE and therefore read as leaving.
    nexus.resetForReceiving();
    broadcast({
      type: 'receiving-reset',
      epcs: [],
      count: 0,
      reasons: info.reasons,
      timestamp: new Date().toISOString(),
    });
  },
});

function deriveNexusBase(movementUrl) {
  try {
    const u = new URL(movementUrl);
    return u.origin;
  } catch {
    return '';
  }
}

// Toggle (no-IR) mode has no beams to trigger bursts: it depends on the
// inventory running CONTINUOUSLY, and a reader power blip would otherwise
// leave the gate silently blind — the auto-reconnect resets the reader but
// only HW mode re-arms itself. Scoped to the reconnect path on purpose: a
// human pressing Stop, and the tag-access/printer flows that pause reading
// briefly, must not be fought.
controller.on('reconnected', () => {
  if (nexus.detectMode !== 'toggle' || controller.mode !== 'manual' || controller.reading) return;
  controller
    .startReading()
    .then(() => controller.log('toggle mode: continuous reading resumed after reconnect'))
    .catch((err) => controller.log(`toggle mode: read resume after reconnect FAILED: ${err.message}`, 'error'));
});

nexus.on('log', (text) => controller.log(`[passage] ${text}`));
// A receiving reset (or batch delete) in Nexus withdrew some cartons. The gate
// has already corrected its own direction state; this hands the same fact to
// every open board so they can drop the credits they are holding for cartons
// Nexus no longer considers received.
nexus.on('withdrawn', (info) => {
  // Same wipe from the other detector. Cheap and idempotent, and a reset that
  // shows up as withdrawn cartons must clear the gate exactly as one that shows
  // up as falling figures.
  nexus.resetForReceiving();
  broadcast({
    type: 'receiving-reset',
    epcs: info.epcs,
    count: info.epcs.length,
    timestamp: new Date().toISOString(),
  });
});

// The gate's own memory of who is INSIDE used to die with the process — fatal
// for toggle mode, where that memory is the primary direction source. The
// outbox journal already holds every movement this gate ever fired, so replay
// it into the live view at boot: the in/out flip and the re-arm clock survive
// restarts and offline stretches alike. Local only — nothing is re-sent.
try {
  nexus.hydrate(outbox.readJournal());
} catch (err) {
  controller.log(`journal hydrate failed (${err.message}) — starting with empty local state`, 'warn');
}
nexus.on('movement', (event) => {
  controller.log(
    `[passage] ${event.type === 'entry' ? 'CHECK-IN ' : 'CHECK-OUT'} ${event.item.sku} (${
      event.known ? event.item.name : 'UNKNOWN EPC'
    }) dir=${event.direction} via=${event.method} ants=[${event.antennas}] epc=${event.epc}`
  );
  // Journal FIRST, broadcast SECOND — and this time the code matches the
  // comment. The old order showed the movement on the TV before it was durable
  // anywhere: a disk failure at that instant produced a counted-but-nonexistent
  // event, unfindable afterwards. Now a movement is only ever shown once it is
  // fsynced in the journal (and carries its eventId, stamped by enqueue). A
  // journal failure is a critical alarm: the log line below broadcasts to every
  // dashboard, and the failure is counted in /status movement.journal.
  try {
    outbox.enqueue(event); // stamps event.eventId/gateId/seq in place
  } catch (err) {
    controller.log(
      `[outbox] FAILED TO JOURNAL movement ${event.epc}: ${err.message} — event NOT counted, NOT broadcast. Check the disk.`,
      'error'
    );
    return; // not durable => not accepted: no board credit, no legacy write
  }
  broadcast(event); // event.type is already 'entry' | 'exit'
  forwardMovementToSupabase(event); // legacy dual-write, inert after the burn-in
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
  res.json({
    ...controller.getStatus(),
    supabase: SB_ENABLED,
    defaults: { ip: DEFAULT_IP, port: DEFAULT_PORT },
    // Movement delivery health. A gate that has stopped reporting shows up here
    // as a rising queueDepth with a stale lastPushAt — the retry policy is
    // deliberately silent-and-forever, so this is how a human finds out.
    movement: { ...outbox.status(), burnInUntil: BURN_IN_UNTIL || null, legacyDirectWrite: BURN_IN_ACTIVE },
  });
});

// LAN address of this PC — used by the kiosk to build a QR code that a phone
// on the same warehouse network can actually open (localhost/127.0.0.1 in the
// kiosk's own browser bar means nothing to a second device).
app.get('/network', (_req, res) => {
  const ip = lanAddress();
  res.json({ ok: Boolean(ip), ip });
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
  // The printer's own calibrated label length, which is what label geometry is
  // computed against when no size is configured. Surfaced so a layout that does
  // not fill the media can be diagnosed without printing anything.
  const labelLengthDots = await printer.labelLengthDots().catch(() => null);
  // The pallet-tag printer is a SEPARATE device with its own queue, so it needs
  // its own readiness verdict — the CP30 being fine says nothing about it.
  const pallet = await printer.checkPalletReady().catch((e) => ({ ready: false, detail: e.message }));
  res.json({
    ok: true,
    ...printer.getStatus(),
    printerReady: readiness.ready,
    printerDetail: readiness.detail,
    palletReady: pallet.ready,
    palletDetail: pallet.detail,
    labelLengthDots,
  });
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

// Pallet tags already printed, newest first — backs the "Previously printed"
// reprint list on the pallet page. Distinct from /printer/log (the raw
// reconcile feed): this is collapsed per pallet and capped for a UI list.
app.get('/printer/pallet-prints', (req, res) => {
  try {
    res.json({ ok: true, prints: printer.recentPalletPrints({ limit: req.query.limit }) });
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

// --- Text-to-speech for the gate board -------------------------------------------
// TV browsers (Android WebView and friends) have no speechSynthesis, so the
// board fetches its announcement audio from here instead. Cached on disk, so
// repeat phrases work even when the synth service is unreachable.
const { handleTtsRequest } = require('./tts');
app.get('/tts', (req, res) => handleTtsRequest(req, res, (text, level) => controller.log(text, level)));

// Client-side error reports from the board. The wallboard TV has no devtools,
// so this log line is the only visibility into why IT went silent — the
// dashboard posts here whenever speech fails on the display device.
app.post('/client-log', (req, res) => {
  const { source = 'client', stage = '?', message = '', ua = '' } = req.body || {};
  controller.log(`[${source}] ${stage}: ${String(message).slice(0, 300)} (ua: ${String(ua).slice(0, 120)})`, 'warn');
  res.json({ ok: true });
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

// Demo: simulate a NO-IR visit — a short burst of direction-less reads,
// exactly what the detector sees in toggle mode with the antennas facing each
// other and no beams. In IR mode the same reads are strays (by design), so
// this only produces a movement while detectMode is 'toggle'.
// Body: { epc?, rssi?, reads? }.
app.post('/debug/mock-visit', (req, res) => {
  const catalogEpcs = Object.keys(nexus.catalog);
  const epc = String(
    req.body?.epc || (catalogEpcs.length ? catalogEpcs[Math.floor(Math.random() * catalogEpcs.length)] : 'AA00000000000000000000FF')
  ).toUpperCase();
  const rssi = Number(req.body?.rssi) || -58;
  const count = Math.max(1, Math.min(10, Number(req.body?.reads) || 3));
  const fire = () =>
    controller.emit('message', {
      type: 'tag', epc, antenna: 1, rssi, tid: null, direction: null, passageId: null, source: 'mock', timestamp: new Date().toISOString(),
    });
  for (let i = 0; i < count; i++) setTimeout(fire, i * 150);
  res.json({ ok: true, epc, reads: count, detectMode: nexus.detectMode });
});

/** Last successful power read, so a busy reader never blanks the display. */
let lastPowerRead = null;

/**
 * Read power. GET current, POST { dBm } to set (1..30, persisted).
 *
 * The reader refuses config reads mid-inventory, and the gate is reading
 * essentially all the time — so this used to answer {ok:false, dBm:null} on
 * every call an operator ever made, and the console showed a default. It looked
 * exactly like settings that would not save, when the values were on the reader
 * the whole time. So: pause, read, resume, the same way POST already does.
 */
app.get('/power', async (_req, res) => {
  try {
    const uhf = require('./driver');
    const wasReading = controller.reading;
    if (wasReading) await controller.stopReading();
    const { dBm, perAntenna } = await controller._withLock(async () => ({
      dBm: await uhf.getPower(),
      perAntenna: uhf.getAntennaPower ? await uhf.getAntennaPower() : null,
    }));
    if (wasReading) {
      // Never end the shift over a settings read.
      try {
        await controller.startReading();
      } catch (err) {
        controller.log(`could not resume reading after power read: ${err.message}`, 'warn');
      }
    }
    if (dBm != null) lastPowerRead = { dBm, perAntenna, at: new Date().toISOString() };
    // `applied` is what this process last wrote per port — kept because the
    // firmware cannot read back everything, and it survives a failed read.
    if (dBm == null && lastPowerRead) {
      return res.json({ ok: true, ...lastPowerRead, stale: true, applied: { ...antennaPowerApplied } });
    }
    res.json({ ok: dBm != null, dBm, perAntenna, applied: { ...antennaPowerApplied } });
  } catch (err) {
    // A cached figure beats a blank box on a wallboard nobody can debug.
    if (lastPowerRead) return res.json({ ok: true, ...lastPowerRead, stale: true, error: err.message, applied: { ...antennaPowerApplied } });
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * Set read power — globally with { dBm }, or per antenna with
 * { perAntenna: { "3": 20, "4": 26 } }.
 *
 * Per-port matters at a real gate because the ports are not equivalent: one
 * antenna covers the doorway and another reaches down the aisle, and running
 * both at the same dBm is what pulls distant stock into the read zone while the
 * carton actually passing reads no better. One knob for both was hiding that.
 *
 * The firmware's per-antenna READ-back returns nothing, so the bridge remembers
 * what it last wrote and reports it as `applied` — otherwise the UI could never
 * show what is set.
 */
const antennaPowerApplied = {}; // port -> dBm last written by this process

app.post('/power', async (req, res) => {
  try {
    const perAntenna = req.body?.perAntenna;
    const dBm = Number(req.body?.dBm);
    const hasPer = perAntenna && typeof perAntenna === 'object' && Object.keys(perAntenna).length > 0;
    if (!hasPer && (!Number.isInteger(dBm) || dBm < 1 || dBm > 30)) {
      return res.status(400).json({ ok: false, error: 'dBm must be 1..30, or pass perAntenna: { port: dBm }' });
    }
    const entries = hasPer ? Object.entries(perAntenna).map(([k, v]) => [Number(k), Number(v)]) : [];
    for (const [port, value] of entries) {
      if (!Number.isInteger(port) || port < 1 || port > 16) return res.status(400).json({ ok: false, error: `bad antenna port ${port}` });
      if (!Number.isInteger(value) || value < 1 || value > 30) return res.status(400).json({ ok: false, error: `dBm for antenna ${port} must be 1..30` });
    }
    // reader ignores config commands mid-inventory — pause any active read
    const wasReading = controller.reading;
    if (wasReading) await controller.stopReading();
    const uhf = require('./driver');
    const result = await controller._withLock(async () => {
      // Reject ports this reader does not have — checked HERE, with inventory
      // paused, because the firmware reports enabled=[1] while it is reading
      // and would make every real antenna look absent.
      //
      // Needed because the reader ACCEPTS a write to a port it does not have:
      // it returns rc=0 and changes nothing, so a 4-port UR4 confirmed "antenna
      // 5 set to 13 dBm" and discarded it. Indistinguishable, from the console,
      // from a setting that will not save.
      if (entries.length) {
        const enabled = (await uhf.getAntennas()) || [];
        // An empty list means the reader would not say. Attempting the write
        // beats blocking a legitimate one on a failed probe.
        if (enabled.length) {
          const missing = entries.map(([port]) => port).filter((port) => !enabled.includes(port));
          if (missing.length) {
            return { rejected: `this reader has no antenna ${missing.join(', ')} — enabled ports are ${enabled.join(', ')}`, enabled };
          }
        }
      }
      let rc = 0;
      if (hasPer) {
        for (const [port, value] of entries) {
          const one = await uhf.setAntennaPower(port, value, true);
          rc |= one;
          if (one === 0) antennaPowerApplied[port] = value;
        }
      } else {
        rc = await uhf.setPower(dBm, true);
        for (const port of (await uhf.getAntennas()) || []) antennaPowerApplied[port] = dBm;
      }
      return { rc, dBm: await uhf.getPower() };
    });
    if (result.rejected) {
      // Put the gate back the way we found it before reporting the refusal.
      if (wasReading) {
        try {
          await controller.startReading();
        } catch (_) {
          /* reported below by /status */
        }
      }
      return res.status(400).json({ ok: false, error: result.rejected, enabled: result.enabled });
    }
    // Resume, so tuning power from the console does not silently leave the gate
    // stopped — the operator asked to change a setting, not to end the shift.
    if (wasReading && result.rc === 0) {
      try { await controller.startReading(); } catch (err) { controller.log(`could not resume reading: ${err.message}`, 'warn'); }
    }
    controller.log(
      hasPer
        ? `Antenna power set: ${entries.map(([p, v]) => `ant${p}=${v}dBm`).join(', ')} (rc=${result.rc}).`
        : `Read power set to ${result.dBm}dBm on every enabled antenna (rc=${result.rc}).`
    );
    res.json({ ok: result.rc === 0, ...result, applied: { ...antennaPowerApplied }, reading: controller.reading });
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

// --- single-tag access ------------------------------------------------------
// Encoding is done one tag at a time, and every write is addressed by TID so a
// neighbouring tag can never be the one programmed. These routes are the HTTP
// face of that; test/encode-tags.js is the batch tool built on the same calls.

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

// GET /tag  — singulate one tag and report PC + EPC (+ TID when readable).
app.get('/tag', async (_req, res) => {
  // awaits everywhere: the DLL driver is synchronous but the sidecar (Linux)
  // returns promises — `await` handles both.
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
// (save=false) — a bench power bump must not silently become the gate's setting.
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

app.get('/nexus/summary', (_req, res) => res.json({ ok: true, ...nexus.summary() }));
app.get('/nexus/inventory', (_req, res) => res.json({ ok: true, inventory: nexus.getInventory() }));
app.get('/nexus/events', (req, res) => res.json({ ok: true, events: nexus.getEvents(Number(req.query.limit) || 50) }));
/**
 * Wipe ALL local receiving state — the counterpart to resetting Nexus.
 *
 * Guarded by an explicit confirm string rather than a bare POST: undelivered
 * passages are real warehouse events, and this is the one endpoint that can
 * destroy them. A stray call from a dashboard bug must not be able to.
 */
app.post('/admin/wipe-local', (req, res) => {
  if (req.body?.confirm !== 'wipe') {
    return res.status(400).json({
      ok: false,
      error: 'refusing to wipe without confirmation',
      hint: 'POST {"confirm":"wipe"} — this destroys the movement queue, the delivery cursor, dead letters and pallet numbering',
    });
  }
  const outboxResult = outbox.wipeLocalState();
  nexus.reset();
  board.clearCache?.();
  controller.log('LOCAL STATE WIPED by /admin/wipe-local — queue, cursor, dead letters, pallet numbering and live inventory are all gone.', 'warn');
  // Reuse the EXISTING reset signal rather than inventing a second one. Every
  // screen already drops its local credits on this (see useGateBoard), and a
  // parallel message would mean two ways to say the same thing with only one of
  // them handled — which is how a board ends up still showing counts for
  // passages the bridge has forgotten.
  broadcast({ type: 'receiving-reset', epcs: [], count: 0, reasons: ['local wipe'], timestamp: new Date().toISOString() });
  res.json({ ok: true, ...outboxResult, note: 'catalogue and printer settings kept — neither is receiving state' });
});

app.post('/nexus/reset', (_req, res) => {
  nexus.reset();
  res.json({ ok: true, ...nexus.summary() });
});
app.post('/nexus/catalog/reload', async (_req, res) => {
  // Prefer the live registry; fall back to the cached file when offline.
  const remote = await nexus.loadCatalogRemote();
  const catalog = remote || nexus.loadCatalog();
  res.json({ ok: true, source: nexus.catalogSource, count: Object.keys(catalog).length, catalog });
});
// --- Board documents ----------------------------------------------------------
// Today's real receiving batches, already mapped into the kiosk's document
// shape. Receiving only — the shipping feed is deliberately not called; see
// bridge/src/board.js. Serves a disk-cached copy when Nexus is unreachable,
// flagged `stale` so the UI can say so rather than silently showing old counts.
// `delivery` rides along so the kiosk can tell whether Nexus has already
// absorbed the passages it counted locally. Without it the board cannot know
// when to stop adding its own overlay, and would double-count.
app.get('/board/documents', async (_req, res) => {
  const doc = await board.get();
  const ob = outbox.status();
  res.json({ ...doc, delivery: { queueDepth: ob.queueDepth, lastPushAt: ob.lastPushAt } });
});

app.get('/board/status', (_req, res) => res.json({ ok: true, ...board.status() }));

// --- Movement outbox routes -------------------------------------------------
app.get('/movement/status', (_req, res) =>
  res.json({ ok: true, ...outbox.status(), burnInUntil: BURN_IN_UNTIL || null, legacyDirectWrite: BURN_IN_ACTIVE })
);

// Operator Print is also the explicit pallet boundary. The outbox closes the
// durable session first; its batch-ready event then drives the local printer
// and Nexus delivery through the same path as the two-minute timeout.
app.post('/movement/pallet/close', (req, res) => {
  const result = outbox.closeTogglePallet({ requestId: req.body?.requestId, reason: 'operator-print' });
  if (!result.closed) return res.status(409).json({ ok: false, ...result });
  res.json({ ok: true, ...result });
});

// Re-push already-delivered history. Safe to run at any time and with any
// range — the ingest dedupes on physical passage time, so replaying the whole
// journal produces zero duplicate rows. This is the recovery path when the pump
// misbehaved: replay, don't reconstruct.
// Body: { fromSeq? } or { fromTimestamp? } (ISO). Omit both to replay everything.
app.post('/movement/replay', (req, res) => {
  const fromSeq = req.body?.fromSeq != null ? Number(req.body.fromSeq) : undefined;
  const fromTimestamp = req.body?.fromTimestamp || undefined;
  if (fromSeq != null && !Number.isFinite(fromSeq)) {
    return res.status(400).json({ ok: false, error: 'fromSeq must be a number' });
  }
  const requeued = outbox.replay({ fromSeq, fromTimestamp });
  controller.log(`[outbox] replay requeued ${requeued} event(s)`);
  res.json({ ok: true, requeued, ...outbox.status() });
});

app.post('/nexus/config', (req, res) => {
  const summary = nexus.setConfig(req.body || {});
  controller.log(
    `[nexus] config: detect=${summary.detectMode} dedup=${summary.dedupMs}ms quiet=${summary.quietMs}ms maxWindow=${summary.maxWindowMs}ms` +
      ` | no-IR: rearm=${summary.toggleDedupMs}ms absence=${summary.absenceMs}ms minRssi=${summary.minRssi ?? 'off'} minReads=${summary.toggleMinReads}`
  );
  res.json({ ok: true, ...summary });
});


/**
 * Compare the local clock against Nexus's Date response header. A drifting
 * warehouse PC writes wrong created_at values AND breaks the ±10s ingest
 * dedupe, producing duplicates and mis-ordered history that a replay cannot
 * fix — so it must be visible before it does damage, not after.
 */
async function reportClockOffset() {
  if (!process.env.NEXUS_URL) return;
  try {
    const res = await fetch(process.env.NEXUS_URL, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    const serverDate = res.headers.get('date');
    if (!serverDate) return;
    const skewMs = Date.now() - Date.parse(serverDate);
    if (Math.abs(skewMs) > 30_000) {
      controller.log(`CLOCK SKEW ${Math.round(skewMs / 1000)}s vs Nexus — fix Windows time sync before trusting gate timestamps.`, 'error');
    } else {
      controller.log(`Clock offset vs Nexus: ${Math.round(skewMs / 1000)}s.`);
    }
  } catch {
    // Offline at boot is the normal case this whole design exists for.
  }
}

// --- WebSocket ----------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/**
 * Heartbeat interval. Two jobs, and they are not the same job:
 *
 *   1. A protocol-level ping reaps sockets this process still thinks are open.
 *   2. An application-level {type:'ping'} gives the BROWSER something it can
 *      actually observe. A browser auto-answers protocol pings in the network
 *      layer and never tells page JavaScript, so a page has no way to notice a
 *      dead link from those alone.
 *
 * (2) is what stops a wallboard going silently stale. A WiFi drop, an access
 * point roam, or a TV waking from sleep can leave the connection half-open:
 * nothing arrives, but no close event ever fires, so the page waits forever for
 * movements that will never come and only a manual reload fixes it. With a
 * steady beat, silence is unambiguous — see the watchdog in useBridge.ts.
 */
const WS_HEARTBEAT_MS = 5000;

wss.on('connection', (ws) => {
  controller.log(`WS client connected (${wss.clients.size} total).`);
  // send a snapshot immediately
  ws.send(JSON.stringify({ type: 'status', ...controller.getStatus(), timestamp: new Date().toISOString() }));
  const openPallet = outbox.openPallet();
  if (openPallet) ws.send(JSON.stringify({ type: 'pallet-open', ...openPallet }));
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('close', () => controller.log(`WS client disconnected (${wss.clients.size} total).`));
});

const wsHeartbeat = setInterval(() => {
  for (const client of wss.clients) {
    // Missed the whole previous round trip — the socket is gone even if the OS
    // has not worked that out yet. Dropping it here keeps `clients` honest.
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    try {
      client.ping();
    } catch (_) {
      /* already tearing down */
    }
  }
  broadcast({ type: 'ping', timestamp: new Date().toISOString() });
}, WS_HEARTBEAT_MS);
wsHeartbeat.unref?.(); // never hold the process open on this alone

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

/**
 * Is the gate ARMED — i.e. should a read become a movement?
 *
 * Not the same question as "is a read arriving", which is why this exists.
 *
 *   manual/ir : the SDK inventory loop is the only source, so `reading` says it.
 *   hw        : the reader is armed to fire on its own GPI trigger and push over
 *               UDP. `reading` is deliberately FALSE in that mode (the bridge is
 *               not polling anything), so the mode itself is the answer.
 *
 * The case this closes: a reader left in HW mode keeps pushing UDP datagrams to
 * this process long after someone "stopped the gate" in the UI. The bridge went
 * on turning each one into a receipt — cartons detected, a pallet opened, stock
 * credited in Nexus — with the operator watching a stopped reader. A datagram
 * arriving while the bridge is in manual mode and not reading is a leftover from
 * a previous arming, not a carton crossing a doorway.
 *
 * Reads are still broadcast either way: the engineering console must keep
 * showing raw RF whatever the gate is doing. Only the MOVEMENT decision is
 * gated.
 */
function gateArmed() {
  return controller.mode === 'hw' ? true : Boolean(controller.reading);
}

let ignoredReads = 0;
let ignoredNotedAt = 0;
controller.on('message', (msg) => {
  broadcast(msg);
  if (msg.type === 'tag') {
    forwardToSupabase(msg);
    if (gateArmed()) {
      nexus.tagSeen(msg); // warehouse check-in (dedup + catalog inside)
    } else {
      // Rate-limited: a stuck reader can push hundreds a second, and the point
      // is that this is VISIBLE, not that every frame is logged.
      ignoredReads += 1;
      if (Date.now() - ignoredNotedAt > 10_000) {
        ignoredNotedAt = Date.now();
        controller.log(
          `[passage] ${ignoredReads} read(s) ignored — the gate is not armed ` +
            `(mode=${controller.mode}, reading=${controller.reading}). A reader left in HW mode keeps ` +
            `pushing UDP; those are not movements.`,
          'warn'
        );
        ignoredReads = 0;
      }
    }
  }
  if (msg.type === 'passage-end') outbox.flushPassage(msg.passageId);
});

app.post('/printer/print-pallet-tag', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await printer.printPalletTag(body);
    broadcast({ type: 'pallet-print', ok: true, timestamp: new Date().toISOString(), requestId: result.jobId, palletCode: result.palletCode, passageId: body.passageId ?? 'manual', cartonCount: Number(body.cartonCount) || 0, queued: Boolean(body.queued), replayed: result.replayed });
    res.json({ ok: true, ...result });
  } catch (err) {
    const body = req.body || {};
    broadcast({ type: 'pallet-print', ok: false, timestamp: new Date().toISOString(), requestId: body.jobId || `pallet:${body.palletCode || 'unknown'}`, palletCode: body.palletCode || 'UNKNOWN', passageId: body.passageId ?? 'manual', cartonCount: Number(body.cartonCount) || 0, queued: Boolean(body.queued), error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Make the pallet printer print its OWN config label (TSPL SELFTEST) — the only
// way to read its printhead dpi, which palletDpi must match.
app.post('/printer/pallet-selftest', async (_req, res) => {
  try {
    res.json({ ok: true, ...(await printer.palletSelfTest()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// One sample pallet tag on the CURRENT pallet config — the "did my dpi / offset
// / media settings come out right?" button. Uses a unique jobId per press so the
// idempotency guard (which exists to stop a real pallet printing twice) doesn't
// silently swallow a deliberate bench re-test.
app.post('/printer/pallet-test-tag', async (req, res) => {
  try {
    const body = req.body || {};
    const palletCode = String(body.palletCode || 'Pallet-TEST').trim();
    const result = await printer.printPalletTag({
      palletCode,
      jobId: `pallet-bench:${Date.now()}`,
      widthMm: body.widthMm,
      heightMm: body.heightMm,
      leftOffsetMm: body.leftOffsetMm,
      dpi: body.dpi,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- boot ---------------------------------------------------------------------
server.listen(PORT, () => {
  controller.log(`Bridge listening on http://localhost:${PORT}  (WS: ws://localhost:${PORT}/ws)`);
  controller.log(`Reader defaults: ${DEFAULT_IP}:${DEFAULT_PORT}. Supabase forwarding: ${SB_ENABLED ? 'ON' : 'off'}.`);

  const ob = outbox.status();
  if (!ob.configured) {
    controller.log('NEXUS_URL is unset — movements are journalled but never delivered. Set it to the /api/movement URL.', 'warn');
  } else {
    controller.log(`Movement push -> ${ob.url} (queued: ${ob.queueDepth}, dead: ${ob.deadLetters}).`);
  }
  if (BURN_IN_ACTIVE) {
    controller.log(`Push cutover burn-in until ${BURN_IN_UNTIL}: legacy direct Supabase write is ALSO active.`);
  } else if (BURN_IN_UNTIL) {
    controller.log(
      `Burn-in ended ${BURN_IN_UNTIL} — the legacy direct Supabase write is now inert. DELETE forwardMovementToSupabase and this notice.`,
      'warn'
    );
  }
  // Clock skew corrupts data no replay can repair: the event timestamp is both
  // the ingest dedupe key and the row's created_at. Surface the offset at boot.
  reportClockOffset();
  outbox.start();
  outbox.emitPendingBatches();
  board.start(); // warm the document cache so the first kiosk paint is instant

  // ...and keep it warm on the BRIDGE's own clock. Until now the board only
  // refreshed inside get(), i.e. only when a kiosk asked for it — fine while the
  // cache was just something to paint, but the gate now uses it to decide
  // whether an arriving carton has an open receiving batch (expectsInbound).
  // Hanging a safety check off "is a browser open somewhere" is wrong: on a
  // TV-only doorway nothing calls /board/documents at all, the board would age
  // past expectMaxAgeMs, and the check would quietly go back to passing
  // everything. This interval is what makes the verdict independent of the
  // screens.
  const BOARD_REFRESH_MS = Number(process.env.BOARD_REFRESH_MS || 60_000);
  if (BOARD_REFRESH_MS > 0) {
    setInterval(() => void board.load(), BOARD_REFRESH_MS).unref();
  }

  // Refresh the catalog from the live tag registry (falls back to the cached
  // data/catalog.json already loaded by the constructor).
  nexus.loadCatalogRemote();

  // ...and keep refreshing it. This used to be a boot-only load, which was fine
  // while the catalog was just EPC -> product name: a tag printed after boot
  // read as unregistered until someone restarted the bridge, and that was the
  // whole cost.
  //
  // It is no longer the whole cost. The catalog now also carries carton
  // WAREHOUSE state, and the gate refuses to present an exit as a dispatch when
  // that state says the carton was never received. On a boot-only load that
  // state is frozen at boot, so every carton received during the shift would
  // look un-received and every legitimate dispatch would alarm. The refresh is
  // what keeps the check honest — and _outboundCheck stops judging entirely
  // once the state is older than stateMaxAgeMs, so a failing refresh degrades
  // to silence rather than to false accusations.
  const CATALOG_REFRESH_MS = Number(process.env.NEXUS_CATALOG_REFRESH_MS || 120_000);
  if (CATALOG_REFRESH_MS > 0) {
    setInterval(() => void nexus.loadCatalogRemote(), CATALOG_REFRESH_MS).unref();
  }
  try {
    controller.start();
  } catch (err) {
    controller.log(`Failed to start controller: ${err.message}`, 'error');
  }
});

process.on('SIGINT', async () => {
  controller.log('Shutting down...');
  outbox.stop(); // journal is already durable; anything unsent resumes on boot
  await controller.stop();
  process.exit(0);
});
