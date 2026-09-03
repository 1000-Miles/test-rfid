import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let failures = 0;
const assert = (condition, label) => {
  if (condition) console.log(`  ok   ${label}`);
  else { failures += 1; console.error(`  FAIL ${label}`); }
};

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const [{ default: GateBoard }, { default: PalletPrintingPage }] = await Promise.all([
    vite.ssrLoadModule('/src/GateBoard.tsx'),
    vite.ssrLoadModule('/src/PalletPrintingPage.tsx'),
  ]);
  const exception = {
    id: 1, kind: 'entry', direction: 'in', method: 'toggle', epc: 'E28011700000000000000066', known: true,
    item: { kind: 'carton', sku: 'TEST-PRODUCT-1', name: 'Test Product 1', pallet: 'BOX-0001', category: 'printed' },
    location: 'YIWU-MAIN-GATE', rssi: -49, antenna: 1, antennas: [1], reads: 3,
    passageId: null, passageRequestId: null, palletCode: null, eventId: 'test-gate:g1:66',
    unexpected: 'no-open-batch', basis: 'not-on-open-batch', timestamp: new Date().toISOString(),
  };
  const boardApi = {
    board: { docs: [], pool: [], exceptions: [], counted: [], pending: [] }, lastCounted: null, dupMsg: null,
    addFromPool() {}, clearExceptions() {}, refresh() {}, resetDay() {},
    feed: { status: 'live', fetchedAt: new Date().toISOString(), error: null },
  };
  const gateHtml = renderToStaticMarkup(React.createElement(GateBoard, { board: boardApi, entries: [exception], sound: 'ready', onOpenControls() {} }));
  console.log('GateBoard NO RECEIVING card');
  assert(gateHtml.includes('NO RECEIVING'), 'solid exception label is rendered');
  assert(gateHtml.includes('Test Product 1'), 'scanned product name remains visible');
  assert(gateHtml.includes('TEST-PRODUCT-1'), 'scanned SKU remains visible');
  assert(gateHtml.includes('Not credited · not added to pallet'), 'non-credit status is explicit');
  assert(!gateHtml.includes('ITEM SET ASIDE'), 'old acknowledgement alert is absent');

  const bridge = {
    wsConnected: true,
    status: { connected: true, reading: true, mode: 'toggle', irDurationMs: 500, irMinGapMs: 200, minRssi: null, weakDropped: 0, gpi: { gpi1: null, gpi2: null, raw: '' } },
    rows: [], udpFrames: [], entries: [exception], gpi: { gpi1: null, gpi2: null, raw: '' }, totalReads: 3, uniqueEpcs: 1,
    readsPerSec: 0, lastTriggerAt: 0, passageComplete: null, receivingResetAt: null, palletWorkflow: null, movement: null, clear() {},
  };
  const printingHtml = renderToStaticMarkup(React.createElement(PalletPrintingPage, { bridge }));
  console.log('Printing page NO RECEIVING handoff');
  assert(printingHtml.includes('NO RECEIVING'), 'same exception label is rendered');
  assert(printingHtml.includes('Test Product 1'), 'same product name is carried over');
  assert(printingHtml.includes('add it to an active receiving batch in Nexus'), 'recovery action is explicit');
  assert(printingHtml.includes('Continue other receiving'), 'warehouse continuation is explicit');
  if (failures) process.exitCode = 1;
  else console.log('all NO RECEIVING render assertions passed');
} finally {
  await vite.close();
}
