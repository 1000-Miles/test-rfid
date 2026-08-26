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
    // USB desktop readers (e.g. Chainway R1/R3): open/close the connected USB device.
    UsbOpen: lib.func('int UsbOpen()'),
    UsbClose: lib.func('void UsbClose()'),
    UsbReadDeviceInfo: lib.func('int UsbReadDeviceInfo(_Out_ char *info, int len)'),
    // Serial transport. Desktop readers that expose a USB-CDC virtual COM port
    // (rather than the libusb path UsbOpen uses) connect through here instead.
    ComOpen: lib.func('int ComOpen(int port)'),
    ComOpenWithBaud: lib.func('int ComOpenWithBaud(int port, int baudrate)'),
    ClosePort: lib.func('void ClosePort()'),

    // --- inventory (doc 2231-2277) ---
    UHFInventory: lib.func('int UHFInventory()'),
    UHFStopGet: lib.func('int UHFStopGet()'),
    // rLen[out] gets the tag record length; rData[out] the record bytes (<=256).
    UHF_GetReceived_EX: lib.func('int UHF_GetReceived_EX(_Out_ int *rLen, uint8_t *rData)'),

    // --- single-tag access (header 421-501) -----------------------------------
    // Every one of these takes a Gen2 SELECT filter up front, so an operation can
    // be addressed at ONE chip instead of "whichever tag answers first":
    //   FilterBank      1=EPC, 2=TID, 3=USER   (0 is not a valid filter bank)
    //   FilterStartaddr bit offset WITHIN that bank
    //   FilterLen       mask length in BITS; 0 = no filter (any tag may answer)
    // and then address the operation itself:
    //   uBank           0=RESERVED, 1=EPC, 2=TID, 3=USER (vendor demo BankPicker)
    //   uPtr / uCnt     offset + length in WORDS (16-bit), not bytes
    // Note uCnt is uint32 on read but uint8 on write — that asymmetry is the
    // vendor's, not a typo.
    UHFReadData: lib.func(
      'int UHFReadData(const uint8_t *uAccessPwd, uint8_t FilterBank, uint32_t FilterStartaddr, uint32_t FilterLen, const uint8_t *FilterData,' +
        ' uint8_t uBank, uint32_t uPtr, uint32_t uCnt, _Out_ uint8_t *uReadDatabuf, _Out_ uint32_t *uReadDataLen)'
    ),
    UHFWriteData: lib.func(
      'int UHFWriteData(const uint8_t *uAccessPwd, uint8_t FilterBank, uint32_t FilterStartaddr, uint32_t FilterLen, const uint8_t *FilterData,' +
        ' uint8_t uBank, uint32_t uPtr, uint8_t uCnt, const uint8_t *uWriteDatabuf)'
    ),
    // Returns C++ `bool` (1 byte in AL). Bound as uint8_t so we read AL rather
    // than a full EAX whose upper bits MSVC leaves undefined.
    UHFLockTag: lib.func(
      'uint8_t UHFLockTag(const uint8_t *uAccessPwd, uint8_t FilterBank, uint32_t FilterStartaddr, uint32_t FilterLen, const uint8_t *FilterData,' +
        ' const uint8_t *lockbuf)'
    ),
    // One-shot singulation: rLrn[0] = UII byte length, rData = PC + EPC.
    UHFInventorySingle: lib.func('int UHFInventorySingle(_Out_ uint8_t *rLrn, _Out_ uint8_t *rData)'),
    // Persistent inventory filter (separate from the per-operation filters above).
    UHFSetFilter: lib.func('int UHFSetFilter(uint8_t saveflag, uint8_t bank, uint32_t startaddr, uint32_t datalen, const uint8_t *databuf)'),

    // --- info / diagnostics (header 89-111, 127, 171) ---
    // version[0] = length, version[1..] = version bytes.
    UHFGetSoftwareVersion: lib.func('int UHFGetSoftwareVersion(uint8_t *version)'),
    UHFGetHardwareVersion: lib.func('int UHFGetHardwareVersion(_Out_ uint8_t *version)'),
    UHFGetReaderVersion: lib.func('int UHFGetReaderVersion(_Out_ uint8_t *version)'),
    UHFGetDeviceID: lib.func('int UHFGetDeviceID(_Out_ uint32_t *id)'),
    UHFGetTemperature: lib.func('int UHFGetTemperature(_Out_ uint32_t *temperature)'),
    // region: 0x01 China1, 0x02 China2, 0x04 Europe, 0x08 USA, 0x16 Korea, 0x32 Japan
    UHFSetRegion: lib.func('int UHFSetRegion(uint8_t saveflag, uint8_t region)'),
    UHFGetRegion: lib.func('int UHFGetRegion(_Out_ uint8_t *region)'),
    // type: 0x00 ISO18000-6C, 0x01 GB/T 29768, 0x02 GJB 7377.1
    UHFGetProtocolType: lib.func('int UHFGetProtocolType(_Out_ uint8_t *type)'),
    // mode: 0 DSB_ASK/FM0/40k, 1 PR_ASK/Miller4/250k, 2 PR_ASK/Miller4/300k, 3 DSB_ASK/FM0/400k
    UHFGetRFLink: lib.func('int UHFGetRFLink(_Out_ uint8_t *uMode)'),
    UHFGetPower: lib.func('int UHFGetPower(uint8_t *uPower)'),
    // save: 1 = persist across power cycles. uPower in dBm (UR4 max 30).
    UHFSetPower: lib.func('int UHFSetPower(uint8_t save, uint8_t uPower)'),
    // Per-antenna power. UHFSetPower only writes ANT1/global on the UR4;
    // multi-antenna rigs must set each port. Signatures from vendor UHFAPP.exe
    // P/Invoke. Get fills ppower with [ant, readPower, writePower] triplets,
    // nBytesReturned[in]=buffer size, [out]=bytes written.
    UHFSetAntennaPower: lib.func('int UHFSetAntennaPower(uint8_t save, uint8_t num, uint8_t read_power, uint8_t write_power)'),
    UHFGetAntennaPower: lib.func('int UHFGetAntennaPower(uint8_t *ppower, _Inout_ int *nBytesReturned)'),

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
    // Reader buzzer. Signature mirrors UHFSetWorkMode (the DLL's other
    // single-byte mode setter) — INFERRED, not from a datasheet, and unverified
    // on hardware because the live gate runs the sidecar driver, not this one.
    // Both symbols are exported by UHFAPI.dll.
    UHFSetBeep: lib.func('int UHFSetBeep(uint8_t mode)'),
    UHFGetBeep: lib.func('int UHFGetBeep(uint8_t *mode)'),
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
let linkType = null; // 'tcp' | 'usb' | 'com' — so disconnect() closes the right transport

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

