'use strict';

/**
 * Thin wrapper around Chainway's UHFAPI.dll for the UR4 UHF RFID reader.
 *
 * Uses koffi (prebuilt FFI, no native compilation) to bind the C exports.
 * Signatures below are taken verbatim from the SDK:
 *   - Header:  UHF_LIB_20250829/Header/UHFAPI.h
 *   - Doc:     RFID_API_DLL_V1.0.3.doc  (function list + C# ReadTagFromBuffer sample)
 *
 * Design note: the SDK also offers callbacks (setOnDataReceived / setOnBytesReceived),
 * but those fire from the DLL's own network thread. Calling back into JS from a
 * foreign (non-libuv) thread is exactly what tends to crash Node FFI bindings, so we
 * deliberately use the POLLING model instead — mirroring the vendor's own C# sample,
 * which starts UHFInventory() and then loops on UHF_GetReceived_EX() from a worker.
 */

const path = require('path');
const koffi = require('koffi');

const LIB_DIR = path.join(__dirname, '..', 'lib');
const UHFAPI_PATH = path.join(LIB_DIR, 'UHFAPI.dll');
const LIBUSB_PATH = path.join(LIB_DIR, 'libusb-1.0.dll');

// UHFAPI.dll depends on libusb-1.0.dll. When Node loads UHFAPI.dll by absolute
// path, Windows resolves that dependency against the *process* search path, not
// the DLL's own folder. So we (1) put lib/ on PATH and (2) preload libusb first,
// which makes it resolvable by base name once UHFAPI.dll is loaded.
if (process.platform === 'win32') {
  process.env.PATH = LIB_DIR + path.delimiter + (process.env.PATH || '');
}

let lib = null;
let fns = null;

/** Load UHFAPI.dll and bind the exports we use. Idempotent. */
function load() {
  if (fns) return fns;

  try {
    koffi.load(LIBUSB_PATH); // preload dependency; ignore if already resolvable
  } catch (err) {
    console.warn(`[uhf] libusb preload warning: ${err.message}`);
  }

  lib = koffi.load(UHFAPI_PATH);

  fns = {
    // --- connection (doc 1510-1521) ---
    TCPConnect: lib.func('int TCPConnect(const char *hostaddr, int hostport)'),
    TCPDisconnect: lib.func('void TCPDisconnect()'),

    // --- inventory (doc 2231-2277) ---
    UHFInventory: lib.func('int UHFInventory()'),
    UHFStopGet: lib.func('int UHFStopGet()'),
    // rLen[out] gets the tag record length; rData[out] the record bytes (<=256).
    UHF_GetReceived_EX: lib.func('int UHF_GetReceived_EX(_Out_ int *rLen, uint8_t *rData)'),

    // --- info / diagnostics (header 127, 171) ---
    // version[0] = length, version[1..] = version bytes.
    UHFGetSoftwareVersion: lib.func('int UHFGetSoftwareVersion(uint8_t *version)'),
    UHFGetPower: lib.func('int UHFGetPower(uint8_t *uPower)'),

    // --- GPIO (header 1010-1011) ---
    // GPO *outputs* only: statusData[0]=GPO0, statusData[1]=GPO1 (doc 2029).
    UHFGetIOControl: lib.func('int UHFGetIOControl(uint8_t *statusData)'),
    // GPI *inputs* (IR sensor). Format undocumented -> we expose raw & calibrate.
    UHFGetIOStatus: lib.func('int UHFGetIOStatus(uint8_t *statusData, _Inout_ uint16_t *len)'),

    // --- work mode / hardware trigger (doc 2038-2073) ---
    // NOTE: mode 2 (trigger) outputs tags over serial/UDP only, NOT TCP, so we do
    // NOT use it for reading. Bound here for diagnostics / experimentation.
    UHFSetWorkMode: lib.func('int UHFSetWorkMode(uint8_t mode)'),
    UHFGetWorkMode: lib.func('int UHFGetWorkMode(uint8_t *mode)'),
    UHFSetWorkModePara: lib.func('int UHFSetWorkModePara(uint8_t *param)'),
    UHFGetWorkModePara: lib.func('int UHFGetWorkModePara(uint8_t *param)'),

    // --- logging (header 1220-1228) ---
    SetLogLevel: lib.func('void SetLogLevel(int level)'),
  };

  return fns;
}

// ---------------------------------------------------------------------------
// High-level helpers
// ---------------------------------------------------------------------------

let connected = false;

