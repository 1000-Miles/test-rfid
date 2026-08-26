'use strict';

/**
 * GPO / relay round-trip test: proves the reader's IO block responds.
 * Sets GPO0=GPO1=high + relay closed, reads back, restores low/open.
 * Listen for the relay CLICK — audible proof the IO hardware works.
 *
 * Usage: node test/gpo-test.js [ip] [port]
 */

const koffi = require('koffi');
const path = require('path');
const uhf = require('../src/uhf');

const ip = process.argv[2] || '192.168.99.202';
const port = parseInt(process.argv[3] || '8888', 10);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 23)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  uhf.load();
  const lib = koffi.load(path.join(__dirname, '..', 'lib', 'UHFAPI.dll'));
  const SetIOControl = lib.func('int UHFSetIOControl(uint8_t output1, uint8_t output2, uint8_t outStatus)');

  const rc = uhf.connect(ip, port);
  if (rc !== 0) {
    log(`TCPConnect -> ${rc}, reader busy or unreachable.`);
    process.exit(1);
  }
  log('Connected.');

  log('IOControl before:', JSON.stringify(uhf.getIOControl()));
  log('IOStatus  before:', JSON.stringify(uhf.readIOStatus()));

  const rcHi = SetIOControl(1, 1, 1); // both GPO high, relay closed — LISTEN FOR CLICK
  log(`SetIOControl(1,1,1) rc=${rcHi}`);
  await sleep(300);
  log('IOControl after set-high:', JSON.stringify(uhf.getIOControl()));
  log('IOStatus  after set-high:', JSON.stringify(uhf.readIOStatus()));

  await sleep(2000);

  const rcLo = SetIOControl(0, 0, 0);
  log(`SetIOControl(0,0,0) rc=${rcLo}`);
  await sleep(300);
  log('IOControl after set-low:', JSON.stringify(uhf.getIOControl()));

  uhf.disconnect();
  log('Done. If "after set-high" showed 0101 (and you heard a click), the IO block works — GPI silence is a sensor wiring/power problem.');
}

main().catch((e) => {
  console.error(e);
  try { uhf.disconnect(); } catch (_) {}
  process.exit(99);
});
