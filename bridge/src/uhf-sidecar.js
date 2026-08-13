'use strict';

/**
 * Sidecar driver: same surface as uhf.js (the DLL driver), but every call is
 * an HTTP request to the Java sidecar (bridge/sidecar/UhfSidecar.java), which
 * wraps the vendor's pure-Java SDK. This is the driver that runs on Linux /
 * Raspberry Pi where the Windows DLL cannot.
 *
 * Differences from the DLL driver:
 *   - all functions are async (callers already run them inside awaited locks)
 *   - capabilities.hw = false: HW trigger mode (work mode 2 + UDP push) is
 *     not implemented in the sidecar yet — IR (bridge) and manual modes only.
 *   - drainTags() replaces the pollTag() loop: tags accumulate in the
 *     sidecar's queue and are fetched in batches.
 */

const { spawn } = require('child_process');
const path = require('path');

const SIDECAR_URL = process.env.UHF_SIDECAR_URL || 'http://127.0.0.1:3010';
const SIDECAR_DIR = path.join(__dirname, '..', 'sidecar');
const JAR = 'ReaderAPI20240822.jar';

const capabilities = { hw: false, ioStatusDebug: false };

let child = null;

async function call(method, pathname, params = {}) {
  const url = new URL(pathname, SIDECAR_URL);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  const res = await fetch(url, { method });
  return res.json();
}

/** Spawn the Java sidecar if nothing is listening yet. Idempotent. */
async function ensureSidecar() {
  try {
    await call('GET', '/status');
    return; // already up
  } catch (_) {
    /* not running — spawn it */
  }
  const sep = process.platform === 'win32' ? ';' : ':';
  child = spawn('java', ['-cp', `${JAR}${sep}.`, 'UhfSidecar', String(new URL(SIDECAR_URL).port || 3010)], {
    cwd: SIDECAR_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => console.log(`[sidecar] ${String(d).trim()}`));
  child.stderr.on('data', (d) => console.error(`[sidecar] ${String(d).trim()}`));
  child.on('exit', (code) => {
    console.error(`[sidecar] exited with code ${code}`);
    child = null;
  });
  // wait for it to come up
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      await call('GET', '/status');
      return;
    } catch (_) {
      /* retry */
    }
  }
  throw new Error('sidecar did not start (is java on PATH? jar compiled?)');
}

function load() {
  return ensureSidecar();
}

async function connect(ip, port) {
  await ensureSidecar();
  const r = await call('POST', '/connect', { ip, port });
  return r.ok ? 0 : 2; // mimic SDK rc: 0 ok, 2 connect failure
}

async function disconnect() {
  try {
    await call('POST', '/disconnect');
  } catch (_) {
    /* sidecar gone = disconnected enough */
  }
}

async function startInventory() {
  const r = await call('POST', '/inventory/start');
  return r.ok ? 0 : -1;
}

async function stopInventory() {
  const r = await call('POST', '/inventory/stop');
  return r.ok ? 0 : -1;
}

/** Fetch up to max tags. Returns uhf.js-shaped tag objects. */
async function drainTags(max = 100) {
  const r = await call('GET', '/tags', { max });
  if (!r.ok || !Array.isArray(r.tags)) return [];
  return r.tags.map((t) => ({
    epc: t.epc ? String(t.epc).toUpperCase() : null,
    pc: t.pc || null,
    tid: t.tid || null,
    user: t.user || null,
    antenna: t.ant != null ? parseInt(t.ant, 10) : null,
    rssi: t.rssi != null ? parseFloat(t.rssi) : null,
    raw: null, // sidecar delivers parsed tags; no raw frame
  }));
}

/**
 * GPI read. Sidecar reports state 0/1 per input; on this hardware GPI1 idles
 * HIGH (beam clear) and drops LOW when broken -> broken = state 0.
 */
async function getGpi() {
  try {
    const r = await call('GET', '/gpi');
    if (!r.ok || !Array.isArray(r.gpi)) return { gpi1: null, gpi2: null, raw: '', rc: -1 };
    const byName = {};
    for (const g of r.gpi) byName[g.name] = g.state;
    const broken = (s) => (s == null ? null : s === 0);
    const raw = r.gpi.map((g) => String(g.state).padStart(2, '0')).join('');
    return { gpi1: broken(byName.GPI1), gpi2: broken(byName.GPI2), raw, rc: 0 };
  } catch (_) {
    return { gpi1: null, gpi2: null, raw: '', rc: -1 };
  }
}

async function getPower() {
  const r = await call('GET', '/power');
  if (!r.ok || !Array.isArray(r.power) || !r.power.length) return null;
  return r.power[0].dbm;
}

async function setPower(dBm) {
  const ants = (await getAntennas()) || [1];
  const r = await call('POST', '/power', { dbm: dBm, ants: ants.join(',') });
  return r.ok ? 0 : -1;
}

async function getAntennas() {
  const r = await call('GET', '/antennas');
  return r.ok ? r.enabled : null;
}

async function setAntennas(ports) {
  const r = await call('POST', '/antennas', { ports: ports.join(',') });
  return r.ok ? 0 : -1;
}

async function getAntennaLink() {
  return null; // not exposed by the Java SDK's network API
}

async function getWorkMode() {
  const r = await call('GET', '/workmode');
  return r.ok ? r.mode : null;
}

