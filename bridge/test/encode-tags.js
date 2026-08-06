'use strict';

/**
 * Encode pallet tags one at a time, with a verified read-back per tag.
 *
 * Safety model — three independent layers, because a mis-write is only
 * discovered later, in the warehouse, when a pallet resolves to the wrong thing:
 *
 *   1. ONE tag in the field. Refuses to run if a second tag answers.
 *   2. Every write is addressed by TID. The TID is factory-unique and
 *      immutable, so even a tag that wanders into range mid-write cannot be
 *      the chip that gets programmed. This — not low power — is what makes
 *      "wrote to a neighbour in the bag" impossible.
 *   3. Low power on top of both (default 10 dBm), so the field barely reaches
 *      past the tag on the reader.
 *
 * Verification uses TWO oracles that fail independently:
 *   a. a TID-filtered read-back of the EPC bank, and
 *   b. a fresh over-the-air singulation, which must now report the new EPC.
 * Both must agree before a tag is recorded as encoded.
 *
 * Usage:
 *   node test/encode-tags.js                       # dry run — writes nothing
 *   node test/encode-tags.js --commit              # encode one tag
 *   node test/encode-tags.js --commit --count 10   # encode 10, prompting between
 *   node test/encode-tags.js --commit --epc PL0F00000000000000000001
 *   node test/encode-tags.js --commit --nexus      # mint real PL01 EPCs from Nexus
 *   node test/encode-tags.js --commit --prove-fail # verification MUST report failure
 *   node test/encode-tags.js --commit --power 15   # write power, dBm
 *
 * EPC namespaces. An EPC is raw hex, so a prefix can only use 0-9 A-F — "PL"
 * for pallet is not encodable. The first two chars are therefore an opaque
 * TAG-KIND code, continuing the pattern Nexus already uses for cartons:
 *   BC01…  cartons — the existing scheme, minted by operations_next_epcs
 *   BA01…  pallets — minted by Nexus (--nexus) via operations_next_pallet_epcs
 *   BA0F…  bench namespace, minted locally from data/pallet-epc.json.
 *          A different kind code on purpose: bench tags can never collide with
 *          the real BA01 space, and a stray one is obvious in a scan.
 *
 * Every attempt — success or failure — is appended to data/pallet-encode-log.jsonl.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const uhf = require('../src/uhf');
const tagOps = require('../src/tag-ops');
const { autoConnect, NO_READER_HELP } = require('../src/reader-connect');

const DATA_DIR = path.join(__dirname, '..', 'data');
const COUNTER_PATH = path.join(DATA_DIR, 'pallet-epc.json');
const LEDGER_PATH = path.join(DATA_DIR, 'pallet-encode-log.jsonl');

const BENCH_PREFIX = 'BA0F'; // hex-only, see the namespace note above
const EPC_WORDS = 6; // 96-bit EPC — 24 hex chars, same length as the carton scheme

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : argv[i + 1] ?? null;
};

const COMMIT = has('--commit');
const PROVE_FAIL = has('--prove-fail');
const COUNT = Math.max(1, Number(valueOf('--count') ?? 1));
const POWER = Number(valueOf('--power') ?? 10);

const log = (...a) => console.log(...a);
const pad = (s) => String(s).padEnd(18);

// --- EPC sources -----------------------------------------------------------

function nextBenchEpc() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let counter = 0;
  try {
    counter = JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf8')).counter || 0;
  } catch (_) {
    /* first run */
  }
  counter += 1;
  fs.writeFileSync(COUNTER_PATH, JSON.stringify({ counter }, null, 2));
  return (BENCH_PREFIX + counter.toString(16).toUpperCase().padStart(EPC_WORDS * 4 - BENCH_PREFIX.length, '0')).toUpperCase();
}

/**
 * Mint real BA01 EPCs from Nexus's sequence, so bench-encoded tags and
 * app-issued tags can never collide. Requires migration
 * 20260806000000_pallet_epc_sequence.sql to be applied.
 */
