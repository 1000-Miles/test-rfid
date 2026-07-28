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
    // USB desktop readers (e.g. Chainway R1): open/close the connected USB device.
    UsbOpen: lib.func('int UsbOpen()'),
    UsbClose: lib.func('void UsbClose()'),

    // --- inventory (doc 2231-2277) ---
    UHFInventory: lib.func('int UHFInventory()'),
    UHFStopGet: lib.func('int UHFStopGet()'),
    // rLen[out] gets the tag record length; rData[out] the record bytes (<=256).
    UHF_GetReceived_EX: lib.func('int UHF_GetReceived_EX(_Out_ int *rLen, uint8_t *rData)'),

    // --- info / diagnostics (header 127, 171) ---
    // version[0] = length, version[1..] = version bytes.
    UHFGetSoftwareVersion: lib.func('int UHFGetSoftwareVersion(uint8_t *version)'),
    UHFGetPower: lib.func('int UHFGetPower(uint8_t *uPower)'),
    // save: 1 = persist across power cycles. uPower in dBm (UR4 max 30).
    UHFSetPower: lib.func('int UHFSetPower(uint8_t save, uint8_t uPower)'),

    // --- antennas (vendor UHFAPI.cs 1266): 2-byte bitmask, buf[1] bit0=ANT1 ---
    UHFSetANT: lib.func('int UHFSetANT(uint8_t saveflag, const uint8_t *buf)'),
    UHFGetANT: lib.func('int UHFGetANT(uint8_t *buf)'),
    UHFGetAntennaLinkStatus: lib.func('int UHFGetAntennaLinkStatus(int16_t *buf)'),

    // --- GPIO (header 1010-1011) ---
    // GPO *outputs* only: statusData[0]=GPO0, statusData[1]=GPO1 (doc 2029).
    UHFGetIOControl: lib.func('int UHFGetIOControl(uint8_t *statusData)'),
    // GPI *inputs* (IR sensor). Vendor UR4Demo source: len is int*, and the
    // payload layout is [?, GPI1, ?, GPI2, ...] (GetInputStatus uses temp[1]
    // and temp[3]).
    UHFGetIOStatus: lib.func('int UHFGetIOStatus(uint8_t *statusData, _Inout_ int *len)'),

    // --- work mode / hardware trigger (doc 2038-2073) ---
    // NOTE: mode 2 (trigger) outputs tags over serial/UDP only, NOT TCP, so we do
    // NOT use it for reading. Bound here for diagnostics / experimentation.
    UHFSetWorkMode: lib.func('int UHFSetWorkMode(uint8_t mode)'),
    UHFGetWorkMode: lib.func('int UHFGetWorkMode(uint8_t *mode)'),
    UHFSetWorkModePara: lib.func('int UHFSetWorkModePara(uint8_t *param)'),
    UHFGetWorkModePara: lib.func('int UHFGetWorkModePara(uint8_t *param)'),

    // --- UDP active output (doc V1.0.1 "UHFSetDestIp") ---
    // In trigger work mode with param[5]=1 the reader pushes tag data via UDP
    // to this destination. Doc claims C strings, but hardware readback proves
    // BINARY: ip = 4 octets, port = 2 bytes (passing "192.168.99.100"/"9090"
    // stored ip=31 39 32 2E "192." and port=39 30 "90").
    UHFSetDestIp: lib.func('int UHFSetDestIp(const uint8_t *ip, const uint8_t *port)'),
    UHFGetDestIp: lib.func('int UHFGetDestIp(uint8_t *ip, uint8_t *port)'),
    // Reader's own static IP config (vendor UHFAPI.cs 42): all binary —
    // ip 4 octets, port 2 bytes BE, mask 4 octets, gateway 4 octets.
    UHFSetIp: lib.func('int UHFSetIp(const uint8_t *ip, const uint8_t *port, const uint8_t *mask, const uint8_t *gate)'),
    UHFGetIp: lib.func('int UHFGetIp(uint8_t *ip, uint8_t *port, uint8_t *mask, uint8_t *gate)'),

    // DLL-side UDP receiver (vendor ReceiveEPC.cs): BindUDP opens a socket
    // inside the DLL; pushed frames land in the same buffer that
    // UHF_GetReceived_EX drains. No TCP connection required for the data path.
    BindUDP: lib.func('int BindUDP(int bindport)'),
    UnbindUDP: lib.func('void UnbindUDP()'),

    // --- continuous-read work/wait times (vendor UHFAPI.cs 636) ---
    // Governs standalone reading cycles (auto/trigger modes): read for
    // workTime ms, pause waitTime ms. work/wait are 2 bytes each, high first.
    UHFSetWorkTime: lib.func('int UHFSetWorkTime(uint8_t save, uint8_t work1, uint8_t work2, uint8_t wait1, uint8_t wait2)'),
    UHFGetWorkTime: lib.func('int UHFGetWorkTime(uint8_t *data)'),

    // --- logging (header 1220-1228) ---
    SetLogLevel: lib.func('void SetLogLevel(int level)'),
  };

  return fns;
}

