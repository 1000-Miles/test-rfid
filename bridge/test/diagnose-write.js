'use strict';

/**
 * Why won't this tag take a write?
 *
 * A failed write says nothing on its own — "locked" is only one of five causes,
 * and it is the only one you cannot do anything about. This walks them in order
 * of likelihood and cost, and reports which one it actually is:
 *
 *   1. Write power too low.  Writing needs materially more RF energy than
 *      reading, so a tag that inventories perfectly can still refuse a write.
 *      This is the most common cause and the easiest to miss, because the tag
 *      is plainly "working".
 *   2. Coupling / position.  Anti-metal tags are built to sit ON metal and can
 *      read poorly in free air.
 *   3. The SELECT filter.  If TID filtering is unsupported or offset wrongly on
 *      this firmware, the write addresses nothing and errors — looking exactly
 *      like a locked tag.
 *   4. Access password.  A supplier-set password puts the tag in the secured
 *      state; writes with 00000000 are refused.
 *   5. Genuinely locked or permalocked.
 *
 * Every write here writes the tag's OWN CURRENT DATA back to it. Identical
 * bytes, so a success changes nothing — the tag ends exactly as it started.
 *
 * Usage:
 *   node test/diagnose-write.js
 *   node test/diagnose-write.js --com 5      # force a transport
 */

const uhf = require('../src/uhf');
const tagOps = require('../src/tag-ops');
const { autoConnect, NO_READER_HELP } = require('../src/reader-connect');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => {
  const i = argv.indexOf(f);
  return i === -1 ? null : argv[i + 1] ?? null;
};

const log = (...a) => console.log(...a);
const pad = (s) => String(s).padEnd(30);
const results = [];

