'use strict';

/**
 * Measure where writes actually stop working, so the UI's signal bands come
 * from this rig instead of from someone's judgement.
 *
 * Tag Station shows a signal band next to each scanned tag, and the first cut
 * of those thresholds was guessed — it called -62dBm "weak" when a tag flat on
 * metal, the best position available, reads exactly there. A warning that fires
 * during normal operation is worse than no warning: people learn to ignore it.
 *
 * Rather than move the tag around and eyeball it, this steps the READER POWER
 * down. Lower power means a weaker link and a lower RSSI, with the tag left
 * exactly where it is — so the sweep is repeatable and the only variable is
 * signal. At each step it records the RSSI and whether a single un-retried
 * write lands, then reports the cliff.
 *
 * Writes are the tag's OWN current EPC written back, so the tag is unchanged
 * whatever happens. Retry is explicitly disabled (attempts: 1) — the point is
 * to find the raw failure point, not what retry can paper over.
 *
 * Usage:
 *   node test/calibrate-signal.js
 *   node test/calibrate-signal.js --from 30 --to 5 --step 2 --trials 5
 *
 * Run it with the bridge STOPPED — both drive the same USB device.
 */

const uhf = require('../src/uhf');
const tagOps = require('../src/tag-ops');
const { autoConnect, NO_READER_HELP } = require('../src/reader-connect');

const argv = process.argv.slice(2);
const valueOf = (f, d) => {
  const i = argv.indexOf(f);
  return i === -1 ? d : Number(argv[i + 1]);
};

const FROM = valueOf('--from', 30);
const TO = valueOf('--to', 5);
const STEP = Math.max(1, valueOf('--step', 2));
const TRIALS = Math.max(1, valueOf('--trials', 5));

const log = (...a) => console.log(...a);

async function main() {
  log('');
  uhf.load();
  try {
    uhf.setLogLevel(0);
  } catch (_) {
    /* non-fatal */
  }

  const com = argv.indexOf('--com') === -1 ? null : Number(argv[argv.indexOf('--com') + 1]);
  const { ok } = autoConnect({ com, onAttempt: (line) => log(`  ${line}`) });
  if (!ok) {
    log('');
    log(NO_READER_HELP);
    process.exit(2);
  }

  let originalPower = null;
  const rows = [];
  try {
    originalPower = uhf.getPower();
    const tag = await tagOps.requireSingleTag(700);
    log('');
    log(`  tag ${tag.epc}`);
    log(`  leaving it exactly where it is — only reader power changes`);
    log('');
    log('  power   RSSI      writes      verdict');
    log('  ' + '-'.repeat(48));

    for (let dBm = FROM; dBm >= TO; dBm -= STEP) {
      if (uhf.setPower(dBm, false) !== 0) {
        log(`  ${String(dBm).padStart(2)}dBm   (reader refused this power)`);
        continue;
      }

      // Re-read at this power: RSSI is what the UI will actually show.
      let seen = null;
      try {
        seen = await tagOps.requireSingleTag(500);
      } catch (_) {
        log(`  ${String(dBm).padStart(2)}dBm   no read    —           tag not detected at all`);
        rows.push({ dBm, rssi: null, ok: 0, trials: 0 });
        continue;
      }

      let passed = 0;
      const byTid = (() => {
        const t = tagOps.readBankQuiet({ bank: uhf.BANK.TID, ptr: 0, words: 6, filter: uhf.filterByEpc(seen.epc) });
        return t.rc === 0 ? uhf.filterByTid(t.hex) : null;
      })();

      for (let i = 0; i < TRIALS; i++) {
        // Single attempt, no retry — we want the raw cliff.
        let rc = -1;
        try {
          rc = uhf.writeBank({ bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, dataHex: seen.epc, filter: byTid });
        } catch (_) {
          rc = -1;
        }
        const back = tagOps.readBankQuiet({ bank: uhf.BANK.EPC, ptr: uhf.EPC_DATA_PTR, words: seen.epc.length / 4, filter: byTid });
        if (rc === 0 && back.hex === seen.epc) passed++;
        await tagOps.sleep(60);
      }

      const pct = Math.round((passed / TRIALS) * 100);
      const verdict = pct === 100 ? 'reliable' : pct >= 60 ? 'marginal' : pct > 0 ? 'failing' : 'DEAD';
      log(`  ${String(dBm).padStart(2)}dBm   ${String(seen.rssi ?? '?').padStart(6)}    ${passed}/${TRIALS} (${String(pct).padStart(3)}%)   ${verdict}`);
      rows.push({ dBm, rssi: seen.rssi, ok: passed, trials: TRIALS });
    }

    // --- where the cliff is ------------------------------------------------
    const withRssi = rows.filter((r) => r.rssi != null);
    const reliable = withRssi.filter((r) => r.ok === r.trials);
    const dead = withRssi.filter((r) => r.ok === 0);
    const weakestReliable = reliable.length ? Math.min(...reliable.map((r) => r.rssi)) : null;
    const strongestDead = dead.length ? Math.max(...dead.map((r) => r.rssi)) : null;

    log('');
    log('  --- result -----------------------------------------------------');
    if (weakestReliable != null) log(`  Writes were 100% reliable down to ${weakestReliable} dBm.`);
    if (strongestDead != null) log(`  Writes failed completely at and below ${strongestDead} dBm.`);
    if (weakestReliable != null && strongestDead != null) {
      log(`  The cliff sits between ${strongestDead} and ${weakestReliable} dBm.`);
      log('');
      log('  Suggested bands for signalBand() in tag-station-client.tsx:');
      log(`    Strong  >= ${Math.round(weakestReliable + 6)}`);
      log(`    Good    >= ${Math.round(weakestReliable)}`);
      log(`    Weak    >= ${Math.round(strongestDead)}`);
      log(`    Very weak below that`);
    } else if (weakestReliable != null) {
      log('  Writes never failed in this sweep — the reader could not be turned down');
      log('  far enough to find the cliff. Move the tag further away and re-run.');
    }
  } finally {
    if (originalPower != null) {
      try {
        uhf.setPower(originalPower, false);
        log('');
        log(`  Restored reader power to ${originalPower} dBm.`);
      } catch (_) {
        /* best effort */
      }
    }
    uhf.disconnect();
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
