'use strict';

/**
 * Identify the tag sitting on the reader: chip model, real EPC capacity, and
 * what its lock state appears to be.
 *
 * This answers the three open questions about the anti-metal pallet tags
 * (supplier SKU KLA13421) that no datasheet does — the supplier's SKU is
 * internal and the EPC those tags ship with (E2...) is a factory serial that
 * identifies nothing.
 *
 * Usage:
 *   node test/tag-info.js                 # identify the one tag in the field
 *   node test/tag-info.js --com 5         # force a transport (see probe-reader)
 *   node test/tag-info.js --test-write    # also prove whether EPC is writable
 *
 * Read-only by default. --test-write is the ONE exception and is explained
 * where it is implemented: it rewrites the EPC with the bytes it already has,
 * so a success leaves the tag byte-for-byte unchanged.
 */

const uhf = require('../src/uhf');
const tagOps = require('../src/tag-ops');
const { autoConnect, NO_READER_HELP } = require('../src/reader-connect');

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1] ?? null;
};

const log = (...a) => console.log(...a);
const pad = (s) => String(s).padEnd(20);

function reportTid(filter) {
  log('');
  log('  --- TID (factory-programmed, permanently read-only) ------------------');
  // 6 words = 96 bits covers the extended TID; fall back to the 32-bit short
  // TID, which is all some chips carry.
  let read = tagOps.readBankQuiet({ bank: uhf.BANK.TID, ptr: 0, words: 6, filter });
  if (read.rc !== 0) {
    log(`  ${pad('96-bit read')}failed (rc=${read.rc}) — falling back to 32-bit`);
    read = tagOps.readBankQuiet({ bank: uhf.BANK.TID, ptr: 0, words: 2, filter });
  }
  if (read.rc !== 0) {
    log(`  ${pad('TID')}UNREADABLE (rc=${read.rc})`);
    return null;
  }

  log(`  ${pad('TID')}${read.hex}`);
  const d = tagOps.decodeTid(read.hex);
  if (!d.ok) {
    log(`  ${pad('decode')}${d.reason}`);
    return read.hex;
  }
  log(`  ${pad('allocation class')}0x${d.allocationClass.toString(16).toUpperCase()} — ${d.allocationClassName}`);
  if (d.mdid != null) {
    log(`  ${pad('mask designer')}${d.mdidHex}${d.xtid ? ' (XTID bit set)' : ''} — ${d.vendor ?? 'NOT IN OUR TABLE — look up in the GS1 MDID registry'}`);
    log(`  ${pad('tag model no.')}${d.tmnHex}`);
    if (d.serial) log(`  ${pad('serial')}${d.serial}`);
  }
  if (d.note) log(`  ${pad('note')}${d.note}`);
  return read.hex;
}

function reportEpc(filter) {
  log('');
  log('  --- EPC bank ---------------------------------------------------------');
  const pcRead = tagOps.readBankQuiet({ bank: uhf.BANK.EPC, ptr: 1, words: 1, filter });
  let pcHex = null;
  if (pcRead.rc === 0) {
    pcHex = pcRead.hex;
    const words = uhf.epcWordsFromPc(pcHex);
    log(`  ${pad('PC word')}${pcHex}  — declares a ${words}-word / ${words * 16}-bit EPC`);
  } else {
    log(`  ${pad('PC word')}unreadable (rc=${pcRead.rc})`);
  }

  const cap = tagOps.probeEpcCapacity(filter);
  log(`  ${pad('readable capacity')}${cap.words} words / ${cap.bits} bits`);
  log(`  ${pad('probe ladder')}${cap.ladder.map((s) => `${s.words}${s.ok ? '✓' : '✗'}`).join('  ')}`);
  if (cap.bits > 96) {
    log(`  ${pad('')}larger than 96 bits — a longer EPC scheme is possible if ever wanted`);
  }
  return { pcHex, capacityWords: cap.words };
}

