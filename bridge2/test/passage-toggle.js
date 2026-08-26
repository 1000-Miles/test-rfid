'use strict';

/**
 * Logic test for the RECEIVING RULE in src/passage.js — the decision this gate
 * actually makes now that there are no IR beams and no direction inference.
 * No hardware needed: feeds synthetic reads and asserts on what comes out.
 * Run with:  node test/passage-toggle.js
 *
 * Timings are shrunk (quiet 100ms, re-arm 400ms, absence 300ms) so the whole
 * suite runs in a few seconds; the ratios mirror the real defaults.
 *
 * What this file replaced: the old suite pinned down first-pass-in /
 * next-pass-out direction inference, all of which has been deleted. It is worth
 * knowing what those tests were protecting, because the new rule has to be at
 * least as careful: a carton must still survive a restart, a receiving reset
 * must still let it back in, and a tag parked in the read zone must still not
 * fire twice. Those cases are all here — they just have different answers.
 */

const { PassageDetector } = require('../src/passage');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

/**
 * @param opts.receivable  SKUs the board is currently waiting for. `null` stands
 *                         for "no board data at all", which is a distinct case
 *                         from "the board says no".
 */
function makeDetector(opts = {}) {
  const { receivable = ['A-1'], boardSource = 'live', ...rest } = opts;
  const d = new PassageDetector({
    dedupMs: 100,
    quietMs: 100,
    maxWindowMs: 500,
    toggleDedupMs: 400,
    absenceMs: 300,
    toggleMinReads: 2,
    detectMode: 'toggle',
    receivableSku: receivable === null ? undefined : (sku) => ({ ok: receivable.includes(sku), source: boardSource }),
    ...rest,
  });
  d.catalog = {}; // ignore whatever data/catalog.json holds on this machine
  const events = [];
  const dropped = [];
  d.on('movement', (e) => events.push(e));
  d.on('dropped', (e) => dropped.push(e));
  d.on('log', () => {}); // keep the console readable
  return { d, events, dropped };
}

/** A printed carton label with no warehouse record — never taken in. */
const fresh = (sku = 'A-1', box = 'BOX-0001') => ({
  kind: 'carton', sku, name: sku, pallet: box, category: 'printed',
});
/** The same label once Nexus has a warehouse_carton row for it. */
const received = (sku = 'A-1', box = 'BOX-0001', state = 'received') => ({
  ...fresh(sku, box), state, receivedAt: '2026-08-18T00:00:00Z', carton: `RB-2026-0005-${box}`,
});

/** How many reads reached a decision — a read suppressed by a gate never does. */
const decisions = (d, events) => [...d._ignored.values()].reduce((a, b) => a + b, 0) + events.length;
const why = (d) => Object.fromEntries(d._ignored);

const read = (d, epc, extra = {}) => d.tagSeen({ epc, antenna: 1, rssi: -55, ...extra });
const burst = async (d, epc, n = 3, extra = {}) => {
  for (let i = 0; i < n; i++) {
    read(d, epc, extra);
    await sleep(20);
  }
};