// ---------------------------------------------------------------------------
// High-level helpers
// ---------------------------------------------------------------------------

let connected = false;
let linkType = null; // 'tcp' | 'usb' — so disconnect() closes the right transport

/**
 * Connect to the reader over TCP (network readers, e.g. UR4).
 * @returns {number} 0 on success, other = SDK error code.
 */
function connect(ip, port) {
  const f = load();
  const rc = f.TCPConnect(ip, port);
  connected = rc === 0;
  if (connected) linkType = 'tcp';
  return rc;
}

/**
 * Open the connected USB reader (desktop readers, e.g. Chainway R1). Same DLL,
 * same inventory/poll path as TCP — only the transport differs.
 * @returns {number} 0 on success, other = SDK error code.
 */
function connectUsb() {
  const f = load();
  const rc = f.UsbOpen();
  connected = rc === 0;
  if (connected) linkType = 'usb';
  return rc;
}

function disconnect() {
  if (!fns) return;
  if (linkType === 'usb') fns.UsbClose();
  else fns.TCPDisconnect();
  connected = false;
  linkType = null;
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

/**
 * Best-effort parse of a UDP datagram pushed by the reader in trigger/auto
 * work mode. The wire format is NOT documented, so we scan for the same
 * record layout UHF_GetReceived_EX uses (uiiLen + PC + EPC + tidLen + TID
 * + RSSI + antenna) at small offsets, in case the datagram carries a
 * protocol header/trailer around it. Returns { ...tag, offset } or null;
 * callers always get the raw hex separately for calibration.
 */
function parseUdpDatagram(buf) {
  const maxOffset = Math.min(8, buf.length - 7);
  for (let off = 0; off <= maxOffset; off++) {
    const uiiLen = buf[off];
    if (uiiLen < 4 || uiiLen > 66) continue; // PC(2) + EPC(2..64)
    const tidLenIdx = off + 1 + uiiLen;
    if (tidLenIdx >= buf.length) continue;
    const tidLen = buf[tidLenIdx];
    // record ends at uiiLen + tidLen + 5 relative to off; allow <=4 trailing
    // bytes (checksum/frame end) but no truncation.
    const end = off + uiiLen + tidLen + 5;
    if (end > buf.length || buf.length - end > 4) continue;
    const tag = parseTag(buf.subarray(off), end - off);
    if (tag && tag.epc) return { ...tag, offset: off };
  }
  return null;
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

/** Set output power in dBm (UR4: 1..30). @returns {number} 0 on success. */
function setPower(dBm, save = true) {
  return load().UHFSetPower(save ? 1 : 0, Number(dBm) & 0xff);
}

/** Enable a set of antenna ports, e.g. setAntennas([1,2]). @returns 0 on success. */
function setAntennas(ports, save = true) {
  let mask = 0;
  for (const p of ports) {
    if (p < 1 || p > 16) throw new Error(`setAntennas: bad port ${p}`);
    mask |= 1 << (p - 1);
  }
  // buf[0] = ANT16..ANT9, buf[1] = ANT8..ANT1
  const buf = Buffer.from([(mask >> 8) & 0xff, mask & 0xff]);
  return load().UHFSetANT(save ? 1 : 0, buf);
}

/** Read enabled antenna ports. @returns {number[]|null} e.g. [1,2] */
function getAntennas() {
  const f = load();
  const buf = Buffer.alloc(4);
  const rc = f.UHFGetANT(buf);
  if (rc !== 0) return null;
  const mask = (buf[0] << 8) | buf[1];
  const ports = [];
  for (let p = 1; p <= 16; p++) if (mask & (1 << (p - 1))) ports.push(p);
  return ports;
}

/** Which antenna ports have an antenna physically connected. @returns {number[]|null} */
function getAntennaLink() {
  const f = load();
  const buf = Buffer.alloc(64); // int16 per vendor sig; generous
  const rc = f.UHFGetAntennaLinkStatus(buf);
  if (rc !== 0) return null;
  const mask = buf.readInt16LE(0);
  const ports = [];
  for (let p = 1; p <= 16; p++) if (mask & (1 << (p - 1))) ports.push(p);
  return ports;
}

/** Read standalone work/wait cycle times (ms). @returns {{workMs,waitMs}|null} */
function getWorkTime() {
  const f = load();
  const buf = Buffer.alloc(8);
  const rc = f.UHFGetWorkTime(buf);
  if (rc !== 0) return null;
  return { workMs: buf.readUInt16BE(0), waitMs: buf.readUInt16BE(2), raw: buf.subarray(0, 4).toString('hex').toUpperCase() };
}

/** Set standalone work/wait cycle times (ms). */
function setWorkTime(workMs, waitMs, save = true) {
  const w = Math.max(0, Math.min(65535, Math.round(workMs)));
  const g = Math.max(0, Math.min(65535, Math.round(waitMs)));
  return load().UHFSetWorkTime(save ? 1 : 0, (w >> 8) & 0xff, w & 0xff, (g >> 8) & 0xff, g & 0xff);
}

// ---------------------------------------------------------------------------
// GPIO / GPI (IR sensor) support
// ---------------------------------------------------------------------------

/**
 * GPI interpretation, from the vendor UR4Demo source ("GPIO Of UR4" region):
 * on the UR4, GPI inputs are read via UHFGetIOControl — byte 0 = GPI1 level,
 * byte 1 = GPI2 level (0 = low, 1 = high). (UHFGetIOStatus with bytes 1/3 is
 * the UR1A path; the SDK doc describes UHFGetIOControl as GPO readback —
 * both wrong for UR4.)
 * source: 'iocontrol' (UR4) | 'iostatus' (UR1A). Calibratable live via
 * /debug/gpi-config: whether "beam broken" is high or low depends on the IR
 * sensor's output type (NPN/PNP).
 */
let gpiConfig = {
  source: 'iocontrol',
  gpi1Byte: 0,
  gpi2Byte: 1,
  // Hardware-calibrated 2026-07-06: GPI1 idles HIGH (beam clear = 01), drops
  // LOW while the beam is broken -> "broken" is the ZERO state.
  activeHigh: false, // true => non-zero byte means "broken"; false => zero means "broken"
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
  let rc, bytes, raw;
  if (gpiConfig.source === 'iostatus') {
    ({ rc, bytes, raw } = readIOStatus());
  } else {
    const f = load();
    const buf = Buffer.alloc(16);
    rc = f.UHFGetIOControl(buf);
    bytes = rc === 0 ? buf.subarray(0, 2) : Buffer.alloc(0);
    raw = bytes.toString('hex').toUpperCase();
  }
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
/**
 * Set the UDP destination the reader pushes tags to in trigger/auto work mode.
 * ip = dotted string, port = number. Encoded as 4 binary octets + 2 bytes
 * big-endian (high byte first, like the work-mode params).
 */
function setDestIp(ip, port) {
  const octets = String(ip).split('.').map((n) => parseInt(n, 10));
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`setDestIp: bad ip "${ip}"`);
  }
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`setDestIp: bad port "${port}"`);
  return load().UHFSetDestIp(Buffer.from(octets), Buffer.from([(p >> 8) & 0xff, p & 0xff]));
}