/**
 * Connect to the reader over TCP.
 * @returns {number} 0 on success, other = SDK error code.
 */
function connect(ip, port) {
  const f = load();
  const rc = f.TCPConnect(ip, port);
  connected = rc === 0;
  return rc;
}

function disconnect() {
  if (!fns) return;
  fns.TCPDisconnect();
  connected = false;
}

function isConnected() {
  return connected;
}

/** Start continuous inventory. @returns {number} 0 on success. */
function startInventory() {
  return load().UHFInventory();
}

/** Stop continuous inventory. @returns {number} 0 on success. */
function stopInventory() {
  return load().UHFStopGet();
}

/**
 * Drain ONE tag record from the reader's buffer.
 * @returns {object|null} parsed tag, or null when the buffer is currently empty.
 * Shape: { epc, pc, tid, user, antenna, rssi, raw }
 */
function pollTag() {
  const f = load();
  const rLen = [0]; // koffi _Out_ int*
  const rData = Buffer.alloc(256);

  const rc = f.UHF_GetReceived_EX(rLen, rData);
  if (rc !== 0) return null; // non-zero == no data available (or error)

  const len = rLen[0];
  if (len <= 0) return null;

  return parseTag(rData, len);
}

/**
 * Parse a raw UHF_GetReceived_EX record.
 * Layout (see doc 3625-3962, C# ReadTagFromBuffer):
 *   [0]                       uiiLen  (length of PC+EPC block, in bytes)
 *   [1..2]                    PC      (2 bytes)
 *   [3 .. uiiLen]             EPC     (uiiLen-2 bytes)
 *   [uiiLen+1]                tidLen
 *   [uiiLen+2 ..]             TID     (if tidLen>12: 12 bytes TID + rest USER)
 *   [uiiLen+tidLen+2 .. +3]   RSSI    (2 bytes BE) -> dBm = (v - 65535) / 10
 *   [uiiLen+tidLen+4]         antenna (1 byte)
 *
 * @param {Buffer} buf
 * @param {number} len  number of valid bytes in buf
 */
function parseTag(buf, len) {
  const rawHex = buf.subarray(0, len).toString('hex').toUpperCase();
  if (len < 1) return null;

  const uiiLen = buf[0];
  // uiiLen must cover the 2-byte PC and fit inside the record.
  if (uiiLen < 2 || 1 + uiiLen > len) {
    return { epc: null, pc: null, tid: null, user: null, antenna: null, rssi: null, raw: rawHex };
  }

  const pc = buf.subarray(1, 3);
  const epc = buf.subarray(3, 1 + uiiLen);

  const tidLenIdx = 1 + uiiLen;
  const tidLen = tidLenIdx < len ? buf[tidLenIdx] : 0;
  const tidStart = tidLenIdx + 1;

  let tid = Buffer.alloc(0);
  let user = Buffer.alloc(0);
  if (tidLen > 12) {
    tid = buf.subarray(tidStart, tidStart + 12);
    user = buf.subarray(tidStart + 12, tidStart + tidLen);
  } else if (tidLen >= 4) {
    // C# sample discards TID shorter than 4 bytes as noise.
    tid = buf.subarray(tidStart, tidStart + tidLen);
  }

  const rssiIdx = uiiLen + tidLen + 2;
  let rssi = null;
  if (rssiIdx + 1 < len) {
    const v = buf.readUInt16BE(rssiIdx);
    rssi = Math.round((v - 65535) / 10 * 10) / 10; // dBm, one decimal
  }

  const antIdx = rssiIdx + 2;
  const antenna = antIdx < len ? buf[antIdx] : null;

  return {
    epc: epc.length ? epc.toString('hex').toUpperCase() : null,
    pc: pc.toString('hex').toUpperCase(),
    tid: tid.length ? tid.toString('hex').toUpperCase() : null,
    user: user.length ? user.toString('hex').toUpperCase() : null,
    antenna,
    rssi,
    raw: rawHex,
  };
}

/** Read the reader's software version string (diagnostic round-trip). */
function getSoftwareVersion() {
  const f = load();
  const buf = Buffer.alloc(64);
  const rc = f.UHFGetSoftwareVersion(buf);
  if (rc !== 0) return null;
  const vlen = buf[0];
  return buf.subarray(1, 1 + vlen).toString('hex').toUpperCase();
}

function setLogLevel(level) {
  load().SetLogLevel(level);
}

