'use strict';

/**
 * CLI print+encode test for the Chainway CP30 — no UI, no bridge server needed.
 *
 * Usage:
 *   node test/print-test.js                        # next auto test EPC, configured transport (default: USB queue "Chainway CP30")
 *   node test/print-test.js AA0000000000000000000123   # explicit 24-hex-char EPC
 *   node test/print-test.js --printer "Chainway CP30"  # USB queue name override
 *   node test/print-test.js --tcp 192.168.99.201:9100  # raw TCP instead of USB
 *   node test/print-test.js --copies 2 --no-barcode --title "HELLO"
 *   node test/print-test.js --zpl-only             # print the generated ZPL to stdout, send nothing
 *   node test/print-test.js --raw label.zpl        # send a ZPL file verbatim
 */

require('dotenv').config();
const fs = require('fs');
const { PrinterManager } = require('../src/printer');

async function main() {
  const args = process.argv.slice(2);
  const opts = { epc: null, title: undefined, copies: 1, zplOnly: false, rawFile: null, overrides: {} };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--printer') opts.overrides = { ...opts.overrides, transport: 'usb', printerName: args[++i] };
    else if (a === '--tcp') {
      const [host, port] = String(args[++i]).split(':');
      opts.overrides = { ...opts.overrides, transport: 'tcp', host, port: Number(port) || 9100 };
    } else if (a === '--copies') opts.copies = Number(args[++i]) || 1;
    else if (a === '--title') opts.title = args[++i];
    else if (a === '--no-barcode') opts.overrides = { ...opts.overrides, barcode: false };
    else if (a === '--zpl-only') opts.zplOnly = true;
    else if (a === '--raw') opts.rawFile = args[++i];
    else if (/^[0-9A-Fa-f]+$/.test(a)) opts.epc = a;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }

  const printer = new PrinterManager({ log: (t) => console.log(`[printer] ${t}`) });
  if (Object.keys(opts.overrides).length) printer.setConfig(opts.overrides);

  if (opts.rawFile) {
    const zpl = fs.readFileSync(opts.rawFile, 'utf8');
    console.log(`Sending raw ZPL from ${opts.rawFile} (${zpl.length} chars)...`);
    console.log(await printer.sendRaw(zpl));
    return;
  }

  if (opts.zplOnly) {
    const { epc, zpl } = printer.preview({ epc: opts.epc, title: opts.title, copies: opts.copies });
    console.log(`EPC: ${epc}\n--- ZPL ---\n${zpl}`);
    return;
  }

  const result = await printer.printLabel({ epc: opts.epc, title: opts.title, copies: opts.copies });
  console.log('--- sent ---');
  console.log(`EPC encoded : ${result.epc}`);
  console.log(`Transport   : ${result.transport} -> ${result.target}${result.jobId ? ` (job ${result.jobId})` : ''}`);
  console.log(`Next EPC    : ${result.nextEpc}`);
  console.log('\nVerify: read the tag back with the UR4/desktop reader and confirm the EPC matches.');
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