async function setWorkMode(mode) {
  const r = await call('POST', '/workmode', { mode });
  return r.ok ? 0 : -1;
}

async function getSoftwareVersion() {
  try {
    const r = await call('GET', '/version');
    return r.version || null;
  } catch (_) {
    return null;
  }
}

function setLogLevel() {}

// --- single-tag access (read / write / singulate) ---------------------------
// Same surface + shapes as uhf.js so server.js's /tag routes work unchanged on
// Linux. Filters are the same { bank, startBit, data:Buffer } objects; the
// sidecar receives them as fbank/fptr(bits)/fdata(hex) query params.

const BANK = { RESERVED: 0, EPC: 1, TID: 2, USER: 3 };
const EPC_DATA_PTR = 2;
const EPC_FILTER_BIT_OFFSET = 32; // CRC(16) + PC(16)

function hexToBuf(hex, label) {
  const clean = String(hex ?? '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error(`${label}: odd number of hex digits ("${hex}")`);
  return Buffer.from(clean, 'hex');
}

function filterByTid(tidHex) {
  const data = hexToBuf(tidHex, 'filterByTid');
  if (!data.length) throw new Error('filterByTid: empty TID');
  return { bank: BANK.TID, startBit: 0, data };
}

function filterByEpc(epcHex, startBit = EPC_FILTER_BIT_OFFSET) {
  const data = hexToBuf(epcHex, 'filterByEpc');
  if (!data.length) throw new Error('filterByEpc: empty EPC');
  return { bank: BANK.EPC, startBit, data };
}

function filterParams(filter) {
  if (!filter) return {};
  return {
    fbank: filter.bank,
    fptr: filter.startBit,
    fdata: filter.data.toString('hex').toUpperCase(),
  };
}

/** @returns {{rc:number, hex:(string|null), bytes:(Buffer|null)}} — mirrors uhf.js */
async function readBank({ bank, ptr = 0, words = 1, filter = null, accessPwd } = {}) {
  const r = await call('POST', '/tag/read', { bank, ptr, words, pwd: accessPwd, ...filterParams(filter) });
  if (!r.ok || !r.hex) return { rc: -1, hex: null, bytes: null };
  const hex = String(r.hex).toUpperCase();
  return { rc: 0, hex, bytes: Buffer.from(hex, 'hex') };
}

/** @returns {number} 0 on success — mirrors uhf.js */
async function writeBank({ bank, ptr = 0, dataHex, filter = null, accessPwd } = {}) {
  const clean = String(dataHex ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!clean.length) throw new Error('writeBank: no data');
  if (clean.length % 4 !== 0) throw new Error(`writeBank: data must be whole 16-bit words (got ${clean.length / 2} bytes)`);
  const r = await call('POST', '/tag/write', { bank, ptr, data: clean, pwd: accessPwd, ...filterParams(filter) });
  return r.ok ? 0 : -1;
}

/** Singulate ONE tag. @returns {{pc:string, epc:string, raw:string}|null} */
async function inventorySingle() {
  const r = await call('GET', '/tag/single');
  if (!r.ok || !r.tag || !r.tag.epc) return null;
  const pc = String(r.tag.pc || '').toUpperCase();
  const epc = String(r.tag.epc).toUpperCase();
  return { pc, epc, raw: pc + epc };
}

/** EPC length in 16-bit words, as declared by a PC word (pure JS, same as uhf.js). */
function epcWordsFromPc(pcHex) {
  const buf = hexToBuf(pcHex, 'epcWordsFromPc');
  if (buf.length !== 2) return null;
  return buf.readUInt16BE(0) >> 11;
}

/** Liveness for _pollAlive: the reader answers a version query or it is gone. */
async function isReaderAlive() {
  return Boolean(await getSoftwareVersion());
}

const unsupported = (name) => () => {
  throw new Error(`${name} not supported by the sidecar driver (DLL driver only)`);
};

module.exports = {
  capabilities,
  load,
  connect,
  connectUsb: () => {
    throw new Error('USB readers need the DLL driver (Windows) — connect over TCP on Linux');
  },
  disconnect,
  isConnected: () => true, // controller tracks its own state
  isReaderAlive,
  startInventory,
  stopInventory,
  drainTags,
  getGpi,
  getPower,
  setPower,
  getAntennas,
  setAntennas,
  getAntennaLink,
  getWorkMode,
  setWorkMode,
  getSoftwareVersion,
  setLogLevel,
  // single-tag access (encode/read/write) — served by the Java sidecar
  BANK,
  EPC_DATA_PTR,
  filterByTid,
  filterByEpc,
  readBank,
  writeBank,
  inventorySingle,
  epcWordsFromPc,
  // debug/HW-mode surface not available via sidecar:
  readIOStatus: async () => null, // /debug/io still answers (gpi only) on Linux
  getIOControl: unsupported('getIOControl'),
  setGpiConfig: () => ({}),
  getGpiConfig: () => ({ source: 'sidecar' }),
  setWorkModePara: unsupported('setWorkModePara'),
  getWorkModePara: async () => null,
  setDestIp: unsupported('setDestIp'),
  getDestIp: async () => null,
  bindUdp: unsupported('bindUdp'),
  unbindUdp: () => {},
  parseUdpDatagram: () => null,
  getWorkTime: async () => null,
  setWorkTime: unsupported('setWorkTime'),
  setReaderIp: unsupported('setReaderIp'),
  getReaderIp: async () => null,
};