async function nextNexusEpcs(n) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('--nexus needs SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_ANON_KEY) in bridge/.env');
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/rpc/operations_next_pallet_epcs`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ n }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Nexus EPC mint failed (${res.status}): ${body}`);
  const rows = JSON.parse(body);
  const epcs = rows.map((r) => (typeof r === 'string' ? r : r.epc)).filter(Boolean);
  if (epcs.length < n) throw new Error(`Nexus returned ${epcs.length} EPCs, expected ${n}`);
  return epcs;
}

function normalizeEpc(hex, label) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (clean.length !== EPC_WORDS * 4) {
    throw new Error(`${label}: EPC must be ${EPC_WORDS * 4} hex chars (${EPC_WORDS * 16}-bit), got ${clean.length} — "${hex}"`);
  }
  return clean;
}

/** Flip the last nibble, so --prove-fail expects something the tag will NOT hold. */
function flipLastNibble(epc) {
  const last = parseInt(epc.slice(-1), 16);
  return epc.slice(0, -1) + ((last ^ 0x1).toString(16).toUpperCase());
}

// --- ledger ----------------------------------------------------------------

function appendLedger(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(LEDGER_PATH, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => (rl.close(), resolve(a))));
}

// --- the encode itself -----------------------------------------------------

/**
 * Encode ONE tag. Returns a record describing exactly what happened, which is
 * also what goes in the ledger — no "it worked" without the evidence beside it.
 */
async function encodeOne(targetEpc) {
  const found = await tagOps.requireSingleTag(600);
  log(`  ${pad('tag in field')}${found.epc}  (${found.reads} reads, ${found.rssi ?? '?'}dBm)`);

  if (found.epc === targetEpc) {
    log(`  ${pad('skip')}already carries ${targetEpc}`);
    return { status: 'skipped', reason: 'already encoded', epcBefore: found.epc, epcAfter: found.epc, targetEpc };
  }

  // Capture the TID first — it is the address every subsequent step uses.
  const byEpc = uhf.filterByEpc(found.epc);
  let tidRead = tagOps.readBankQuiet({ bank: uhf.BANK.TID, ptr: 0, words: 6, filter: byEpc });
  if (tidRead.rc !== 0) tidRead = tagOps.readBankQuiet({ bank: uhf.BANK.TID, ptr: 0, words: 2, filter: byEpc });
  if (tidRead.rc !== 0) {
    // Without a TID we would have to write untargeted, which is exactly the
    // failure mode this tool exists to prevent.
    throw new Error(`cannot read TID (rc=${tidRead.rc}) — refusing to write untargeted`);
  }
  const tid = tidRead.hex;
  log(`  ${pad('TID')}${tid}`);
  const byTid = uhf.filterByTid(tid);

  if (!COMMIT) {
    log(`  ${pad('DRY RUN')}would write ${targetEpc} to EPC word ${uhf.EPC_DATA_PTR}, addressed by TID`);
    return { status: 'dry-run', tid, epcBefore: found.epc, targetEpc };
  }

  // 1. Write the EPC data itself.
  const writeRc = uhf.writeBank({ bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, dataHex: targetEpc, filter: byTid });
  log(`  ${pad('write EPC')}rc=${writeRc}`);

  // 2. Make the PC word agree with the length we just wrote. Only touched when
  //    it actually disagrees — a needless PC write is a needless risk.
  let pcNote = 'unchanged';
  const pcRead = tagOps.readBankQuiet({ bank: uhf.BANK.EPC, ptr: 1, words: 1, filter: byTid });
  if (pcRead.rc === 0 && uhf.epcWordsFromPc(pcRead.hex) !== EPC_WORDS) {
    const newPc = uhf.pcWordFor(pcRead.hex, EPC_WORDS);
    const pcRc = uhf.writeBank({ bank: uhf.BANK.EPC, ptr: 1, dataHex: newPc, filter: byTid });
    pcNote = `${pcRead.hex} -> ${newPc} (rc=${pcRc})`;
    log(`  ${pad('write PC')}${pcNote}`);
  }

  // 3. Verify. --prove-fail deliberately expects the wrong value, so a run that
  //    still reports success has a broken verifier and must not be trusted.
  const expected = PROVE_FAIL ? flipLastNibble(targetEpc) : targetEpc;
  if (PROVE_FAIL) log(`  ${pad('PROVE-FAIL')}verifying against ${expected} — this MUST fail`);

  // Oracle (a): read the bank back, still addressed by the immutable TID.
  const back = tagOps.readBankQuiet({ bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, words: EPC_WORDS, filter: byTid });
  const readBackOk = back.rc === 0 && back.hex === expected;
  log(`  ${pad('read back')}${back.hex ?? `(failed, rc=${back.rc})`}  ${readBackOk ? 'MATCH' : 'MISMATCH'}`);

  // Oracle (b): fresh singulation over the air — independent of the read path.
  const rescan = await tagOps.scanField(500);
  const airEpcs = rescan.map((t) => t.epc);
  const airOk = airEpcs.length === 1 && airEpcs[0] === expected;
  log(`  ${pad('re-inventory')}${airEpcs.join(', ') || '(nothing)'}  ${airOk ? 'MATCH' : 'MISMATCH'}`);

  const verified = writeRc === 0 && readBackOk && airOk;
  log(`  ${pad('verdict')}${verified ? 'ENCODED + VERIFIED' : 'FAILED — tag NOT confirmed'}`);

  return {
    status: verified ? 'encoded' : 'failed',
    tid,
    epcBefore: found.epc,
    epcAfter: back.hex ?? null,
    targetEpc,
    expectedForVerify: expected,
    writeRc,
    pc: pcNote,
    readBackOk,
    airOk,
    airEpcs,
    proveFail: PROVE_FAIL,
  };
}