/** Read current output power (dBm), or null on failure. */
function getPower() {
  const f = load();
  const buf = Buffer.alloc(4);
  const rc = f.UHFGetPower(buf);
  return rc === 0 ? buf[0] : null;
}

// ---------------------------------------------------------------------------
// GPIO / GPI (IR sensor) support
// ---------------------------------------------------------------------------

/**
 * GPI bit interpretation. UHFGetIOStatus's byte format is NOT documented, so
 * these are calibratable against the real reader (watch the `raw` field change
 * as the IR beam breaks, then adjust). Defaults are a reasonable first guess:
 * byte 0 -> GPI1, byte 1 -> GPI2, and a non-zero value means "beam broken".
 */
let gpiConfig = {
  gpi1Byte: 0,
  gpi2Byte: 1,
  activeHigh: true, // true => non-zero byte means "broken"; false => zero means "broken"
};

function setGpiConfig(partial) {
  gpiConfig = { ...gpiConfig, ...partial };
  return gpiConfig;
}

function getGpiConfig() {
  return { ...gpiConfig };
}

/** Raw read of UHFGetIOStatus. @returns {{rc:number, bytes:Buffer, raw:string}} */
function readIOStatus() {
  const f = load();
  const buf = Buffer.alloc(64);
  const len = [buf.length]; // _Inout_ uint16_t*
  const rc = f.UHFGetIOStatus(buf, len);
  let n = len[0] > 0 && len[0] <= buf.length ? len[0] : rc > 0 ? Math.min(rc, buf.length) : 0;
  const bytes = buf.subarray(0, n);
  return { rc, bytes, raw: bytes.toString('hex').toUpperCase() };
}

/**
 * Read GPI input state (for the IR sensor).
 * @returns {{gpi1:(boolean|null), gpi2:(boolean|null), raw:string, rc:number}}
 * gpi true = "beam broken" (per gpiConfig). null = byte not present in response.
 */
function getGpi() {
  const { rc, bytes, raw } = readIOStatus();
  const bit = (idx) => {
    if (idx == null || idx >= bytes.length) return null;
    const v = bytes[idx] !== 0;
    return gpiConfig.activeHigh ? v : !v;
  };
  return { gpi1: bit(gpiConfig.gpi1Byte), gpi2: bit(gpiConfig.gpi2Byte), raw, rc };
}

/** Raw read of GPO output states (statusData[0]=GPO0, [1]=GPO1). */
function getIOControl() {
  const f = load();
  const buf = Buffer.alloc(16);
  const rc = f.UHFGetIOControl(buf);
  return { rc, gpo0: buf[0], gpo1: buf[1], raw: buf.subarray(0, 2).toString('hex').toUpperCase() };
}

// ---------------------------------------------------------------------------
// Hardware work mode (diagnostics only — NOT used for reading; see notes above)
// ---------------------------------------------------------------------------

function getWorkMode() {
  const f = load();
  const buf = Buffer.alloc(1);
  const rc = f.UHFGetWorkMode(buf);
  return rc === 0 ? buf[0] : null;
}

function setWorkMode(mode) {
  return load().UHFSetWorkMode(mode);
}

/**
 * Configure hardware trigger params.
 * @param {number} ioTrigger  0 = input 1 (GPI1), 1 = input 2 (GPI2)
 * @param {number} durationMs trigger work duration (ms)
 * @param {number} minGapMs   min gap since last trigger (ms)
 * @param {number} outputMode 0 = serial, 1 = UDP (NOT TCP)
 */
function setWorkModePara(ioTrigger, durationMs, minGapMs, outputMode) {
  const dur = Math.round(durationMs / 10); // unit = 10ms, high byte first
  const gap = Math.round(minGapMs / 10);
  const param = Buffer.from([
    ioTrigger & 0xff,
    (dur >> 8) & 0xff,
    dur & 0xff,
    (gap >> 8) & 0xff,
    gap & 0xff,
    outputMode & 0xff,
  ]);
  return load().UHFSetWorkModePara(param);
}

module.exports = {
  load,
  connect,
  disconnect,
  isConnected,
  startInventory,
  stopInventory,
  pollTag,
  parseTag,
  getSoftwareVersion,
  getPower,
  setLogLevel,
  // GPIO / IR
  readIOStatus,
  getGpi,
  getIOControl,
  setGpiConfig,
  getGpiConfig,
  // hardware work mode (diagnostics)
  getWorkMode,
  setWorkMode,
  setWorkModePara,
  paths: { LIB_DIR, UHFAPI_PATH, LIBUSB_PATH },
};