/**
 * Open a reader on a serial / USB-CDC virtual COM port.
 * @param {number} port  COM number — 3 for COM3, not the string.
 * @param {number|null} baud  null = the DLL's default rate.
 * @returns {number} 0 on success, other = SDK error code.
 */
function connectCom(port, baud = null) {
  const f = load();
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 255) throw new Error(`connectCom: bad port ${port}`);
  const rc = baud == null ? f.ComOpen(n) : f.ComOpenWithBaud(n, Number(baud));
  connected = rc === 0;
  if (connected) linkType = 'com';
  return rc;
}

/** Vendor device-info string from an open USB reader, or null. */
function usbDeviceInfo() {
  const f = load();
  const buf = Buffer.alloc(256);
  const rc = f.UsbReadDeviceInfo(buf, buf.length);
  if (rc !== 0) return null;
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('latin1').trim() || null;
}

function disconnect() {
  if (!fns) return;
  if (linkType === 'usb') fns.UsbClose();
  else if (linkType === 'com') fns.ClosePort();
  else fns.TCPDisconnect();
  connected = false;
  linkType = null;
}

/** Which transport the current link uses: 'tcp' | 'usb' | 'com' | null. */
function getLinkType() {
  return linkType;
}

/**
 * Does a real reader actually answer on the currently open link?
 *
 * Measured on this DLL with NOTHING plugged in (2026-08-06):
 *   - UsbOpen() returns 0. "Success" does not mean a device was found.
 *   - UHFGetSoftwareVersion / UHFGetReaderVersion return 0 and hand back a
 *     string baked into the DLL ("V1.0.7,R1_Nu,2025-06-27 11:12:21"), so a
 *     plausible-looking version string proves nothing either.
 *   - UHFGetPower / UHFGetANT return 0 while leaving the output buffer
 *     unwritten or filled with a constant — observed 123 dBm, then 43 dBm,
 *     then 0 dBm on consecutive runs of the same empty link.
 *   - UHFInventorySingle SEGFAULTS the process.
 *
 * UHFGetRegion and UHFGetProtocolType were the only calls that consistently
 * FAILED on the phantom link, so they are the gate. Call this after any
 * connect and treat a false as "not connected" — the alternative is a bridge
 * that reports itself online and then dies on the first tag operation.
 */