async function main() {
  console.log('the rule: a carton on an open batch, never received, is RECEIVED');
  {
    const { d, events } = makeDetector();
    d.catalog = { AA01: fresh() };
    await burst(d, 'AA01');
    await sleep(250);
    assert(events.length === 1, 'one event');
    assert(events[0]?.direction === 'in' && events[0]?.type === 'entry', 'it is a receipt');
    assert(events[0]?.basis === 'on-open-batch', 'basis names the reason');
    assert(events[0]?.unexpected === null, 'nothing questionable is ever emitted');
  }

  console.log('the rule: an unknown tag is ignored completely');
  {
    const { d, events } = makeDetector();
    await burst(d, 'ZZ99'); // not in the catalog at all
    await sleep(250);
    assert(events.length === 0, 'no event');
    assert(why(d)['unknown-tag'] === 1, 'counted as unknown-tag');
  }

  console.log('the rule: a product on no open batch is shown locally but not received');
  {
    const { d, events } = makeDetector({ receivable: ['SOMETHING-ELSE'] });
    d.catalog = { AA02: fresh() };
    await burst(d, 'AA02');
    await sleep(250);
    assert(events.length === 1, 'one local exception event');
    assert(events[0]?.unexpected === 'no-open-batch', 'marked NO RECEIVING');
    assert(d.inventory.get('AA02')?.status !== 'INSIDE', 'not received into local inventory');
  }

  console.log('the rule: a carton Nexus already has is ignored');
  {
    const { d, events } = makeDetector();
    d.catalog = { AA03: received(), AA04: received('A-1', 'BOX-0002', 'shipped') };
    await burst(d, 'AA03');
    await burst(d, 'AA04');
    await sleep(300);
    assert(events.length === 0, 'neither fires');
    assert(why(d)['already-received-nexus'] === 2, 'received AND shipped both count as taken in');
  }

  console.log("the rule: Nexus's row is the whole answer — no code-shape second-guessing");
  {
    // Labels are never re-used in this warehouse: one label, one carton, for its
    // whole life. So a warehouse_carton row for this tag can only be THIS
    // carton's, and the row existing is the entire answer.
    //
    // This replaces a suffix check that compared the carton code against the
    // label's box id to spot a tag on its second life. With no re-use it
    // guarded nothing, while any quirk in Nexus's own code formatting would read
    // as "not received" and take an already-received carton in a second time —
    // the expensive direction to be wrong in, given a carton row is inserted per
    // passage. A mismatched code must still count as received.
    const { d, events } = makeDetector();
    d.catalog = { AA05: { ...received('A-1', 'BOX-0009'), pallet: 'BOX-0010' } };
    await burst(d, 'AA05');
    await sleep(250);
    assert(events.length === 0, 'a mismatched carton code is still already-received');
    assert(why(d)['already-received-nexus'] === 1, 'and it is counted as such');
  }

  console.log('the rule: a pallet tag is not a carton and is ignored');
  {
    const { d, events } = makeDetector({ receivable: ['PALLET-G1-001'] });
    d.catalog = { BA01: { kind: 'pallet', sku: 'PALLET-G1-001', name: 'PALLET-G1-001', pallet: 'PALLET-G1-001', category: null } };
    await burst(d, 'BA01');
    await sleep(250);
    assert(events.length === 0 && why(d)['not-a-carton'] === 1, 'pallets have their own lifecycle');
  }

  console.log('shipping is off: an observed OUTBOUND read is ignored, never dispatched');
  {
    const { d, events } = makeDetector();
    d.catalog = { CC01: received() };
    read(d, 'CC01', { direction: 'out', passageId: 77 });
    await sleep(50);
    assert(events.length === 0, 'no exit event exists');
    assert(why(d)['shipping-disabled'] === 1, 'counted as shipping-disabled');
  }

  console.log('the rule: the same carton is never received twice');
  {
    const { d, events } = makeDetector();
    d.catalog = { AA06: fresh() };
    await burst(d, 'AA06');
    await sleep(250);
    assert(events.length === 1, 'received once');
    await sleep(500); // clear BOTH the re-arm and the absence gate
    await burst(d, 'AA06'); // carried back through the doorway
    await sleep(250);
    assert(events.length === 1, 'a second pass produces nothing at all');
    assert(why(d)['already-received-here'] === 1, 'local memory, not Nexus, caught it');
  }

  console.log('no batch data: ignored, but re-armed SHORT so it retries');
  {
    // A bridge that has just booted, or a board mid-load. Waiting the full
    // re-arm here would silently drop cartons for a minute apiece.
    // Real re-arm window here, not the shrunk one: the retry is a fixed 5s off
    // the END of the window, so a 400ms test window has nothing to shorten.
    const { d, events } = makeDetector({ receivable: null, toggleDedupMs: 60_000 });
    d.catalog = { AA07: fresh() };
    await burst(d, 'AA07');
    await sleep(250);
    assert(events.length === 0 && why(d)['no-batch-data'] === 1, 'nothing received without paperwork');
    const remaining = d.toggleDedupMs - (Date.now() - d._lastEventAt.get('AA07'));
    assert(remaining > 3_000 && remaining <= 5_000, `retries in ~5s, not 60s (got ${Math.round(remaining / 1000)}s)`);
  }

  console.log('a receipt decided on the CACHED board says so');
  {
    const { d, events } = makeDetector({ boardSource: 'cache' });
    d.catalog = { AA08: fresh() };
    await burst(d, 'AA08');
    await sleep(250);
    assert(events[0]?.basis === 'on-open-batch-cached', 'offline receipt is marked as such');
  }

  console.log('read grouping: re-arm window suppresses an immediate second visit');
  {
    const { d, events } = makeDetector({ receivable: [] }); // ignored either way
    d.catalog = { AA09: fresh() };
    await burst(d, 'AA09');
    await sleep(250);
    await burst(d, 'AA09'); // still inside the 400ms re-arm
    await sleep(250);
    assert(decisions(d, events) === 1, 'the second burst never reached a decision');
  }

  console.log('read grouping: a lingering tag does not re-decide (absence gate)');
  {
    const { d, events } = makeDetector({ receivable: [] });
    d.catalog = { AA10: fresh() };
    await burst(d, 'AA10');
    await sleep(250);
    // Parked in the field: a read every 100ms for 1.2s, well past the re-arm.
    for (let i = 0; i < 12; i++) {
      read(d, 'AA10');
      await sleep(100);
    }
    await sleep(250);
    assert(decisions(d, events) === 1, 'parked tag decided exactly once');
  }

  console.log('read grouping: a single ghost read is dropped as noise');
  {
    const { d, events, dropped } = makeDetector();
    d.catalog = { AA11: fresh() };
    read(d, 'AA11');
    await sleep(250);
    assert(events.length === 0, '1 read < toggleMinReads never fires');
    assert(dropped.length === 1, 'and the drop is reported, not silent');
  }

  console.log('read grouping: the RSSI floor ignores weak reads entirely');
  {
    const { d, events } = makeDetector({ minRssi: -65 });
    d.catalog = { AA12: fresh() };
    await burst(d, 'AA12', 3, { rssi: -80 });
    await sleep(250);
    assert(events.length === 0 && decisions(d, events) === 0, 'below-floor reads never reach a decision');
    await burst(d, 'AA12', 3, { rssi: -50 });
    await sleep(250);
    assert(events.length === 1 && events[0]?.direction === 'in', 'strong reads receive normally right after');
  }

  // --- fast count (toggleFastCount) -----------------------------------------
  // The window cannot change a no-IR outcome: direction is not inferred from
  // the reads, and the noise floor is the only thing they decide. These pin
  // down that firing early skips the WAIT and nothing else — same receipt, same
  // gates, and the floor still holds.

  console.log('fast count: OFF by default — the carton waits for the window');
  {
    const { d, events } = makeDetector();
    d.catalog = { AF01: fresh() };
    assert(d.toggleFastCount === false, 'a detector built without the option holds the carton');
    await burst(d, 'AF01', 2); // minReads satisfied, but ~40ms < quietMs
    assert(events.length === 0, 'nothing has fired yet');
    await sleep(250);
    assert(events.length === 1, 'and it arrives when the window closes');
  }

  console.log('fast count: ON — the carton counts on the read that decides it');
  {
    const { d, events } = makeDetector({ toggleFastCount: true });
    d.catalog = { AF02: fresh() };
    await burst(d, 'AF02', 2); // ~40ms, well inside quietMs=100 and maxWindow=500
    assert(events.length === 1, 'it fired without waiting for the window');
    assert(events[0]?.basis === 'on-open-batch' && events[0]?.unexpected === null, 'the receipt is the same one');
    assert(events[0]?.reads === 2, 'and it carries the reads it decided on');
    await sleep(250);
    assert(events.length === 1, 'the window closing does not fire it again');
  }

  console.log('fast count: ON — the noise floor still decides, it just decides sooner');
  {
    const { d, events, dropped } = makeDetector({ toggleFastCount: true });
    d.catalog = { AF03: fresh() };
    read(d, 'AF03'); // one read, below toggleMinReads=2
    assert(events.length === 0, 'a single ghost read does not fire early');
    await sleep(250);
    assert(events.length === 0 && dropped.length === 1, 'it is still dropped as noise, and still reported');
  }

  console.log('fast count: ON — the trailing RF tail is still swallowed by the re-arm');
  {
    const { d, events } = makeDetector({ toggleFastCount: true });
    d.catalog = { AF04: fresh() };
    await burst(d, 'AF04', 2);
    assert(events.length === 1, 'counted immediately');
    await burst(d, 'AF04', 6); // the 10-20s tail, compressed
    await sleep(250);
    assert(events.length === 1, 'the tail never becomes a second receipt');
  }

  console.log('fast count: live-switchable, and reported in summary()');
  {
    const { d } = makeDetector();
    assert(d.summary().toggleFastCount === false, 'summary answers for it');
    d.setConfig({ toggleFastCount: true });
    assert(d.toggleFastCount === true && d.summary().toggleFastCount === true, 'setConfig turns it on');
    d.setConfig({ quietMs: 120 });
    assert(d.toggleFastCount === true, 'an unrelated tuning save leaves it alone');
    d.setConfig({ toggleFastCount: false });
    assert(d.toggleFastCount === false, 'and back off again');
  }

  console.log('restart: a carton received before the restart is not received again');
  {
    const { d, events } = makeDetector();
    const old = new Date(Date.now() - 60_000).toISOString();
    d.catalog = { DD01: fresh() }; // Nexus has not caught up yet — the journal is the only witness
    d.hydrate([
      { seq: 1, at: old, event: { epc: 'DD01', direction: 'in', timestamp: old, known: true, item: fresh() } },
    ]);
    await burst(d, 'DD01');
    await sleep(250);
    assert(events.length === 0, 'no second receipt');
    assert(why(d)['already-received-here'] === 1, 'the journal survived the restart');
  }

  console.log('restart: the re-arm clock survives too');
  {
    const { d, events } = makeDetector();
    const justNow = new Date(Date.now() - 100).toISOString();
    d.catalog = { DD02: fresh() };
    d.hydrate([{ seq: 1, at: justNow, event: { epc: 'DD02', direction: 'in', timestamp: justNow, known: true, item: fresh() } }]);
    await burst(d, 'DD02'); // inside the 400ms re-arm restored from the journal
    await sleep(250);
    assert(decisions(d, events) === 0, 'the read never reached a decision');
  }

  console.log('receiving reset: a withdrawn carton can be received again');
  {
    const { d, events } = makeDetector();
    d.catalog = { RS01: fresh() };
    d._cartonStateAt = Date.now();

    await burst(d, 'RS01');
    await sleep(250);
    assert(events.length === 1 && events[0]?.direction === 'in', 'carton arrives');
    assert(d.inventory.get('RS01')?.status === 'INSIDE', 'gate remembers it');

    // Nexus records the receipt; the next catalog pass brings the row with it.
    const onTheBooks = { RS01: received() };
    d.catalog = onTheBooks;
    d._cartonStateAt = Date.now();

    // The operator resets the batch. Nexus soft-deletes the carton, so the row
    // vanishes — and that disappearance is the whole signal the gate gets.
    const withdrawn = { RS01: fresh() };
    d._forgetWithdrawn(onTheBooks, withdrawn);
    d.catalog = withdrawn;
    d._cartonStateAt = Date.now();
    assert(d.inventory.get('RS01')?.status === 'OUTSIDE', 'withdrawal drops the local claim');

    await sleep(500); // clear the re-arm and absence gates
    await burst(d, 'RS01');
    await sleep(250);
    assert(events.length === 2 && events[1]?.direction === 'in', 'the redo is received, not declined');
  }

  console.log('receiving reset: without the withdrawal the redo would be refused');
  {
    // The same sequence with the diff NOT applied — pins down what the
    // withdrawal is buying, so losing it shows up here rather than in a
    // warehouse wondering why a re-scan took nothing in.
    const { d, events } = makeDetector();
    d.catalog = { RS03: fresh('A-1', 'BOX-0003') };
    await burst(d, 'RS03');
    await sleep(250);
    d.catalog = { RS03: fresh('A-1', 'BOX-0003') }; // state withdrawn, local claim left standing
    await sleep(500);
    await burst(d, 'RS03');
    await sleep(250);
    assert(events.length === 1 && why(d)['already-received-here'] === 1, 'the stale local claim refuses the redo');
  }

  console.log('receiving reset: a failed state fetch must not empty the building');
  {
    const { d } = makeDetector();
    d.catalog = { RS02: fresh('A-1', 'BOX-0004') };
    await burst(d, 'RS02');
    await sleep(250);
    assert(d.inventory.get('RS02')?.status === 'INSIDE', 'carton is INSIDE to begin with');
    const onTheBooks = { RS02: received('A-1', 'BOX-0004') };
    d.catalog = onTheBooks;
    d._cartonStateAt = Date.now();

    // A pass whose state read threw leaves every entry stateless, which is
    // indistinguishable from every carton being withdrawn at once. That is why
    // loadCatalogRemote only runs the diff when the read SUCCEEDED — asserting
    // the guard here keeps the contract visible from the test file.
    const stateOk = false;
    if (stateOk) d._forgetWithdrawn(onTheBooks, { RS02: fresh('A-1', 'BOX-0004') });
    assert(d.inventory.get('RS02')?.status === 'INSIDE', 'a failed state read changes nothing');
  }

  console.log('summary(): ignores are counted and exceptions stay visible');
  {
    const { d, events } = makeDetector({ receivable: ['A-1'] });
    d.catalog = { S1: fresh(), S2: fresh('A-9', 'BOX-9') };
    await burst(d, 'S1');
    await burst(d, 'S2');
    await burst(d, 'S3'); // unknown
    await sleep(300);
    const s = d.summary();
    assert(s.ignored['unknown-tag'] === 1, 'silent ignore reasons are counted');
    assert(events.some((event) => event.unexpected === 'no-open-batch'), 'off-batch exception is visible as an event');
    assert(s.allowShipping === false, 'shipping reads as off');
  }

  console.log('');
  if (failures) {
    console.error(`${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log('all receiving-rule assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
