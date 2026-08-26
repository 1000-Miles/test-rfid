'use strict';

/**
 * Isolated test for the closed-loop print verification (TCP transport).
 *
 * There is NO real printer here: a tiny fake TCP server speaks just the slice of
 * the ZPL contract we rely on — it accepts a label + `~HQES` query and answers a
 * "PRINTER STATUS" block whose error flags we arm per scenario. That reply is the
 * independent oracle: the bridge can only pass a scenario by actually reading and
 * acting on what the fake printer reported.
 *
 *   node test/verify-closed-loop.js
 *
 * Covers: healthy → success; paper-out → halt (throws, nothing logged); RFID void
 * → reprint once → heal → success; mute printer → degrade (success, unconfirmed).
 * Plus a "prove it bites" pair: paper-out is SILENTLY accepted with verify off,
 * and CAUGHT with verify on — so the check is falsifiable, not decorative.
 */

const net = require('net');
const assert = require('assert');
const { PrinterManager } = require('../src/printer');

// ── Fake TCP ZPL printer ─────────────────────────────────────────────────────
// `plan` is a function(queryIndex) → status-flags string "HHHHHHHH LLLLLLLL" for
// the Nth ~HQES query, or null to stay silent (mute printer). Records every label
// it "printed" (each write containing ^XA) as physical ground truth.
function fakePrinter(plan) {
  const printed = [];
  let queries = 0;
  const server = net.createServer((sock) => {
    sock.on('data', (buf) => {
      const s = buf.toString('latin1');
      if (/\^XA/.test(s)) printed.push(s);
      if (/~HQES/.test(s)) {
        const flags = plan(queries++);
        if (flags == null) return; // mute: answer nothing
        sock.write(`\r\nPRINTER STATUS\r\n ERRORS:   1 ${flags}\r\n WARNINGS: 1 00000000 00000000\r\n`);
      }
    });
    sock.on('error', () => {});
  });
  return {
    printed,
    listen: () =>
      new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port))),
    close: () => new Promise((res) => server.close(res)),
  };
}

// Build a manager wired to the fake printer, with disk writes stubbed out.
function mgr(port, verify = true) {
  const pm = new PrinterManager({ log: () => {} });
  pm._save = () => {};
  pm._appendLog = (e) => pm._logged.push(e);
  pm._logged = [];
  pm.readPrintLog = ({ jobId } = {}) => pm._logged.filter((e) => !jobId || e.jobId === jobId);
  pm.setConfig({ transport: 'tcp', host: '127.0.0.1', port, verify, reprintRetries: 1 });
  return pm;
}

const HEALTHY = '00000000 00000000';
const PAPER_OUT = '00000000 00000001'; // lo bit0 → media out (hardware → halt)
const RFID_VOID = '00000004 00000000'; // hi group → rfid/other (recoverable → reprint)

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