function isReaderAlive() {
  if (!connected) return false; // no link at all — these calls segfault, see requireLink
  try {
    const region = getRegion();
    const proto = getProtocolType();
    return Boolean(region && region.code !== 0 && proto && proto.code <= 0x02);
  } catch (_) {
    return false;
  }
}

/**
 * Refuse to enter the DLL without an open link.
 *
 * Calling a reader command before any connect() takes the PROCESS DOWN with a
 * segfault rather than returning an error code — verified 2026-08-06 with
 * UHFGetRegion. Turning that into a thrown JS error is the difference between a
 * bug report and a dead bridge mid-shift.
 */
function requireLink(what) {
  if (!connected) throw new Error(`${what}: not connected — open a link first (connectUsb / connectCom / connect)`);
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

// ---------------------------------------------------------------------------
// Single-tag access: read / write / lock one chip's memory banks
// ---------------------------------------------------------------------------

/** Gen2 memory banks, as indexed by the SDK (matches the vendor demo's picker). */
const BANK = { RESERVED: 0, EPC: 1, TID: 2, USER: 3 };

/**
 * EPC-bank layout, in words:
 *   word 0 = CRC-16   (chip-maintained)
 *   word 1 = PC       (bits 15..11 = EPC length in words)
 *   word 2+ = the EPC itself
 * So a 96-bit EPC is 6 words written at word 2, and PC reads 0x3000.
 */
const EPC_DATA_PTR = 2;
/** Bit offset of the EPC inside the EPC bank — CRC(16) + PC(16). */
const EPC_FILTER_BIT_OFFSET = 32;

const DEFAULT_ACCESS_PWD = '00000000';

function hexToBuf(hex, label) {
  const clean = String(hex ?? '').replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error(`${label}: odd number of hex digits ("${hex}")`);
  return Buffer.from(clean, 'hex');
}

function accessPwdBuf(pwd) {
  const buf = hexToBuf(pwd ?? DEFAULT_ACCESS_PWD, 'accessPwd');
  if (buf.length !== 4) throw new Error(`accessPwd must be 8 hex digits (4 bytes), got ${buf.length}`);
  return buf;
}

/**
 * A Gen2 SELECT filter — which single chip an operation is addressed at.
 * `{ bank, startBit, data }`, or null for "no filter" (any tag in the field may
 * answer, which is only safe when exactly one tag is present).
 */
function noFilter() {
  return null;
}

/** Address an operation at the chip with this TID. TIDs are factory-unique and immutable. */
function filterByTid(tidHex) {
  const data = hexToBuf(tidHex, 'filterByTid');
  if (!data.length) throw new Error('filterByTid: empty TID');
  return { bank: BANK.TID, startBit: 0, data };
}

/**
 * Address an operation at the chip currently carrying this EPC.
 *
 * `startBit` defaults to 32 because the mask offset is counted from the start
 * of the EPC *bank*, which begins with CRC(16) + PC(16). If EPC-filtered
 * operations never match on some reader, pass 0 — that firmware counts from
 * the start of the EPC instead. Getting it wrong is fail-safe: the filter
 * matches nothing and the operation returns an error rather than acting on
 * the wrong tag.
 */
function filterByEpc(epcHex, startBit = EPC_FILTER_BIT_OFFSET) {
  const data = hexToBuf(epcHex, 'filterByEpc');
  if (!data.length) throw new Error('filterByEpc: empty EPC');
  return { bank: BANK.EPC, startBit, data };
}

/**
 * Spread a filter (or null) into the 4 SDK filter arguments.
 * The no-filter case still passes a real one-byte buffer rather than NULL —
 * a length of 0 means the DLL should never read it, but handing a C API a
 * null pointer it may not expect is a needless way to lose the process.
 */
const EMPTY_FILTER_DATA = Buffer.alloc(1);
function filterArgs(filter) {
  if (!filter) return [BANK.EPC, 0, 0, EMPTY_FILTER_DATA];
  return [filter.bank, filter.startBit, filter.data.length * 8, filter.data];
}

/**
 * Read `words` 16-bit words from a tag's memory bank.
 * @param {object} opts
 * @param {number} opts.bank      BANK.RESERVED | EPC | TID | USER
 * @param {number} opts.ptr       start offset, in WORDS
 * @param {number} opts.words     length, in WORDS
 * @param {object|null} opts.filter  from filterByTid/filterByEpc, or null
 * @param {string} [opts.accessPwd]  8 hex digits; default '00000000'
 * @returns {{rc:number, hex:(string|null), bytes:(Buffer|null)}}
 *   rc 0 = success. A non-zero rc means the read failed — no tag in range, the
 *   filter matched nothing, the bank is read-locked, or the address is past the
 *   end of that bank (which is how an over-long read reports "no such memory").
 */
function readBank({ bank, ptr, words, filter = null, accessPwd } = {}) {
  const f = load();
  requireLink('readBank');
  const out = Buffer.alloc(512);
  const outLen = [0];
  const rc = f.UHFReadData(accessPwdBuf(accessPwd), ...filterArgs(filter), bank, ptr, words, out, outLen);
  if (rc !== 0) return { rc, hex: null, bytes: null };
  const n = Math.min(outLen[0], out.length);
  const bytes = out.subarray(0, n);
  return { rc, hex: bytes.toString('hex').toUpperCase(), bytes };
}

/**
 * Write hex data into a tag's memory bank. `dataHex` must be a whole number of
 * 16-bit words (i.e. a multiple of 4 hex digits) — Gen2 has no sub-word write.
 * @returns {number} 0 on success.
 */
function writeBank({ bank, ptr, dataHex, filter = null, accessPwd } = {}) {
  const f = load();
  requireLink('writeBank');
  const data = hexToBuf(dataHex, 'writeBank');
  if (data.length === 0) throw new Error('writeBank: no data');
  if (data.length % 2 !== 0) throw new Error(`writeBank: data must be whole 16-bit words (got ${data.length} bytes)`);
  const words = data.length / 2;
  if (words > 255) throw new Error(`writeBank: too many words (${words}); uCnt is a single byte`);
  return f.UHFWriteData(accessPwdBuf(accessPwd), ...filterArgs(filter), bank, ptr, words, data);
}

/**
 * Lock / permalock a bank. `lockbuf` is the raw 3-byte Gen2 lock payload:
 * bits 0-9 Action, bits 10-19 Mask (see the Gen2 spec's Lock command).
 *
 * IRREVERSIBLE for permalock bits. Nothing in this repo calls it — it is bound
 * so lock STATE can be reasoned about, and so a deliberate lock is possible
 * later without reaching around the wrapper.
 * @returns {boolean} true on success.
 */
function lockTag({ lockbufHex, filter = null, accessPwd } = {}) {
  const f = load();
  requireLink('lockTag');
  const lockbuf = hexToBuf(lockbufHex, 'lockTag');
  if (lockbuf.length !== 3) throw new Error(`lockTag: lockbuf must be 3 bytes (6 hex digits), got ${lockbuf.length}`);
  return f.UHFLockTag(accessPwdBuf(accessPwd), ...filterArgs(filter), lockbuf) !== 0;
}

/**
 * Singulate ONE tag and return its PC + EPC. Cheaper and more deterministic
 * than starting an inventory and draining, which is what we want before a write.
 * @returns {{pc:string, epc:string, raw:string}|null} null when no tag answered.
 */
function inventorySingle() {
  const f = load();
  requireLink('inventorySingle');
  // Oversized on purpose: the header types rLrn as a bare pointer, so a reader
  // in a bad state can write more than the one length byte we expect.
  const rLrn = Buffer.alloc(64);
  const rData = Buffer.alloc(512);
  const rc = f.UHFInventorySingle(rLrn, rData);
  if (rc !== 0) return null;
  const uiiLen = rLrn[0];
  if (uiiLen < 2 || uiiLen > rData.length) return null;
  const uii = rData.subarray(0, uiiLen);
  return {
    pc: uii.subarray(0, 2).toString('hex').toUpperCase(),
    epc: uii.subarray(2).toString('hex').toUpperCase(),
    raw: uii.toString('hex').toUpperCase(),
  };
}

/**
 * Build the PC word for an EPC of `words` 16-bit words, preserving every other
 * bit of the tag's existing PC (UMI, XPC-indicator, numbering-system toggle).
 * PC bits 15..11 hold the EPC length in words.
 * @param {string} currentPcHex  the PC read off the tag, 4 hex digits
 * @param {number} words         EPC length in words (6 for a 96-bit EPC)
 * @returns {string} 4 hex digits
 */
function pcWordFor(currentPcHex, words) {
  const cur = hexToBuf(currentPcHex, 'pcWordFor');
  if (cur.length !== 2) throw new Error(`pcWordFor: PC must be 4 hex digits, got "${currentPcHex}"`);
  if (!Number.isInteger(words) || words < 0 || words > 31) throw new Error(`pcWordFor: bad word count ${words}`);
  const pc = (cur.readUInt16BE(0) & 0x07ff) | (words << 11);
  return pc.toString(16).toUpperCase().padStart(4, '0');
}

/** EPC length in 16-bit words, as declared by a PC word. */
function epcWordsFromPc(pcHex) {
  const buf = hexToBuf(pcHex, 'epcWordsFromPc');
  if (buf.length !== 2) return null;
  return buf.readUInt16BE(0) >> 11;
}

// ---------------------------------------------------------------------------
// Reader identity / radio configuration
// ---------------------------------------------------------------------------

/** Vendor version blobs are [len, ...bytes]; the bytes are usually ASCII. */
function decodeVersion(buf) {
  const vlen = buf[0];
  if (!vlen || vlen >= buf.length) return null;
  const bytes = buf.subarray(1, 1 + vlen);
  const ascii = bytes.toString('latin1');
  return { hex: bytes.toString('hex').toUpperCase(), ascii: /^[\x20-\x7e]+$/.test(ascii) ? ascii : null };
}

function getHardwareVersion() {
  const f = load();
  const buf = Buffer.alloc(64);
  return f.UHFGetHardwareVersion(buf) === 0 ? decodeVersion(buf) : null;
}

function getReaderVersion() {
  const f = load();
  const buf = Buffer.alloc(64);
  return f.UHFGetReaderVersion(buf) === 0 ? decodeVersion(buf) : null;
}

function getDeviceId() {
  const f = load();
  const id = [0];
  return f.UHFGetDeviceID(id) === 0 ? id[0] : null;
}

function getTemperature() {
  const f = load();
  const t = [0];
  return f.UHFGetTemperature(t) === 0 ? t[0] : null;
}

const REGIONS = { 0x01: 'China1 (920-925MHz)', 0x02: 'China2 (840-845MHz)', 0x04: 'Europe (865-868MHz)', 0x08: 'USA (902-928MHz)', 0x16: 'Korea', 0x32: 'Japan' };

/** @returns {{code:number, name:string}|null} */
function getRegion() {
  const f = load();
  const buf = Buffer.alloc(4);
  if (f.UHFGetRegion(buf) !== 0) return null;
  return { code: buf[0], name: REGIONS[buf[0]] ?? `unknown (0x${buf[0].toString(16)})` };
}

/** @param {number} code see REGIONS. @returns {number} 0 on success. */
function setRegion(code, save = true) {
  return load().UHFSetRegion(save ? 1 : 0, Number(code) & 0xff);
}

const PROTOCOLS = { 0x00: 'ISO18000-6C (EPC Gen2)', 0x01: 'GB/T 29768', 0x02: 'GJB 7377.1' };

function getProtocolType() {
  const f = load();
  const buf = Buffer.alloc(4);
  if (f.UHFGetProtocolType(buf) !== 0) return null;
  return { code: buf[0], name: PROTOCOLS[buf[0]] ?? `unknown (0x${buf[0].toString(16)})` };
}

const RF_LINKS = { 0: 'DSB_ASK/FM0/40kHz', 1: 'PR_ASK/Miller4/250kHz', 2: 'PR_ASK/Miller4/300kHz', 3: 'DSB_ASK/FM0/400kHz' };

function getRFLink() {
  const f = load();
  const buf = Buffer.alloc(4);
  if (f.UHFGetRFLink(buf) !== 0) return null;
  return { code: buf[0], name: RF_LINKS[buf[0]] ?? `unknown (${buf[0]})` };
}

/** Read current output power (dBm), or null on failure. */
function getPower() {
  const f = load();
  const buf = Buffer.alloc(4);
  const rc = f.UHFGetPower(buf);
  return rc === 0 ? buf[0] : null;
}

/**
 * Set output power in dBm (UR4: 1..30) on every enabled antenna port.
 * Falls back to the single/global UHFSetPower if per-antenna setting fails
 * (older firmware) or no antenna list is readable.
 * @returns {number} 0 only if every antenna succeeded.
 */
function setPower(dBm, save = true) {
  const f = load();
  const s = save ? 1 : 0;
  const p = Number(dBm) & 0xff;
  const ports = getAntennas();
  if (!ports || !ports.length) return f.UHFSetPower(s, p);
  let rc = 0;
  for (const port of ports) rc |= f.UHFSetAntennaPower(s, port, p, p);
  if (rc !== 0) return f.UHFSetPower(s, p);
  return 0;
}

/**
 * Set output power on ONE antenna port.
 *
 * The global setPower above writes the same dBm to every enabled port, which is
 * the wrong tool when the ports are not equivalent — a gate typically has one
 * antenna covering the doorway and another reaching further, and they want
 * different power. This is the per-port form of the same SDK call.
 *
 * Note UHFGetAntennaPower returns non-zero on this firmware, so a value written
 * here cannot be read back; the bridge remembers what it set instead.
 *
 * @returns {number} 0 on success.
 */
function setAntennaPower(port, dBm, save = true) {
  const f = load();
  const p = Number(port) & 0xff;
  if (p < 1 || p > 16) throw new Error(`setAntennaPower: bad port ${port}`);
  const v = Number(dBm) & 0xff;
  return f.UHFSetAntennaPower(save ? 1 : 0, p, v, v);
}

/** Read power per enabled antenna. @returns {{[port:number]:{read:number,write:number}}|null} */
function getAntennaPower() {
  const f = load();
  const buf = Buffer.alloc(256);
  const n = Buffer.alloc(4);
  n.writeInt32LE(buf.length, 0);
  if (f.UHFGetAntennaPower(buf, n) !== 0) return null;
  const len = Math.min(n.readInt32LE(0), buf.length);
  const out = {};
  // [ant, readPower, writePower] triplets
  for (let i = 0; i + 2 < len; i += 3) out[buf[i]] = { read: buf[i + 1], write: buf[i + 2] };
  return out;
}

/**
 * Reader buzzer on/off. The UR4 chirps on every tag read by default, which at a
 * gate reading continuously is one long tone all shift. Persists in the reader.
 * @returns {number} 0 on success.
 */
function setBeep(on) {
  const f = load();
  return f.UHFSetBeep(on ? 1 : 0);
}

/** @returns {boolean|null} null = the reader would not say. */
function getBeep() {
  const f = load();
  const buf = Buffer.alloc(4);
  return f.UHFGetBeep(buf) === 0 ? buf[0] !== 0 : null;
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

/**
 * Exports that talk to the reader and therefore need an open link.
 *
 * Guarding at the boundary rather than inside each function, because the DLL
 * does not return an error when there is no link — it takes the PROCESS DOWN.
 * `GET /power` with the reader unplugged killed the whole bridge that way
 * (2026-08-06), and hand-written per-function guards are exactly the kind of
 * thing a new helper forgets. guardExports throws at require() time if a name
 * here no longer exists, so a rename can't silently drop a guard.
 *
 * Deliberately NOT listed: load / connect* / disconnect / isConnected /
 * getLinkType / isReaderAlive (they establish or interrogate the link itself),
 * setLogLevel and bindUdp/unbindUdp (DLL-local, no reader involved), and the
 * pure helpers (parseTag, pcWordFor, filters, constants).
 */
const NEEDS_LINK = [
  'usbDeviceInfo',
  'startInventory',
  'stopInventory',
  'pollTag',
  'getSoftwareVersion',
  'getPower',
  'setPower',
  'readBank',
  'writeBank',
  'lockTag',
  'inventorySingle',
  'getHardwareVersion',
  'getReaderVersion',
  'getDeviceId',
  'getTemperature',
  'getRegion',
  'setRegion',
  'getProtocolType',
  'getRFLink',
  'getWorkTime',
  'setWorkTime',
  'setAntennas',
  'setAntennaPower',
  'setBeep',
  'getBeep',
  'getAntennas',
  'getAntennaLink',
  'readIOStatus',
  'getGpi',
  'getIOControl',
  'getWorkMode',
  'setWorkMode',
  'setWorkModePara',
  'getWorkModePara',
  'setDestIp',
  'getDestIp',
  'setReaderIp',
  'getReaderIp',
];

function guardExports(api) {
  for (const name of NEEDS_LINK) {
    const fn = api[name];
    if (typeof fn !== 'function') throw new Error(`guardExports: no export named "${name}" — update NEEDS_LINK`);
    api[name] = (...args) => {
      requireLink(name);
      return fn(...args);
    };
  }
  return api;
}

module.exports = guardExports({
  load,
  connect,
  connectUsb,
  connectCom,
  usbDeviceInfo,
  disconnect,
  isConnected,
  getLinkType,
  isReaderAlive,
  startInventory,
  stopInventory,
  pollTag,
  parseTag,
  getSoftwareVersion,
  getPower,
  setPower,
  // single-tag access
  BANK,
  EPC_DATA_PTR,
  EPC_FILTER_BIT_OFFSET,
  DEFAULT_ACCESS_PWD,
  noFilter,
  filterByTid,
  filterByEpc,
  readBank,
  writeBank,
  lockTag,
  inventorySingle,
  pcWordFor,
  epcWordsFromPc,
  // reader identity / radio
  getHardwareVersion,
  getReaderVersion,
  getDeviceId,
  getTemperature,
  getRegion,
  setRegion,
  REGIONS,
  getProtocolType,
  getRFLink,
  getAntennaPower,
  setAntennaPower,
  setBeep,
  getBeep,
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
});
