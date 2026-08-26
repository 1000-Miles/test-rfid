'use strict';

/**
 * Pallet-tag print test — exercises PrinterManager.printPalletTag end-to-end
 * against the REAL pallet printer queue (default "Gprinter Test"). Prints ONE
 * physical tag, then proves the idempotency contract against the durable
 * print-log oracle:
 *
 *   1. checkPalletReady() must say the queue is ready (else abort, no print)
 *   2. first printPalletTag()  -> replayed:false, bytes reach the spooler
 *   3. second call, same jobId -> replayed:true, NO second print
 *   4. the durable log holds exactly ONE entry for the jobId
 *
 *   node test/pallet-tag-print.js [palletCode] [widthMm] [heightMm] [leftOffsetMm] [dpi]
 *   node test/pallet-tag-print.js PLT-TEST-1 40 30 5       # 40x30 test stock, Gprinter
 *   node test/pallet-tag-print.js PLT-TSC-1 75 130 0 300   # 300 dpi TSC on production media
 *
 * Target the printer under test with PALLET_PRINTER_NAME, e.g.
 *   $env:PALLET_PRINTER_NAME='TSC T-4403E'; node test/pallet-tag-print.js PLT-TSC-1 75 130 0 300
 *
 * Passing `dpi` here overrides the configured head for this one print, so a
 * second printer can be bench-checked without repointing the bridge. Get it
 * wrong and the tag prints at the wrong scale rather than failing — so read the
 * dpi off the printer's own SELFTEST config label, don't assume it.
 */

const { PrinterManager } = require('../src/printer');

async function main() {
  const [, , codeArg, wArg, hArg, oxArg, dpiArg] = process.argv;
  const palletCode = codeArg || `PLT-TEST-${Date.now().toString(36).toUpperCase()}`;
  const widthMm = wArg ? Number(wArg) : undefined;
  const heightMm = hArg ? Number(hArg) : undefined;
  const leftOffsetMm = oxArg ? Number(oxArg) : undefined;
  const dpi = dpiArg ? Number(dpiArg) : undefined;
  const jobId = `pallet-test:${palletCode}`;

  const printer = new PrinterManager({ log: (text, level) => console.log(`[printer${level ? ':' + level : ''}] ${text}`) });
  console.log(`pallet printer: queue "${printer.config.palletPrinterName}", ${printer.config.palletDpi} dpi configured${dpi ? `, ${dpi} dpi for this print` : ''}`);

  const readiness = await printer.checkPalletReady();
  console.log(`pallet queue readiness: ${JSON.stringify(readiness)}`);
  if (!readiness.ready) {
    console.error('ABORT: pallet printer not ready — nothing printed.');
    process.exit(1);
  }

  const first = await printer.printPalletTag({ palletCode, jobId, widthMm, heightMm, leftOffsetMm, dpi });
  console.log(`first print:  ${JSON.stringify(first)}`);
  if (first.replayed !== false) {
    console.error('FAIL: first print reported replayed:true — a prior log entry already claims this jobId.');
    process.exit(1);
  }

  const second = await printer.printPalletTag({ palletCode, jobId, widthMm, heightMm, leftOffsetMm, dpi });
  console.log(`second print: ${JSON.stringify(second)}`);
  if (second.replayed !== true) {
    console.error('FAIL: second print was NOT deduped — idempotency broken, two physical tags printed.');
    process.exit(1);
  }

  const entries = printer.readPrintLog({ jobId });
  console.log(`durable log entries for ${jobId}: ${entries.length}`);
  if (entries.length !== 1) {
    console.error(`FAIL: expected exactly 1 durable log entry, found ${entries.length}.`);
    process.exit(1);
  }

  console.log(`PASS — one physical tag "${palletCode}" printed, replay deduped, log holds one entry.`);
}

main().catch((err) => {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
});