async function main() {
  // 1. Healthy → success, confirmed, exactly one label printed + one log entry.
  {
    const fp = fakePrinter(() => HEALTHY);
    const port = await fp.listen();
    const pm = mgr(port);
    const r = await pm.printLabel({ epc: 'AA00000000000000000000A1' });
    assert.equal(r.confirmed, true, 'should be confirmed');
    assert.equal(fp.printed.length, 1, 'exactly one physical label');
    assert.equal(pm._logged.length, 1, 'exactly one durable log entry');
    await fp.close();
    ok('healthy → success (confirmed, logged once)');
  }

  // 2. Paper-out → hardware halt: throws, and NOTHING is logged as printed.
  {
    const fp = fakePrinter(() => PAPER_OUT);
    const port = await fp.listen();
    const pm = mgr(port);
    await assert.rejects(
      () => pm.printLabel({ epc: 'AA00000000000000000000A2' }),
      /paper out/i,
      'should halt on paper out',
    );
    assert.equal(pm._logged.length, 0, 'a halted print must NOT be logged as printed');
    await fp.close();
    ok('paper-out → halt (throws, not logged)');
  }

  // 3. RFID void then heal → reprints the same EPC once, then succeeds.
  {
    const fp = fakePrinter((i) => (i === 0 ? RFID_VOID : HEALTHY));
    const port = await fp.listen();
    const pm = mgr(port);
    const r = await pm.printLabel({ epc: 'AA00000000000000000000A3' });
    assert.equal(r.confirmed, true, 'heals on reprint');
    assert.equal(fp.printed.length, 2, 'the carton was printed twice (void + reprint)');
    assert.equal(pm._logged.length, 1, 'but recorded once');
    await fp.close();
    ok('rfid void → reprint once → heal (printed twice, logged once)');
  }

  // 4. Persistent void → exhausts the 1 reprint, then halts (nothing logged).
  {
    const fp = fakePrinter(() => RFID_VOID);
    const port = await fp.listen();
    const pm = mgr(port);
    await assert.rejects(
      () => pm.printLabel({ epc: 'AA00000000000000000000A4' }),
      /not confirmed/i,
      'should give up after retries',
    );
    assert.equal(fp.printed.length, 2, 'original + one reprint = 2 attempts');
    assert.equal(pm._logged.length, 0, 'unresolved → not logged');
    await fp.close();
    ok('persistent void → halt after 1 reprint (not logged)');
  }

  // 5. Mute printer (ignores ~HQES) → degrade: success but unconfirmed.
  {
    const fp = fakePrinter(() => null);
    const port = await fp.listen();
    const pm = mgr(port);
    const r = await pm.printLabel({ epc: 'AA00000000000000000000A5' });
    assert.equal(r.confirmed, false, 'degraded mode is unconfirmed');
    assert.equal(pm._logged.length, 1, 'still logged (no-confirm fallback)');
    await fp.close();
    ok('mute printer → degrade (success, unconfirmed)');
  }

  // 6. PROVE IT BITES: same paper-out fault. With verify OFF it is silently
  //    accepted (the old bug); with verify ON it is caught. If the check were
  //    inert, the verify-off and verify-on results would match — they must not.
  {
    const fpOff = fakePrinter(() => PAPER_OUT);
    const portOff = await fpOff.listen();
    const pmOff = mgr(portOff, /* verify */ false);
    const rOff = await pmOff.printLabel({ epc: 'AA00000000000000000000A6' });
    assert.ok(rOff && pmOff._logged.length === 1, 'verify OFF: paper-out slips through as "printed"');
    await fpOff.close();

    const fpOn = fakePrinter(() => PAPER_OUT);
    const portOn = await fpOn.listen();
    const pmOn = mgr(portOn, /* verify */ true);
    let caught = false;
    try { await pmOn.printLabel({ epc: 'AA00000000000000000000A7' }); }
    catch { caught = true; }
    assert.ok(caught && pmOn._logged.length === 0, 'verify ON: the same fault is caught');
    await fpOn.close();
    ok('prove-it-bites: fault slips through with verify OFF, caught with verify ON');
  }

  // 7. Pallet labels are barcode-only, durable, and idempotent by passage job.
  {
    const fp = fakePrinter(() => HEALTHY);
    const port = await fp.listen();
    const pm = mgr(port, false);
    const first = await pm.printPalletTag({ palletCode: 'PLT-TEST-GATE-00000042', jobId: 'test-gate:passage:42' });
    const replay = await pm.printPalletTag({ palletCode: 'PLT-TEST-GATE-00000042', jobId: 'test-gate:passage:42' });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(fp.printed.length, 1, 'same offline passage prints once');
    assert.equal(pm._logged[0].kind, 'pallet');
    await fp.close();
    ok('offline pallet label prints once and replays idempotently');
  }

  console.log(`\n${passed}/7 scenarios passed`);
}

main().then(
  () => process.exit(0),
  (e) => { console.error('\n✗ FAILED:', e.message); process.exit(1); },
);
