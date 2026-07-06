'use strict';

/**
 * GPI / IO diagnostic monitor.
 *
 * Connects to the reader and then does NOTHING but poll the IO status in a
 * loop, printing the raw bytes from BOTH candidate SDK calls. It never starts
 * an inventory, so nothing competes for the reader.
 *
 * Use it to answer the one question we can't answer without hardware:
 *   "Do the IO bytes change when the IR beam breaks — and which byte/bit?"
 *
 * Run it, then slowly break + clear the IR beam a few times and watch for
 * lines marked  <<< CHANGED.
 *
 * Usage:
 *   node test/gpi-monitor.js [ip] [port] [intervalMs]
 *   e.g. node test/gpi-monitor.js 192.168.99.202 8888 200
 */

const uhf = require('../src/uhf');

const ip = process.argv[2] || '192.168.99.202';
const port = parseInt(process.argv[3] || '8888', 10);
const interval = parseInt(process.argv[4] || '200', 10);

const ts = () => new Date().toISOString().slice(11, 23);

function main() {
  uhf.load();
  uhf.setLogLevel(0);

  const rc = uhf.connect(ip, port);
  if (rc !== 0) {
    console.log(`TCPConnect(${ip}:${port}) -> ${rc}  (reader not reachable). Fix the connection first.`);
    process.exit(1);
  }
  console.log(`Connected to ${ip}:${port}. Polling IO every ${interval}ms.`);
  console.log('Now break/clear the IR beam. Watch for  <<< CHANGED.  Ctrl+C to stop.\n');
  console.log('time         | UHFGetIOStatus (GPI inputs?)      | UHFGetIOControl (GPO out) | interpreted');
  console.log('-------------|-----------------------------------|---------------------------|-------------');

  let prev = '';
  const timer = setInterval(() => {
    let ioStatus, ioControl, gpi;
    try {
      ioStatus = uhf.readIOStatus();   // { rc, raw, bytes }
      ioControl = uhf.getIOControl();  // { rc, raw, gpo0, gpo1 }
      gpi = uhf.getGpi();              // interpreted { gpi1, gpi2, raw }
    } catch (err) {
      console.log(`${ts()} | ERROR: ${err.message}`);
      return;
    }

    const statusStr = `rc=${ioStatus.rc} len=${ioStatus.bytes.length} raw=${ioStatus.raw || '(empty)'}`;
    const controlStr = `rc=${ioControl.rc} raw=${ioControl.raw || '(empty)'}`;
    const interp = `GPI1=${gpi.gpi1} GPI2=${gpi.gpi2}`;

    const key = statusStr + '|' + controlStr;
    const changed = key !== prev && prev !== '' ? '  <<< CHANGED' : '';
    prev = key;

    console.log(`${ts()} | ${statusStr.padEnd(33)} | ${controlStr.padEnd(25)} | ${interp}${changed}`);
  }, interval);

  const shutdown = () => {
    clearInterval(timer);
    try {
      uhf.disconnect();
    } catch (_) {}
    console.log('\nDisconnected.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
}

main();
