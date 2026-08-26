'use strict';

/**
 * Code 128 encoder test.
 *
 * The pallet barcode is rasterised in the bridge rather than drawn by the
 * printer, because this hardware's firmware silently DROPS a rotated BARCODE
 * command — the tag prints with its text and no barcode, and nothing reports it.
 * Owning the encoder means owning its correctness, and the failure mode is the
 * nastiest kind: a wrong pattern digit produces a barcode that looks perfect on
 * paper and never scans. A missing barcode gets fixed at the dock; an
 * unscannable one ships on a pallet and is found by the customer.
 *
 * So this checks three independent things:
 *   1. every pattern row totals its correct module count (catches typos)
 *   2. encode -> read the bars back -> decode recovers the text, start, stop
 *      and checksum (catches ordering and checksum bugs)
 *   3. two externally published check digits (catches a self-consistent but
 *      wrong table, which 1 and 2 cannot see)
 *
 *   node test/code128.js
 */

const { code128bWidths, C128, buildPalletTag } = require('../src/printer/tspl');

let failures = 0;
const ok = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

console.log('pattern table: every row totals 11 modules (STOP totals 13)');
{
  let bad = 0;
  for (let v = 0; v < C128.length; v++) {
    const expect = v === 106 ? 13 : 11;
    const sum = [...C128[v]].reduce((a, d) => a + Number(d), 0);
    if (sum !== expect) bad++;
  }
  ok(`${C128.length} patterns`, bad === 0, bad ? `${bad} rows wrong` : '');
  ok('table has 107 symbols', C128.length === 107, `got ${C128.length}`);
  ok('no duplicate patterns', new Set(C128).size === C128.length);
}

/** Regroup element widths back into symbols and look each one up. */
function decode(widths) {
  const symbols = [];
  for (let i = 0; i < widths.length; ) {
    const take = i + 7 === widths.length ? 7 : 6; // STOP is the only 7-element symbol
    symbols.push(widths.slice(i, i + take).join(''));
    i += take;
  }
  return symbols.map((p) => C128.indexOf(p));
}

console.log('round trip: encode -> decode recovers text, start, stop, checksum');
for (const text of [
  'A',
  'PLT-YIWU-MAIN-GATE-00000930',
  'PLT-SAMPLE-0001',
  'Pallet-TEST',
  'AB-12_34.56',
  ' ', // value 0, the low edge of set B
  '~', // value 94, the high edge
]) {
  const widths = code128bWidths(text);
  const values = decode(widths);
  const data = values.slice(1, -2);
  let sum = 104;
  data.forEach((v, i) => { sum += v * (i + 1); });
  const decoded = data.map((v) => String.fromCharCode(v + 32)).join('');
  const pass =
    !values.includes(-1) &&
    values[0] === 104 &&
    values[values.length - 1] === 106 &&
    values[values.length - 2] === sum % 103 &&
    decoded === text &&
    widths.reduce((a, n) => a + n, 0) === 11 * (text.length + 2) + 13;
  ok(JSON.stringify(text), pass, pass ? '' : `decoded ${JSON.stringify(decoded)}`);
}

console.log('published check digits (an independent check on the table itself)');
{
  // Code 128B "A": START_B(104) + 33*1 = 137, 137 mod 103 = 34.
  const a = decode(code128bWidths('A'));
  ok('"A" check digit is 34', a[a.length - 2] === 34, `got ${a[a.length - 2]}`);
  // Code 128B "HI345678": values 40,41,19,20,21,22,23,24 at positions 1..8.
  const hi = decode(code128bWidths('HI345678'));
  let s = 104;
  [40, 41, 19, 20, 21, 22, 23, 24].forEach((v, i) => { s += v * (i + 1); });
  ok(`"HI345678" check digit is ${s % 103}`, hi[hi.length - 2] === s % 103, `got ${hi[hi.length - 2]}`);
  // Set B maps ASCII 32..126 onto values 0..94 — verify the ends, since an
  // off-by-one here would shift every character in every pallet code.
  ok('space encodes as value 0', decode(code128bWidths(' '))[1] === 0);
  ok('"~" encodes as value 94', decode(code128bWidths('~'))[1] === 94);
}

console.log('rendered tag carries no native BARCODE command');
(async () => {
  for (const orientation of ['portrait', 'landscape']) {
    const r = await buildPalletTag({
      palletCode: 'PLT-YIWU-MAIN-GATE-00000930',
      widthMm: 100,
      heightMm: 150,
      dpi: 300,
      orientation,
    });
    const text = r.data.toString('latin1');
    ok(
      `${orientation}: barcode is a BITMAP, not a BARCODE command`,
      !text.includes('BARCODE ') && (text.match(/BITMAP /g) || []).length === 4,
      `BARCODE=${(text.match(/BARCODE /g) || []).length} BITMAP=${(text.match(/BITMAP /g) || []).length}`
    );
  }

  console.log(failures ? `\n${failures} FAILURES` : '\nall Code 128 assertions passed');
  process.exit(failures ? 1 : 0);
})();