/** Write `dataHex` back to where it came from and report whether it stuck. */
function tryWrite(label, { bank, ptr, dataHex, filter, accessPwd }) {
  let rc;
  try {
    rc = uhf.writeBank({ bank, ptr, dataHex, filter, accessPwd });
  } catch (err) {
    log(`  ${pad(label)}THREW — ${err.message}`);
    results.push({ label, ok: false, rc: null });
    return false;
  }
  const words = dataHex.length / 4;
  const back = tagOps.readBankQuiet({ bank, ptr, words, filter, accessPwd });
  const ok = rc === 0 && back.hex === dataHex;
  log(`  ${pad(label)}${ok ? 'OK' : `FAILED (write rc=${rc}, reads back ${back.hex ?? `rc=${back.rc}`})`}`);
  results.push({ label, ok, rc });
  return ok;
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
  const { ok: linked } = autoConnect({
    tcp: valueOf('--tcp'),
    com: com == null ? null : Number(com),
    usbOnly: has('--usb'),
    onAttempt: (line) => log(`  ${line}`),
  });
  if (!linked) {
    log('');
    log(NO_READER_HELP);
    process.exit(2);
  }

  let originalPower = null;
  try {
    originalPower = uhf.getPower();
    const region = uhf.getRegion();
    log('');
    log(`  ${pad('current power')}${originalPower} dBm`);
    log(`  ${pad('region')}${region ? region.name : '(unavailable)'}`);

    const tag = await tagOps.requireSingleTag(700);
    log(`  ${pad('tag')}${tag.epc}  (${tag.reads} reads, ${tag.rssi ?? '?'}dBm)`);
    if (tag.rssi != null && tag.rssi < -60) {
      log(`  ${pad('')}WEAK signal — try the tag flat on metal, closer to the antenna`);
    }

    const byEpc = uhf.filterByEpc(tag.epc);
    let tidRead = tagOps.readBankQuiet({ bank: uhf.BANK.TID, ptr: 0, words: 6, filter: byEpc });
    if (tidRead.rc !== 0) tidRead = tagOps.readBankQuiet({ bank: uhf.BANK.TID, ptr: 0, words: 2, filter: byEpc });
    const tid = tidRead.rc === 0 ? tidRead.hex : null;
    log(`  ${pad('TID')}${tid ?? `UNREADABLE (rc=${tidRead.rc})`}`);
    const byTid = tid ? uhf.filterByTid(tid) : null;

    // Cause 4: a supplier-set access password. Readable here unless the
    // reserved bank is itself read-locked.
    const reserved = tagOps.readBankQuiet({ bank: uhf.BANK.RESERVED, ptr: 0, words: 4, filter: byEpc });
    let accessPwd = null;
    if (reserved.rc === 0) {
      const kill = reserved.hex.slice(0, 8);
      const access = reserved.hex.slice(8, 16);
      log(`  ${pad('kill / access password')}${kill} / ${access}`);
      if (access !== '00000000') {
        accessPwd = access;
        log(`  ${pad('')}access password is SET — will retry writes with it`);
      }
    } else {
      log(`  ${pad('reserved bank')}unreadable (rc=${reserved.rc}) — password unknown`);
    }

    const epcWords = tag.epc.length / 4;
    const oneWord = tag.epc.slice(0, 4);

    log('');
    log('  --- write tests (all write the tag\'s own data back) ------------------');

    // Cause 1: sensitivity. One word needs far less energy than six, so if the
    // short write lands and the full one doesn't, this is power, not locking.
    tryWrite(`1 word @ ${originalPower}dBm, TID filter`, { bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, dataHex: oneWord, filter: byTid });
    tryWrite(`${epcWords} words @ ${originalPower}dBm, TID filter`, { bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, dataHex: tag.epc, filter: byTid });

    // Cause 1 again, escalating. Not persisted — power is restored at the end.
    for (const dBm of [20, 26, 30]) {
      if (originalPower != null && dBm <= originalPower) continue;
      const rc = uhf.setPower(dBm, false);
      if (rc !== 0) {
        log(`  ${pad(`set power ${dBm}dBm`)}refused (rc=${rc})`);
        continue;
      }
      if (tryWrite(`${epcWords} words @ ${dBm}dBm, TID filter`, { bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, dataHex: tag.epc, filter: byTid })) break;
    }

    // Cause 3: is the filter itself the problem? Only meaningful because
    // requireSingleTag already proved one tag is in the field.
    //
    // A full 96-bit TID mask is a long SELECT, and some firmware caps mask
    // length — which fails identically to a locked tag. The short mask below
    // separates "TID filtering is broken" from "that mask was too long". It is
    // diagnostic ONLY: 32 bits of TID is the chip model, not a serial, so it
    // does not identify a single tag and must never be used for a real write.
    if (tid && tid.length > 8) {
      tryWrite('TID filter, first 32 bits only', { bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, dataHex: tag.epc, filter: uhf.filterByTid(tid.slice(0, 8)) });
    }
    tryWrite('no filter (one tag in field)', { bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, dataHex: tag.epc, filter: null });
    tryWrite('EPC filter instead of TID', { bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, dataHex: tag.epc, filter: byEpc });
    tryWrite('EPC filter @ bit offset 0', { bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, dataHex: tag.epc, filter: uhf.filterByEpc(tag.epc, 0) });

    // Cause 4: retry with the password we found.
    if (accessPwd) {
      tryWrite('with the supplier access password', { bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, dataHex: tag.epc, filter: byTid, accessPwd });
    }

    // Cause 5: is it the EPC bank specifically, or the whole tag? A USER bank
    // that accepts writes while EPC refuses means EPC alone is locked.
    const user = tagOps.readBankQuiet({ bank: uhf.BANK.USER, ptr: 0, words: 2, filter: byEpc });
    if (user.rc === 0) {
      tryWrite('USER bank (is EPC alone locked?)', { bank: uhf.BANK.USER, ptr: 0, dataHex: user.hex, filter: byTid });
    } else {
      log(`  ${pad('USER bank')}not readable (rc=${user.rc}) — chip may have no user memory`);
    }

    // --- verdict ---------------------------------------------------------
    const won = (frag) => results.some((r) => r.ok && r.label.includes(frag));
    const anyEpcWrite = results.some((r) => r.ok && !r.label.startsWith('USER'));

    log('');
    log('  --- verdict ----------------------------------------------------------');
    if (anyEpcWrite) {
      const first = results.find((r) => r.ok && !r.label.startsWith('USER'));
      log(`  The EPC bank is NOT locked — it accepted: "${first.label}".`);
      if (won('dBm') && !results.find((r) => r.label.includes(`@ ${originalPower}dBm, TID filter`) && r.ok)) {
        log(`  It failed at ${originalPower}dBm and worked higher up, so this was WRITE POWER.`);
        log('  Raise the reader power before encoding — Tag Station uses whatever the');
        log('  bridge is currently set to.');
      }
      if (won('first 32 bits') && !won('words @')) {
        log('  A SHORT TID mask works where the full 96-bit one fails: this firmware caps');
        log('  SELECT mask length. Fix by masking on a shorter unique slice of the TID —');
        log('  NOT by dropping the filter, and not on the first 32 bits (that is the chip');
        log('  model, shared by every tag in the batch).');
      }
      if ((won('no filter') || won('EPC filter')) && !won('TID filter')) {
        log('  The tag writes, but not when addressed by TID: the SELECT filter is the');
        log('  problem, not the tag. Do NOT fall back to unfiltered writes for a batch —');
        log('  that is exactly what programs a neighbouring tag by mistake. Use the EPC');
        log('  filter, which also addresses one tag, until TID filtering is sorted.');
      }
      if (won('access password')) log('  It needed the supplier access password — thread that through before encoding.');
    } else if (won('USER bank')) {
      log('  USER memory accepts writes but EPC does not: the EPC bank is locked');
      log('  specifically. Ask the supplier to ship unlocked tags, or register these');
      log('  with the factory EPCs they already carry.');
    } else {
      log('  Nothing accepted a write at any power, with or without a filter.');
      log('  Most likely locked or permalocked at the factory. Before concluding that,');
      log('  re-run with the tag lying FLAT ON METAL (anti-metal tags read poorly in air)');
      log('  and confirm the reader is not on a mismatched region.');
    }
    log('');
    log('  Nothing on the tag was changed — every write above wrote its own data back.');
  } finally {
    if (originalPower != null) {
      try {
        uhf.setPower(originalPower, false);
      } catch (_) {
        /* restoring is best-effort */
      }
    }
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
