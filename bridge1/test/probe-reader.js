'use strict';

/**
 * Find and identify a desktop UHF reader (Chainway R3 / R1 / similar).
 *
 * The bridge was built for the UR4, which is an Ethernet reader — so the DLL we
 * ship is the UR-family Windows build and it is NOT a given that it drives a
 * desktop USB reader at all. That is the first thing this answers. It also
 * reports the radio config that matters before any encoding: region (a
 * China-band reader in the Philippines is transmitting out of allocation),
 * protocol, RF link and power.
 *
 * Tries UsbOpen(), then every registered COM port, and stops at the first
 * transport where a reader actually ANSWERS — see uhf.isReaderAlive, because
 * UsbOpen() returns success against an empty USB bus.
 *
 * Usage:
 *   node test/probe-reader.js                 # auto: USB, then every COM port
 *   node test/probe-reader.js --usb           # USB only
 *   node test/probe-reader.js --com 5         # COM5 only
 *   node test/probe-reader.js --com 5 --baud 115200
 *   node test/probe-reader.js --tcp 192.168.99.202:8888
 *   node test/probe-reader.js --set-region 8  # 8 = USA band (902-928MHz)
 *
 * Read-only unless --set-region is passed. Never writes to a tag.
 */

const uhf = require('../src/uhf');
const { autoConnect, NO_READER_HELP } = require('../src/reader-connect');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1] ?? null;
};

const log = (...a) => console.log(...a);
const pad = (s) => String(s).padEnd(18);

/** Everything the reader will tell us about itself over a verified link. */
function describeReader() {
  const safe = (fn, fallback = null) => {
    try {
      const v = fn();
      return v == null ? fallback : v;
    } catch (err) {
      return `(threw: ${err.message})`;
    }
  };
  const ver = (v) => (v == null ? '(unavailable)' : v.ascii ? `${v.ascii}  [${v.hex}]` : v.hex);

  log('');
  log('  --- reader ---------------------------------------------------------');
  log(`  ${pad('transport')}${uhf.getLinkType()}`);
  if (uhf.getLinkType() === 'usb') log(`  ${pad('usb device info')}${safe(() => uhf.usbDeviceInfo(), '(unavailable)')}`);
  log(`  ${pad('software version')}${safe(() => uhf.getSoftwareVersion(), '(unavailable)')}`);
  log(`  ${pad('hardware version')}${ver(safe(() => uhf.getHardwareVersion()))}`);
  log(`  ${pad('reader version')}${ver(safe(() => uhf.getReaderVersion()))}`);
  log(`  ${pad('device id')}${safe(() => uhf.getDeviceId(), '(unavailable)')}`);
  log(`  ${pad('temperature')}${safe(() => uhf.getTemperature(), '(unavailable)')}`);

  log('');
  log('  --- radio ----------------------------------------------------------');
  const region = safe(() => uhf.getRegion());
  log(`  ${pad('region')}${region ? `${region.name}  (0x${region.code.toString(16).padStart(2, '0')})` : '(unavailable)'}`);
  const proto = safe(() => uhf.getProtocolType());
  log(`  ${pad('protocol')}${proto ? proto.name : '(unavailable)'}`);
  const rfLink = safe(() => uhf.getRFLink());
  log(`  ${pad('rf link')}${rfLink ? rfLink.name : '(unavailable)'}`);
  log(`  ${pad('power')}${safe(() => uhf.getPower(), '?')} dBm`);
  log(`  ${pad('antennas enabled')}[${safe(() => uhf.getAntennas(), '?')}]`);

  if (region && region.code !== 0x08) {
    log('');
    log(`  NOTE: region is ${region.name}. The Philippines allocates 918-920MHz;`);
    log('        USA (0x08, 902-928MHz) is the closest preset that covers it.');
    log('        Set it with: node test/probe-reader.js --set-region 8');
  }

  log('');
  log('  --- tag in field ---------------------------------------------------');
  const single = safe(() => uhf.inventorySingle());
  if (!single || typeof single === 'string') {
    log('  no tag answered (put one on the reader and re-run to confirm the RF path)');
  } else {
    const words = uhf.epcWordsFromPc(single.pc);
    log(`  ${pad('PC')}${single.pc}   (declares a ${words}-word / ${words * 16}-bit EPC)`);
    log(`  ${pad('EPC')}${single.epc}`);
    log('');
    log('  Next: node test/tag-info.js   — reads TID, EPC capacity and lock state.');
  }
}

function main() {
  log('');
  log('Loading UHFAPI.dll ...');
  log(`  path: ${uhf.paths.UHFAPI_PATH}`);
  try {
    uhf.load();
  } catch (err) {
    log('FAIL: koffi could not load/bind UHFAPI.dll');
    console.error(err);
    process.exit(1);
  }
  log('  OK — bound.');
  try {
    uhf.setLogLevel(0);
  } catch (_) {
    /* non-fatal */
  }

  log('');
  log('Trying transports:');
  const com = valueOf('--com');
  const baud = valueOf('--baud');
  const { ok } = autoConnect({
    tcp: valueOf('--tcp'),
    com: com == null ? null : Number(com),
    baud: baud == null ? null : Number(baud),
    usbOnly: has('--usb'),
    onAttempt: (line) => log(`  ${line}`),
  });

  if (!ok) {
    log('');
    log(NO_READER_HELP);
    process.exit(2);
  }

  try {
    const setRegion = valueOf('--set-region');
    if (setRegion != null) {
      const code = Number(setRegion);
      const rc = uhf.setRegion(code, true);
      log('');
      log(`  setRegion(0x${code.toString(16)}, save) -> ${rc} (${rc === 0 ? 'OK' : 'FAIL'})`);
    }
    describeReader();
  } finally {
    uhf.disconnect();
    log('');
    log('Disconnected.');
  }
}

main();