function reportReserved(filter) {
  log('');
  log('  --- RESERVED bank (kill + access passwords) --------------------------');
  const r = tagOps.readBankQuiet({ bank: uhf.BANK.RESERVED, ptr: 0, words: 4, filter });
  if (r.rc !== 0) {
    log(`  ${pad('read')}FAILED (rc=${r.rc})`);
    log(`  ${pad('')}the bank is read-locked, or the supplier set an access password`);
    log(`  ${pad('')}we do not have. Ask the supplier for it before assuming the`);
    log(`  ${pad('')}EPC bank is writable.`);
    return;
  }
  const kill = r.hex.slice(0, 8);
  const access = r.hex.slice(8, 16);
  log(`  ${pad('kill password')}${kill}${kill === '00000000' ? '  (default — not set)' : '  (SET by the supplier)'}`);
  log(`  ${pad('access password')}${access}${access === '00000000' ? '  (default — not set)' : '  (SET by the supplier)'}`);
  log(`  ${pad('read with pwd 0')}succeeded, so the reserved bank is not read-locked`);
}

/**
 * Prove whether the EPC bank accepts writes — by writing back the EPC the tag
 * already has.
 *
 * Gen2 gives no way to READ the lock bits; the only definitive test is an
 * attempted write. Writing the existing value is the least destructive form of
 * that test: success leaves the tag byte-for-byte as it was. The residual risk
 * is a write that is interrupted part-way, which is why this is opt-in and why
 * it re-reads and reports afterwards rather than assuming.
 */
function testWritable(filter, currentEpc) {
  log('');
  log('  --- EPC writability test (--test-write) ------------------------------');
  log(`  ${pad('writing back')}${currentEpc}  (identical to what is on the tag)`);
  let rc;
  try {
    rc = uhf.writeBank({ bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, dataHex: currentEpc, filter });
  } catch (err) {
    log(`  ${pad('result')}THREW — ${err.message}`);
    return;
  }
  const after = tagOps.readBankQuiet({
    bank: uhf.BANK.EPC,
    ptr: uhf.EPC_DATA_PTR,
    words: currentEpc.length / 4,
    filter,
  });
  log(`  ${pad('write rc')}${rc}`);
  log(`  ${pad('read back')}${after.hex ?? `(failed, rc=${after.rc})`}`);
  if (rc === 0 && after.hex === currentEpc) {
    log(`  ${pad('verdict')}EPC bank is WRITABLE and unchanged — safe to encode`);
  } else if (rc !== 0) {
    log(`  ${pad('verdict')}write REFUSED — the EPC bank is locked or permalocked`);
  } else {
    log(`  ${pad('verdict')}write reported OK but read-back DIFFERS — do not encode this batch`);
  }
}

async function main() {
  log('');
  uhf.load();
  try {
    uhf.setLogLevel(0);
  } catch (_) {
    /* non-fatal */
  }

  const com = valueOf('--com');
  const { ok } = autoConnect({
    tcp: valueOf('--tcp'),
    com: com == null ? null : Number(com),
    usbOnly: has('--usb'),
    onAttempt: (line) => log(`  ${line}`),
  });
  if (!ok) {
    log('');
    log(NO_READER_HELP);
    process.exit(2);
  }

  try {
    const tag = await tagOps.requireSingleTag(600);
    log('');
    log(`  ${pad('tag in field')}EPC ${tag.epc}  (${tag.reads} reads, ${tag.rssi ?? '?'}dBm)`);

    // Everything below is addressed at THIS chip by its current EPC, so a tag
    // that wanders into range mid-run cannot answer in its place.
    const filter = uhf.filterByEpc(tag.epc);

    const tid = reportTid(filter);
    const { capacityWords } = reportEpc(filter);
    reportReserved(filter);
    if (has('--test-write')) testWritable(filter, tag.epc);

    log('');
    log('  --- summary ----------------------------------------------------------');
    log(`  ${pad('EPC (current)')}${tag.epc}`);
    log(`  ${pad('TID')}${tid ?? '(unreadable)'}`);
    log(`  ${pad('EPC capacity')}${capacityWords * 16} bits`);
    if (!has('--test-write')) {
      log('');
      log('  Lock state is still unknown — Gen2 has no "read the lock bits" command.');
      log('  Re-run with --test-write to settle it non-destructively.');
    }
  } finally {
    uhf.disconnect();
    log('');
    log('Disconnected.');
  }
}

main().catch((err) => {
  console.error('');
  console.error(`ERROR: ${err.message}`);
  try {
    uhf.disconnect();
  } catch (_) {
    /* already down */
  }
  process.exit(1);
});