async function main() {
  log('');
  log(COMMIT ? '*** COMMIT MODE — tags will be written ***' : 'DRY RUN — nothing will be written (add --commit to encode)');
  if (PROVE_FAIL) log('*** --prove-fail: verification is expected to FAIL. A "verified" result here is a bug. ***');

  // Resolve every EPC up front, so we never discover halfway through a batch
  // that the source is unreachable.
  const explicit = valueOf('--epc');
  let epcs;
  if (explicit) {
    epcs = [normalizeEpc(explicit, '--epc')];
  } else if (has('--nexus')) {
    epcs = (await nextNexusEpcs(COUNT)).map((e) => normalizeEpc(e, 'nexus'));
  } else {
    epcs = Array.from({ length: COUNT }, () => normalizeEpc(nextBenchEpc(), 'bench'));
  }
  log(`EPCs to write (${epcs.length}): ${epcs.join(', ')}`);

  uhf.load();
  try {
    uhf.setLogLevel(0);
  } catch (_) {
    /* non-fatal */
  }

  log('');
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

  const results = [];
  try {
    const pwrRc = uhf.setPower(POWER, false);
    log(`  ${pad('power')}set to ${POWER} dBm (rc=${pwrRc}, not persisted)`);

    for (let i = 0; i < epcs.length; i++) {
      log('');
      log(`--- tag ${i + 1} of ${epcs.length} -> ${epcs[i]} ${'-'.repeat(30)}`);
      if (i > 0) await prompt('    Place the next tag on the reader, remove the previous one, then press Enter... ');

      let record;
      try {
        record = await encodeOne(epcs[i]);
      } catch (err) {
        log(`  ${pad('ERROR')}${err.message}`);
        record = { status: 'error', reason: err.message, targetEpc: epcs[i] };
      }
      appendLedger(record);
      results.push(record);
    }
  } finally {
    uhf.disconnect();
  }

  const tally = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
  log('');
  log('--- summary ------------------------------------------------------------');
  for (const [status, n] of Object.entries(tally)) log(`  ${pad(status)}${n}`);
  log(`  ${pad('ledger')}${LEDGER_PATH}`);

  const bad = results.filter((r) => r.status === 'failed' || r.status === 'error').length;
  if (PROVE_FAIL) {
    // Inverted: this run is only meaningful if verification actually bit.
    const verified = results.filter((r) => r.status === 'encoded').length;
    log('');
    log(verified === 0 ? '  PROVE-FAIL PASSED — verification correctly rejected every tag.' : `  PROVE-FAIL BROKEN — ${verified} tag(s) reported verified against a wrong EPC.`);
    process.exit(verified === 0 ? 0 : 1);
  }
  process.exit(bad > 0 ? 1 : 0);
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
