'use strict';

/**
 * Offline-sync hardening tests for src/outbox.js + src/atomic-write.js.
 * No network, no hardware: every Outbox here runs against a scratch data
 * directory (never the live journal) with no URL configured, so the pump
 * never attempts delivery unless a test stubs _send itself.
 *
 * Run with:  node test/outbox-offline.js
 */

const fs = require('fs');
const path = require('path');
const { Outbox } = require('../src/outbox');
const { writeFileAtomic } = require('../src/atomic-write');

const SCRATCH = path.join(__dirname, `tmp-outbox-${process.pid}`);
const LOG = path.join(SCRATCH, 'movement-log.jsonl');
const QUARANTINE = `${LOG}.quarantine`;

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`);
  }
}

function freshScratch() {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  fs.mkdirSync(SCRATCH, { recursive: true });
}

const makeOutbox = () => new Outbox({ dataDir: SCRATCH, gateId: 'test-gate', log: () => {} });

async function main() {
  console.log('event identity: stamped once, survives restart and replay');
  {
    freshScratch();
    let o = makeOutbox();
    const r = o.enqueue({ epc: 'AA01', direction: 'in', timestamp: '2026-08-19T00:00:00.000Z' });
    assert(r.seq === 1 && r.eventId === 'test-gate:1', 'enqueue returns seq + eventId');
    o.stop();

    o = makeOutbox(); // "restart"
    assert(o.pending.length === 1, 'offline enqueue survives restart');
    assert(o.pending[0].event.eventId === 'test-gate:1', 'eventId in the restored entry is byte-identical');
    assert(o.pending[0].event.gateId === 'test-gate' && o.pending[0].event.seq === 1, 'gateId and seq persisted');
    const r2 = o.enqueue({ epc: 'AA02', direction: 'out', timestamp: '2026-08-19T00:01:00.000Z' });
    assert(r2.eventId === 'test-gate:2', 'seq continues after restart, no reuse');
    o.stop();
  }

  console.log('torn tail: fragment quarantined, journal truncated, appends stay readable');
  {
    freshScratch();
    let o = makeOutbox();
    o.enqueue({ epc: 'BB01', direction: 'in', timestamp: '2026-08-19T00:00:00.000Z' });
    o.stop();
    // Simulate a crash mid-append: a partial record with no newline.
    fs.appendFileSync(LOG, '{"seq":2,"at":"2026-08-19T00:00:01.000Z","event":{"epc":"BB0');

    o = makeOutbox(); // boot repairs
    assert(o.status().journal.tornRecovered === 1, 'torn tail detected and recovered');
    assert(fs.existsSync(QUARANTINE), 'fragment quarantined for diagnosis');
    assert(o.pending.length === 1 && o.pending[0].event.epc === 'BB01', 'valid record survived the repair');
    assert(o.nextSeq === 2, 'nextSeq derived from valid records only');
    const r = o.enqueue({ epc: 'BB02', direction: 'out', timestamp: '2026-08-19T00:02:00.000Z' });
    assert(r.eventId === 'test-gate:2', 'post-repair append reuses the quarantined seq cleanly');
    o.stop();

    o = makeOutbox(); // second restart: the glued-append bug would bite HERE
    assert(o.status().journal.tornRecovered === 0, 'no repair needed after a clean append');
    assert(o.pending.length === 2 && o.pending[1].event.epc === 'BB02', 'record appended after repair is readable');
    o.stop();
  }

  console.log('torn tail: valid final record missing its newline gets terminated');
  {
    freshScratch();
    let o = makeOutbox();
    o.enqueue({ epc: 'CC01', direction: 'in', timestamp: '2026-08-19T00:00:00.000Z' });
    o.stop();
    // Strip the trailing newline — a partial write can end exactly at the brace.
    const text = fs.readFileSync(LOG, 'utf8');
    fs.writeFileSync(LOG, text.replace(/\n$/, ''));

    o = makeOutbox();
    assert(o.status().journal.tornRecovered === 1, 'unterminated final record detected');
    o.enqueue({ epc: 'CC02', direction: 'out', timestamp: '2026-08-19T00:01:00.000Z' });
    o.stop();
    o = makeOutbox();
    assert(o.pending.length === 2, 'both records readable — no glued line');
    o.stop();
  }

  console.log('interior corruption: delivery pauses, durability continues');
  {
    freshScratch();
    let o = makeOutbox();
    o.enqueue({ epc: 'DD01', direction: 'in', timestamp: '2026-08-19T00:00:00.000Z' });
    o.enqueue({ epc: 'DD02', direction: 'out', timestamp: '2026-08-19T00:01:00.000Z' });
    o.stop();
    // Corrupt the FIRST record while the second stays valid = interior damage.
    const lines = fs.readFileSync(LOG, 'utf8').split('\n');
    lines[0] = 'GARBAGE-NOT-JSON';
    fs.writeFileSync(LOG, lines.join('\n'));

    o = makeOutbox();
    assert(o.status().journal.corrupt === true, 'interior corruption flagged');
    assert(o.status().journal.healthy === false, 'journal reported unhealthy');
    // Pump must refuse to run even with a URL and a working sender.
    o.url = 'http://example.invalid/api/movement';
    let sendCalls = 0;
    o._send = async () => {
      sendCalls += 1;
      return { ok: true };
    };
    await o._pump();
    assert(sendCalls === 0, 'delivery is paused — nothing sent around the bad record');
    // Durability first: appends must still journal.
    const r = o.enqueue({ epc: 'DD03', direction: 'in', timestamp: '2026-08-19T00:02:00.000Z' });
    assert(r.seq > 0, 'enqueue still journals while delivery is paused');
    o.stop();
  }

  console.log('atomic write: replaces content completely, leaves no temp files');
  {
    freshScratch();
    const target = path.join(SCRATCH, 'cursor.json');
    fs.writeFileSync(target, '{"seq":1}\n');
    writeFileAtomic(target, '{"seq":2}\n');
    assert(fs.readFileSync(target, 'utf8') === '{"seq":2}\n', 'content replaced');
    const leftovers = fs.readdirSync(SCRATCH).filter((f) => f.includes('.tmp-'));
    assert(leftovers.length === 0, 'no temp files left behind');
  }

  console.log('cursor: delivered events advance it; restart resumes after it');
  {
    freshScratch();
    let o = makeOutbox();
    o.enqueue({ epc: 'EE01', direction: 'in', timestamp: '2026-08-19T00:00:00.000Z' });
    o.enqueue({ epc: 'EE02', direction: 'out', timestamp: '2026-08-19T00:01:00.000Z' });
    o.url = 'http://example.invalid/api/movement';
    o.drainPerSec = 1000; // don't wait between sends in the test
    const delivered = [];
    o._send = async (entry) => {
      delivered.push(entry.event.eventId);
      if (delivered.length === 1) return { ok: true };
      o._stopped = true; // end the retry loop — a real refusal would retry forever
      return { ok: false, terminal: false, error: 'refused' };
    };
    o.baseBackoffMs = 10;
    o._backoff = 10;
    await o._pump();
    o.stop();
    assert(delivered[0] === 'test-gate:1', 'strict order: seq 1 sent first');
    assert(o.cursor === 1, 'cursor advanced only past the delivered event');

    o = makeOutbox();
    assert(o.pending.length === 1 && o.pending[0].event.eventId === 'test-gate:2', 'restart resumes at the undelivered event, same id');
    o.stop();
  }

  console.log('protocol acknowledgement: only matching Nexus JSON advances');
  {
    freshScratch();
    const o = makeOutbox();
    o.url = 'http://nexus.test/api/movement';
    const entry = { event: { eventId: 'test-gate:9' } };
    const originalFetch = global.fetch;
    try {
      global.fetch = async () => new Response('<html>proxy page</html>', { status: 200 });
      let r = await o._send(entry);
      assert(!r.ok && /invalid JSON/.test(r.error), 'HTML 200 is retryable, not delivered');

      global.fetch = async () => Response.json({ ok: true, state: 'applied', eventId: 'another-gate:9' });
      r = await o._send(entry);
      assert(!r.ok && /mismatch/.test(r.error), 'mismatched eventId is retryable');

      global.fetch = async () => Response.json({ ok: true, state: 'mystery', eventId: 'test-gate:9' });
      r = await o._send(entry);
      assert(!r.ok && /invalid acknowledgement/.test(r.error), 'unknown state is retryable');

      global.fetch = async () => Response.json(
        { ok: true, state: 'accepted', eventId: 'test-gate:9' },
        { status: 202 }
      );
      r = await o._send(entry);
      assert(!r.ok, 'durable-but-pending 202 stays queued until effects apply');

      global.fetch = async () => Response.json({ ok: true, state: 'applied', eventId: 'test-gate:9' });
      r = await o._send(entry);
      assert(r.ok && r.state === 'applied', 'matching applied acknowledgement is delivered');
    } finally {
      global.fetch = originalFetch;
      o.stop();
    }
  }

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log('');
  if (failures) {
    console.error(`${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log('all offline-sync assertions passed');
}

main().catch((err) => {
  console.error(err);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(1);
});