/** Read back the configured UDP destination. @returns {{ip,port,rawIp,rawPort}|null} */
function getDestIp() {
  const f = load();
  const ip = Buffer.alloc(16);
  const port = Buffer.alloc(8);
  const rc = f.UHFGetDestIp(ip, port);
  if (rc !== 0) return null;
  return {
    ip: `${ip[0]}.${ip[1]}.${ip[2]}.${ip[3]}`,
    port: (port[0] << 8) | port[1],
    rawIp: ip.subarray(0, 4).toString('hex').toUpperCase(),
    rawPort: port.subarray(0, 2).toString('hex').toUpperCase(),
  };
}

const ipToBytes = (ip, label) => {
  const o = String(ip).split('.').map((n) => parseInt(n, 10));
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error(`bad ${label}: ${ip}`);
  return Buffer.from(o);
};

/** Set the READER's own static IP/port/mask/gateway. Takes effect after reboot. */
function setReaderIp(ip, port, mask, gateway) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`bad port: ${port}`);
  return load().UHFSetIp(
    ipToBytes(ip, 'ip'),
    Buffer.from([(p >> 8) & 0xff, p & 0xff]),
    ipToBytes(mask, 'mask'),
    ipToBytes(gateway, 'gateway')
  );
}

/** Read the reader's static IP config. @returns {{ip,port,mask,gateway}|null} */
function getReaderIp() {
  const f = load();
  const ip = Buffer.alloc(8);
  const port = Buffer.alloc(4);
  const mask = Buffer.alloc(8);
  const gate = Buffer.alloc(8);
  const rc = f.UHFGetIp(ip, port, mask, gate);
  if (rc !== 0) return null;
  const dot = (b) => `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
  return { ip: dot(ip), port: (port[0] << 8) | port[1], mask: dot(mask), gateway: dot(gate) };
}

/** Open the DLL's own UDP receive socket. @returns {number} 0 on success. */
function bindUdp(port) {
  return load().BindUDP(Number(port));
}

function unbindUdp() {
  if (fns) fns.UnbindUDP();
}

/** Read back trigger work mode params. @returns parsed object or null. */
function getWorkModePara() {
  const f = load();
  const buf = Buffer.alloc(16);
  const rc = f.UHFGetWorkModePara(buf);
  if (rc !== 0) return null;
  return {
    ioTrigger: buf[0], // 0 = input 1 (GPI1), 1 = input 2
    durationMs: buf.readUInt16BE(1) * 10,
    minGapMs: buf.readUInt16BE(3) * 10,
    outputMode: buf[5], // 0 = serial, 1 = UDP
    raw: buf.subarray(0, 6).toString('hex').toUpperCase(),
  };
}

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
  connectUsb,
  disconnect,
  isConnected,
  startInventory,
  stopInventory,
  pollTag,
  parseTag,
  getSoftwareVersion,
  getPower,
  setPower,
  getWorkTime,
  setWorkTime,
  setAntennas,
  getAntennas,
  getAntennaLink,
  setLogLevel,
  // GPIO / IR
  readIOStatus,
  getGpi,
  getIOControl,
  setGpiConfig,
  getGpiConfig,
  // hardware work mode / UDP active output
  getWorkMode,
  setWorkMode,
  setWorkModePara,
  getWorkModePara,
  setDestIp,
  getDestIp,
  parseUdpDatagram,
  bindUdp,
  unbindUdp,
  setReaderIp,
  getReaderIp,
  paths: { LIB_DIR, UHFAPI_PATH, LIBUSB_PATH },
};
