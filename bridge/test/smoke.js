'use strict';

/**
 * Standalone smoke test for the UHFAPI.dll wrapper.
 *
 * Goal #1 (always): prove koffi can LOAD UHFAPI.dll and bind its exports on this
 *                   machine + Node version. This works even with no reader attached.
 * Goal #2 (if reader reachable): connect, read version, run a short inventory and
 *                   dump parsed tags + raw hex so we can verify the byte layout
 *                   against real device output.
 *
 * Usage:
 *   node test/smoke.js [ip] [port] [seconds]
 *   e.g. node test/smoke.js 192.168.99.202 8888 3
 */

const uhf = require('../src/uhf');

const ip = process.argv[2] || '192.168.99.202';
const port = parseInt(process.argv[3] || '8888', 10);
const seconds = parseInt(process.argv[4] || '3', 10);

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- Goal #1: load + bind -------------------------------------------------
  log('Loading UHFAPI.dll via koffi ...');
  log('  path:', uhf.paths.UHFAPI_PATH);
  try {
    uhf.load();
  } catch (err) {
    log('FAIL: koffi could not load/bind UHFAPI.dll');
    console.error(err);
    process.exit(1);
  }
  log('OK  : koffi loaded UHFAPI.dll and bound all exports.');

  try {
    uhf.setLogLevel(0);
  } catch (_) {
    /* non-fatal */
  }

  // ---- Goal #2: talk to the reader -----------------------------------------
  log(`Connecting to reader at ${ip}:${port} (TCPConnect) ...`);
  let rc;
  try {
    rc = uhf.connect(ip, port);
  } catch (err) {
    log('FAIL: TCPConnect threw', err.message);
    process.exit(2);
  }

  if (rc !== 0) {
    log(`NOTE: TCPConnect returned ${rc} (reader not reachable / not powered / wrong ip:port).`);
    log('      DLL binding is still PROVEN — the FFI layer works. Plug in the reader and re-run to exercise inventory.');
    process.exit(0);
  }
  log('OK  : connected.');

  const version = uhf.getSoftwareVersion();
  log('Software version (hex):', version ?? '(unavailable)');

  log(`Starting inventory for ${seconds}s ...`);
  const startRc = uhf.startInventory();
  if (startRc !== 0) {
    log(`FAIL: UHFInventory() returned ${startRc}`);
    uhf.disconnect();
    process.exit(3);
  }

  const seen = new Set();
  let total = 0;
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    const tag = uhf.pollTag();
    if (tag) {
      total++;
      if (tag.epc) seen.add(tag.epc);
      log(
        `TAG  epc=${tag.epc} ant=${tag.antenna} rssi=${tag.rssi}dBm` +
          (tag.tid ? ` tid=${tag.tid}` : '') +
          `  raw=${tag.raw}`
      );
    } else {
      await sleep(5); // buffer empty; back off briefly
    }
  }

  log('Stopping inventory ...');
  uhf.stopInventory();
  uhf.disconnect();

  log(`DONE: ${total} reads, ${seen.size} unique EPCs.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(99);
});
