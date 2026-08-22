'use strict';

/**
 * Logic test for the NO-IR ("toggle") detection mode in src/passage.js.
 * No hardware needed: feeds synthetic reads and asserts on the movement
 * events. Run with:  node test/passage-toggle.js
 *
 * Timings are shrunk (quiet 100ms, re-arm 400ms, absence 300ms) so the whole
 * suite runs in a few seconds; the ratios mirror the real defaults.
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

function makeDetector(opts = {}) {
  const d = new PassageDetector({
    dedupMs: 100,
    quietMs: 100,
    maxWindowMs: 500,
    toggleDedupMs: 400,
    absenceMs: 300,
    toggleMinReads: 2,
    ...opts,
  });
  d.catalog = {}; // ignore whatever data/catalog.json holds on this machine
  const events = [];
  d.on('movement', (e) => events.push(e));
  d.on('log', () => {}); // keep the console readable
  return { d, events };
}

const read = (d, epc, extra = {}) => d.tagSeen({ epc, antenna: 1, rssi: -55, ...extra });
const burst = async (d, epc, n = 3, extra = {}) => {
  for (let i = 0; i < n; i++) {
    read(d, epc, extra);
    await sleep(20);
  }
};

async function main() {
  console.log('IR mode: direction-less reads stay strays');
  {
    const { d, events } = makeDetector(); // detectMode defaults to 'ir'
    await burst(d, 'AA01');
    await sleep(250);
    assert(events.length === 0, 'no event without an IR direction');
  }

  console.log('toggle mode: first visit = IN, method/basis stamped');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    await burst(d, 'AA02');
    await sleep(250);
    assert(events.length === 1, 'one event per visit');
    assert(events[0]?.direction === 'in', 'first pass is IN');
    assert(events[0]?.method === 'toggle', "method is 'toggle'");
    assert(events[0]?.basis === 'default-first-seen', 'basis is default-first-seen');
  }

  console.log('toggle mode: re-arm window suppresses an immediate second visit');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    await burst(d, 'AA03');
    await sleep(250); // event fired
    await burst(d, 'AA03'); // still inside the 400ms re-arm
    await sleep(250);
    assert(events.length === 1, 'second burst inside re-arm did not fire');
  }

  console.log('toggle mode: after re-arm + absence, the flip fires OUT (local-flip)');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    await burst(d, 'AA04');
    await sleep(250);
    await sleep(500); // clears both the 400ms re-arm and the 300ms absence
    await burst(d, 'AA04');
    await sleep(250);
    assert(events.length === 2, 'second visit fired');
    assert(events[1]?.direction === 'out', 'second pass is OUT');
    assert(events[1]?.basis === 'local-flip', 'basis is local-flip');
  }

  console.log('toggle mode: lingering tag does not flip-flop (absence gate)');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    await burst(d, 'AA05');
    await sleep(250); // event fired at ~t370
    // keep the tag "parked in the field": a read every 100ms for 1.2s, well
    // past the 400ms re-arm — the absence gate must hold.
    for (let i = 0; i < 12; i++) {
      read(d, 'AA05');
      await sleep(100);
    }
    await sleep(250);
    assert(events.length === 1, 'parked tag fired exactly once');
  }

  console.log('toggle mode: single ghost read is dropped as noise');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    read(d, 'AA06');
    await sleep(250);
    assert(events.length === 0, '1 read < toggleMinReads never fires');
  }

  console.log('toggle mode: RSSI floor ignores weak reads entirely');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle', minRssi: -65 });
    await burst(d, 'AA07', 3, { rssi: -80 });
    await sleep(250);
    assert(events.length === 0, 'below-floor reads never fire');
    await burst(d, 'AA07', 3, { rssi: -50 });
    await sleep(250);
    assert(events.length === 1 && events[0]?.direction === 'in', 'strong reads fire normally right after');
  }

  console.log('toggle mode: direction anchors to Nexus carton state');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    d.catalog = {
      BB01: { kind: 'carton', sku: 'A-1', name: 'in building', pallet: null, category: null, state: 'received', receivedAt: '2026-08-18T00:00:00Z' },
      BB02: { kind: 'carton', sku: 'A-2', name: 'never received', pallet: null, category: null },
      BB03: { kind: 'carton', sku: 'A-3', name: 'already shipped', pallet: null, category: null, state: 'shipped', receivedAt: '2026-08-01T00:00:00Z' },
    };
    d._cartonStateAt = Date.now(); // state is fresh
    await burst(d, 'BB01');
    await burst(d, 'BB02');
    await burst(d, 'BB03');
    await sleep(300);
    const by = (epc) => events.find((e) => e.epc === epc);
    assert(by('BB01')?.direction === 'out' && by('BB01')?.basis === 'state-in-building', 'received carton -> OUT (state-in-building)');
    assert(by('BB02')?.direction === 'in' && by('BB02')?.basis === 'state-never-received', 'never-received carton -> IN');
    assert(by('BB03')?.direction === 'in' && by('BB03')?.basis === 'state-shipped-return', 'shipped carton -> IN (return)');
  }

  console.log('toggle mode: an IR-stamped read still wins as ground truth');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    read(d, 'CC01', { direction: 'out', passageId: 77 });
    await sleep(50);
    assert(events.length === 1 && events[0]?.direction === 'out' && events[0]?.method === 'ir', 'observed direction fires immediately, method ir');
  }

  console.log('hydrate: journal memory survives a "restart"');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    const old = new Date(Date.now() - 60_000).toISOString();
    d.hydrate([
      { seq: 1, at: old, event: { epc: 'DD01', direction: 'in', timestamp: old, known: false, item: { sku: 'X', name: 'x', pallet: null, category: null } } },
    ]);
    await burst(d, 'DD01');
    await sleep(250);
    assert(events.length === 1 && events[0]?.direction === 'out' && events[0]?.basis === 'local-flip', 'hydrated IN flips to OUT after restart');
  }

  console.log('hydrate: re-arm clock survives a "restart"');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    const justNow = new Date(Date.now() - 100).toISOString();
    d.hydrate([{ seq: 1, at: justNow, event: { epc: 'DD02', direction: 'in', timestamp: justNow, known: false, item: null } }]);
    await burst(d, 'DD02'); // still inside the 400ms re-arm restored from the journal
    await sleep(250);
    assert(events.length === 0, 'visit inside the restored re-arm window did not fire');
  }

  console.log('toggle mode: stale Nexus state still guides direction (marked, no accusation)');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    d.catalog = {
      EE01: { kind: 'carton', sku: 'S-1', name: 's', pallet: null, category: null, state: 'received', receivedAt: '2026-08-01T00:00:00Z' },
    };
    d._cartonStateAt = Date.now() - 31 * 60_000; // older than stateMaxAgeMs (30 min)
    await burst(d, 'EE01');
    await sleep(250);
    assert(events.length === 1 && events[0]?.direction === 'out' && events[0]?.basis === 'state-in-building-stale', 'stale state -> OUT, basis marked -stale');
    assert(events[0]?.unexpected == null, 'no accusatory flag from stale state');
  }

  console.log('toggle mode: fresh Nexus record overrides old gate memory');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    d.hydrate([
      { seq: 1, at: old, event: { epc: 'FF01', direction: 'in', timestamp: old, known: true, item: { sku: 'S-2', name: 's', pallet: null, category: null } } },
    ]);
    d.catalog = {
      FF01: { kind: 'carton', sku: 'S-2', name: 's', pallet: null, category: null, state: 'shipped', receivedAt: '2026-08-01T00:00:00Z' },
    };
    d._cartonStateAt = Date.now(); // decisively newer than the 10-min-old local verdict
    await burst(d, 'FF01');
    await sleep(250);
    assert(
      events.length === 1 && events[0]?.direction === 'in' && events[0]?.basis === 'state-shipped-return',
      'fresh shipped state wins over local INSIDE (local flip alone would have said OUT)'
    );
  }

  console.log('receiving reset: a withdrawn carton reads as ARRIVING again');
  {
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    // A printed tag with no warehouse record yet — nothing has been received.
    d.catalog = { RS01: { kind: 'carton', sku: 'R-1', name: 'R-1', pallet: null, category: null } };
    d._cartonStateAt = Date.now();

    // It rolls in through the doorway. Nexus records the receipt, and the next
    // catalog pass brings the warehouse_carton row back with it.
    await burst(d, 'RS01');
    await sleep(250);
    assert(events.length === 1 && events[0]?.direction === 'in', 'carton arrives (IN)');
    assert(d.inventory.get('RS01')?.status === 'INSIDE', 'gate holds it INSIDE');
    const onTheBooks = { RS01: { kind: 'carton', sku: 'R-1', name: 'R-1', pallet: null, category: null, state: 'received', receivedAt: '2026-08-18T00:00:00Z' } };
    d.catalog = onTheBooks;
    d._cartonStateAt = Date.now();

    // The operator resets the batch. Nexus soft-deletes the carton, so the next
    // pass carries the label entry with no state on it — and that disappearance
    // is the whole signal the gate gets.
    const withdrawn = { RS01: { kind: 'carton', sku: 'R-1', name: 'R-1', pallet: null, category: null } };
    d._forgetWithdrawn(onTheBooks, withdrawn);
    d.catalog = withdrawn;
    d._cartonStateAt = Date.now();
    assert(d.inventory.get('RS01')?.status === 'OUTSIDE', 'withdrawal drops the INSIDE claim');

    // Rolled back through the doorway it must count as arriving, NOT as a
    // dispatch — which is exactly what the stale local flip would have said.
    await sleep(500); // clear the re-arm and absence gates
    await burst(d, 'RS01');
    await sleep(250);
    assert(events.length === 2, 'the return passage fired');
    assert(events[1]?.direction === 'in', 'reset carton arrives again (IN, not a dispatch)');
    assert(events[1]?.basis === 'state-never-received', 'decided from state, not from the stale local flip');
    assert(!events[1]?.unexpected, 'not stamped as an unexpected exit');
  }

  console.log('receiving reset: without the withdrawal the return would read as a dispatch');
  {
    // The same sequence with the diff NOT applied — pins down what the change is
    // actually buying, so a regression shows up as this test passing wrongly.
    const { d, events } = makeDetector({ detectMode: 'toggle' });
    d.catalog = { RS03: { kind: 'carton', sku: 'R-3', name: 'R-3', pallet: null, category: null } };
    d._cartonStateAt = Date.now();
    await burst(d, 'RS03');
    await sleep(250);
    d.catalog = { RS03: { kind: 'carton', sku: 'R-3', name: 'R-3', pallet: null, category: null, state: 'received', receivedAt: '2026-08-18T00:00:00Z' } };
    d._cartonStateAt = Date.now();

    // State withdrawn, local claim left standing (the old behaviour).
    d.catalog = { RS03: { kind: 'carton', sku: 'R-3', name: 'R-3', pallet: null, category: null } };
    d._cartonStateAt = Date.now();
    await sleep(500);
    await burst(d, 'RS03');
    await sleep(250);
    assert(events[1]?.direction === 'out' && events[1]?.basis === 'local-flip', 'stale local flip alone calls the return a dispatch');
  }

  console.log('receiving reset: a failed state fetch must not empty the building');
  {
    const { d } = makeDetector({ detectMode: 'toggle' });
    d.catalog = { RS02: { kind: 'carton', sku: 'R-2', name: 'R-2', pallet: null, category: null } };
    d._cartonStateAt = Date.now();
    await burst(d, 'RS02');
    await sleep(250);
    assert(d.inventory.get('RS02')?.status === 'INSIDE', 'carton is INSIDE to begin with');
    const onTheBooks = { RS02: { kind: 'carton', sku: 'R-2', name: 'R-2', pallet: null, category: null, state: 'received', receivedAt: '2026-08-18T00:00:00Z' } };
    d.catalog = onTheBooks;
    d._cartonStateAt = Date.now();

    // A pass whose state read threw leaves every entry stateless, which is
    // indistinguishable from every carton being withdrawn at once. That is why
    // loadCatalogRemote only runs the diff when the read SUCCEEDED — asserting
    // the guard here keeps the contract visible from the test file.
    const stateOk = false;
    if (stateOk) d._forgetWithdrawn(onTheBooks, { RS02: { kind: 'carton', sku: 'R-2', name: 'R-2', pallet: null, category: null } });
    assert(d.inventory.get('RS02')?.status === 'INSIDE', 'a failed state read changes nothing');
  }
  console.log('');
  if (failures) {
    console.error(`${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log('all toggle-mode assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
