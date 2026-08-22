'use strict';

/**
 * TSPL pallet-tag builder for the Gprinter (TSC-compatible) pallet-tag printer.
 *
 * Ported from the hardware-verified Nexus test bridge
 * (1000m-nexus/scripts/gprinter-pallet-bridge.ts, E2E verified + design signed
 * off 2026-08-19). The pallet tag is BARCODE-ONLY — no RFID encode — and the
 * design follows the warehouse's physical reference label: a large
 * "Pallet <number>" title, a smaller durable reference, a dominant native Code
 * 128, and the pallet caption repeated below it. The barcode always carries the
 * full durable pallet code even when the human-facing title is shortened.
 *
 * Two layouts, picked automatically by buildPalletTag():
 *   montserrat  the signed-off design. Text lines are rasterized PC-side with
 *               sharp (TTFs in ./fonts) and sent as TSPL BITMAP — no built-in
 *               printer font can render a TTF. The barcode stays printer-native
 *               so its modules print pixel-exact. Needs `sharp` + both TTFs.
 *   builtin     TSPL built-in bitmap fonts. Zero dependencies; the fallback
 *               when sharp or the fonts are missing. Same geometry.
 *
 * Jobs are returned as Buffers: BITMAP payloads are binary (their bytes
 * legitimately contain 0x0A) and must never pass through string newline
 * rewriting.
 */

const path = require('path');
const { existsSync } = require('fs');

// TSPL SIZE/GAP take mm, but element coordinates are printhead DOTS, so all
// layout math needs the head density. Get this wrong and nothing errors — the
// label size is still right (it's declared in mm) while every coordinate inside
// it is off by the ratio, so a 300 dpi tag driven at 203 prints the whole design
// squashed into the top-left ~2/3 of the media. There is no way to ask over
// one-way USB RAW, so it is configuration: run SELFTEST on the printer and read
// the dpi off its own config label.
const DEFAULT_PALLET_DPI = 203;
const GAP_MM = 3;

// Band heights as a fraction of the across-the-stack dimension, and the cap on
// the barcode's share. Named rather than inline because they are one budget:
// they plus the gaps have to stay under the usable height, and the leftover is
// dead white space an operator reads as a misprint. Tuned so a 100x150 tag comes
// out around 95% full — the remainder is the safety margin that keeps a slightly
// mis-fed label from clipping the top line.
const TITLE_H = 0.26;
const REF_H = 0.1;
const FOOTER_H = 0.07;
const BAR_H_CAP = 0.46;

// Code 128 narrow-module floor, in MILLIMETRES rather than dots — the physical
// bar width is what a scanner cares about, and the same dot count is a
// different bar on every head density. 0.25 mm is a conservative retail-grade
// X-dimension. A code so long it cannot fit even at the floor keeps the floor
// and overruns the label: a visibly clipped barcode gets fixed at the dock,
// where a hair-thin "fits but never scans" one ships on a pallet.
const MIN_MODULE_MM = 0.25;

const FONT_BOLD = path.join(__dirname, 'fonts', 'Montserrat-Bold.ttf');
const FONT_MEDIUM = path.join(__dirname, 'fonts', 'Montserrat-Medium.ttf');

// sharp is optional: without it (or the TTFs) buildPalletTag degrades to the
// built-in-font layout instead of refusing to print.
let sharpMod;
function getSharp() {
  if (sharpMod !== undefined) return sharpMod;
  try {
    sharpMod = require('sharp');
  } catch {
    sharpMod = null;
  }
  return sharpMod;
}

/** Code 128 (code set B, unoptimized) total module count — for fit math. */
function code128Modules(content) {
  return 11 * (content.length + 2) + 13;
}

/**
 * Code 128 element widths for values 0..106, as bar/space/bar/space/bar/space.
 * 106 (STOP) has a seventh element. Every row totals 11 modules; STOP totals 13.
 *
 * Needed because this printer's firmware SILENTLY DROPS a BARCODE command with a
 * non-zero rotation — the label prints with the text present and the barcode
 * simply absent, no error anywhere. Rather than depend on a firmware feature we
 * cannot detect the absence of, the barcode is rasterised here and sent as a
 * BITMAP like the text, which is known to work at any rotation.
 */
const C128 = [
  '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
  '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
  '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
  '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
  '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
  '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
  '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
  '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
  '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
  '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
  '114131','311141','411131','211412','211214','211232','2331112',
];

// Structural self-check: a single mistyped digit produces a barcode that looks
// perfect and never scans, which is the worst possible failure for a pallet
// label. Module sums catch almost any such typo, so they are asserted at load
// rather than trusted.
for (let v = 0; v < C128.length; v++) {
  const expect = v === 106 ? 13 : 11;
  const sum = [...C128[v]].reduce((a, d) => a + Number(d), 0);
  if (sum !== expect) throw new Error(`Code 128 pattern ${v} sums to ${sum}, expected ${expect}`);
}

/**
 * Encode `text` as Code 128 code set B and return the element widths in order,
 * starting with a bar and alternating. Set B covers ASCII 32..126, which is
 * every character a pallet code uses; anything outside is replaced rather than
 * silently truncating the code the barcode is supposed to carry.
 */
function code128bWidths(text) {
  const values = [...String(text)].map((ch) => {
    const v = ch.charCodeAt(0) - 32;
    return v >= 0 && v <= 94 ? v : '?'.charCodeAt(0) - 32;
  });
  const START_B = 104;
  // Checksum is START plus each value weighted by its 1-based position, mod 103.
  let sum = START_B;
  values.forEach((v, i) => { sum += v * (i + 1); });
  const symbols = [START_B, ...values, sum % 103, 106];
  const widths = [];
  for (const s of symbols) for (const d of C128[s]) widths.push(Number(d));
  return widths;
}

/**
 * Rasterise a Code 128 to a 1-bit TSPL bitmap. Same packed shape and bit
 * convention as textBitmap (0 = print), and the same quarter-turn handling, so
 * the layout code treats a barcode and a text line identically.
 */
function barcodeBitmap(text, moduleDots, heightDots, rot90 = false) {
  const widths = code128bWidths(text);
  const w = widths.reduce((a, n) => a + n, 0) * moduleDots;
  const h = Math.max(1, Math.round(heightDots));
  // Column mask first: every row of a Code 128 is identical, so the bars are
  // computed once instead of per scanline.
  const dark = new Uint8Array(w);
  let x = 0;
  widths.forEach((units, i) => {
    const run = units * moduleDots;
    if (i % 2 === 0) for (let d = 0; d < run; d++) dark[x + d] = 1; // even index = bar
    x += run;
  });
  const pw = rot90 ? h : w;
  const ph = rot90 ? w : h;
  const wBytes = Math.ceil(pw / 8);
  const data = Buffer.alloc(wBytes * ph, 0xff);
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      // Quarter turn clockwise: emitted (px,py) reads logical (py, h-1-px).
      const lx = rot90 ? py : px;
      if (dark[lx]) data[py * wBytes + (px >> 3)] &= ~(0x80 >> (px & 7));
    }
  }
  return { w: pw, h: ph, logicalW: w, logicalH: h, wBytes, data };
}

/** Largest narrow-module width (dots) that keeps the barcode inside maxDots,
 * never going below the physical MIN_MODULE_MM floor. */
function pickModule(content, maxDots, dpm) {
  const floor = Math.max(1, Math.ceil(MIN_MODULE_MM * dpm));
  for (let m = Math.max(6, floor); m >= floor; m--) {
    if (code128Modules(content) * m <= maxDots) return m;
  }
  return floor;
}

const esc = (s) => String(s).replace(/["\\]/g, ' ').trim();

/** Human-facing caption from the durable pallet code. The bridge's generated
 * codes end in a zero-padded sequence; operators call that simply "Pallet 58".
 * A caller may override it for a manually prepared label. */
function palletCaption(c, code) {
  const supplied = esc(c.palletLabel || '');
  if (supplied) return supplied;
  const match = code.match(/(\d+)$/);
  return match ? `Pallet ${Number(match[1])}` : code.replace(/^PLT[-_ ]*/i, 'Pallet ');
}

/** Receiving-batch reference when the operator/Nexus knows it; offline labels
 * fall back to the durable pallet code, which remains globally traceable. */
function palletReference(c, code) {
  return esc(c.batchRef || c.reference || code);
}

// TSPL built-in bitmap font cells, in DOTS — the TSC nominals. Clone firmwares
// (the Gprinter included) render some fonts WIDER than nominal: a 15-char code
// that should have fit 40 mm at font "3" clipped the label edge on hardware. So
// all width math multiplies by a safety factor, and the code line shrinks down
// a ladder until it provably fits. On a genuine TSC the factor is merely
// conservative, which costs a font step at worst.
//
// These cells are fixed dot bitmaps, so on a 300 dpi head they render 2/3 the
// physical size — the fitText ladder partly compensates (more usable dots means
// a bigger multiplier fits). Only the FALLBACK layout is affected; the
// Montserrat path rasterizes to a dot height derived from the label, so it is
// exact at any density.
const FONT = {
  1: { w: 8, h: 12 },
  2: { w: 12, h: 20 },
  3: { w: 16, h: 24 },
};
const GLYPH_SAFETY = 1.35;

/** Conservative rendered width of `chars` characters. */
function safeWidth(chars, font, mul) {
  return Math.ceil(chars * FONT[font].w * GLYPH_SAFETY * mul);
}

/** x that centers `chars` characters of `font` at `mul` on a W-dot label. */
function centerX(chars, font, mul, W) {
  return Math.max(0, Math.round((W - safeWidth(chars, font, mul)) / 2));
}

/** Biggest font+multiplier (by height) whose safe width fits `usable`. */
function fitText(chars, usable) {
  for (let mul = 4; mul >= 1; mul--) {
    if (safeWidth(chars, 3, mul) <= usable) return { font: 3, mul, h: FONT[3].h * mul };
  }
  if (safeWidth(chars, 2, 1) <= usable) return { font: 2, mul: 1, h: FONT[2].h };
  return { font: 1, mul: 1, h: FONT[1].h };
}

/** Resolve + clamp the shared geometry inputs once for both layouts. */
function geometry(c) {
  const wMm = Number(c.widthMm) > 0 ? Number(c.widthMm) : 75;
  const hMm = Number(c.heightMm) > 0 ? Number(c.heightMm) : 130;
  // The right-shift must ALSO widen the declared SIZE: the firmware clips at
  // the SIZE canvas, so shifting content inside an unchanged canvas cuts off
  // the widest line's tail instead of moving it.
  const oxMm = Number.isFinite(Number(c.leftOffsetMm)) ? Math.max(0, Number(c.leftOffsetMm)) : 0;
  const copies = Math.max(1, Math.min(10, Number(c.copies) || 1));
  const dpi = Number(c.dpi) > 0 ? Number(c.dpi) : DEFAULT_PALLET_DPI;
  const dpm = dpi / 25.4; // dots per mm — 8 at 203 dpi, ~11.8 at 300
  const W = Math.round(wMm * dpm);
  const H = Math.round(hMm * dpm);
  // Landscape turns the DESIGN, never the media: SIZE's first value is the
  // width across the printhead, which is a physical limit (~104 mm on a 4"
  // unit), so a 100x150 label cannot be redeclared as 150x100. The label stays
  // as loaded and the artwork is rotated a quarter turn to read along its long
  // edge — which also hands the barcode the 150 mm axis instead of the 100 mm
  // one, so a long pallet code fits at a wider, more scannable module.
  const landscape = c.orientation === 'landscape';
  return {
    wMm,
    hMm,
    oxMm,
    copies,
    dpi,
    dpm,
    W,
    H,
    ox: Math.round(oxMm * dpm),
    // 4 mm, not 2. A thermal printer's first printable dot sits a few mm inside
    // the media edge and that inset varies per unit, so a 2 mm design margin
    // left nothing to absorb it — the outermost line lost its leading glyphs on
    // this printer. 4 mm each side costs a little size and makes the tag
    // tolerant of the alignment instead of exactly matching one machine.
    margin: Math.round(4 * dpm),
    landscape,
    // The canvas the layout stacks into. In landscape it is the label turned on
    // its side; the emitter rotates every element back.
    LW: landscape ? H : W,
    LH: landscape ? W : H,
  };
}

/** Built-in-font layout. Returns the job as a Buffer: the barcode is a BITMAP
 *  (this firmware drops rotated BARCODE commands) and its payload is binary, so
 *  the job can no longer be a string that gets newline-rewritten. */
function palletTagTspl(c) {
  const { wMm, hMm, oxMm, copies, dpm, W, ox, margin, landscape, LW, LH } = geometry(c);
  // Laid out in the LOGICAL canvas, exactly as the Montserrat path: LW across,
  // LH down, which in landscape is the label turned on its side.
  const usable = LW - margin * 2;
  const code = esc(c.palletCode);
  const title = palletCaption(c, code);
  const reference = palletReference(c, code);
  const gap = Math.max(8, Math.round(LH * 0.025));
  const titleFit = fitText(title.length, usable);
  const refFit = fitText(reference.length, usable);

  // Barcode centered; module width from fit math. Our own readable line below
  // (spaced out when it fits, plain when the code is long).
  const narrow = pickModule(code, usable, dpm);
  const footerFit = fitText(title.length, usable);

  // Barcode takes what's left of the height, capped near the design's ~1/3
  // proportion so tall media doesn't become one giant barcode.
  const fixedH = titleFit.h + gap + refFit.h + gap + footerFit.h + Math.round(gap / 2);
  const barH = Math.min(Math.round(LH * BAR_H_CAP), Math.max(40, LH - margin * 2 - fixedH));

  // Center the whole block vertically (the cap above can leave slack).
  let y = margin + Math.max(0, Math.round((LH - margin * 2 - fixedH - barH) / 2));

  // Same transform as the Montserrat path: a quarter turn clockwise sends the
  // logical top edge to the physical right edge. TSPL TEXT and BARCODE both
  // take a rotation argument, so the built-in path can rotate too — it just
  // could not before, which is why asking for landscape on a bridge without
  // sharp silently produced a portrait tag.
  const rot = landscape ? 90 : 0;
  const place = (x, ly, lh) => (landscape ? { x: ox + (W - ly - lh), y: x } : { x: ox + x, y: ly });

  const parts = [cmd(`SIZE ${wMm + oxMm} mm,${hMm} mm`), cmd(`GAP ${GAP_MM} mm,0 mm`), cmd('DIRECTION 1'), cmd('CLS')];
  const emitText = (text, fit) => {
    const p = place(centerX(text.length, fit.font, fit.mul, LW), y, fit.h);
    parts.push(cmd(`TEXT ${p.x},${p.y},"${fit.font}",${rot},${fit.mul},${fit.mul},"${text}"`));
    y += fit.h + gap;
  };

  emitText(title, titleFit);
  emitText(reference, refFit);
  // Rasterised here too, not just on the Montserrat path. Drawing the barcode
  // needs no sharp — only bit packing — so the zero-dependency fallback has no
  // reason to keep using a native BARCODE this firmware silently discards.
  // Without this, a bridge missing sharp printed a landscape tag with no
  // barcode at all, which is exactly what reached the gate.
  const barBmp = barcodeBitmap(code, narrow, barH, landscape);
  const bp = place(Math.max(margin, Math.round((LW - barBmp.logicalW) / 2)), y, barBmp.logicalH);
  parts.push(bitmapCmd(bp.x, bp.y, barBmp));
  y += barH + Math.round(gap / 2);
  emitText(title, footerFit);
  parts.push(cmd(`PRINT ${copies},1`));
  return Buffer.concat(parts);
}

// ── Montserrat bitmap rendering ───────────────────────────────────────────────

const pangoEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Rasterize one line of TTF text to a 1-bit TSPL bitmap, targetH dots tall
 * (shrunk proportionally if it would overflow maxW). TSPL BITMAP bit
 * convention: 0 = print (black), 1 = blank — so dark pixels clear bits.
 *
 * `rot90` packs the raster rotated a quarter turn clockwise, for the landscape
 * layout. Done here, during packing, rather than by rotating the image with
 * sharp: TSPL BITMAP has no rotation parameter of its own, and rotating the
 * PACKED bits afterwards would mean unpacking and repacking a bit-per-pixel
 * buffer. The measured logical size is returned alongside so the caller can
 * keep laying out in unrotated space and only the emitted bytes are turned. */
async function textBitmap(sharp, text, fontfile, targetH, maxW, dpi, rot90 = false) {
  const png = await sharp({
    text: {
      text: `<span foreground="black">${pangoEscape(text)}</span>`,
      font: 'Montserrat 64',
      fontfile,
      // Source render density. The raster is resized to targetH regardless, so
      // this drives detail, not size — matching the head keeps a 300 dpi tag
      // from being upscaled off a 203 dpi master.
      dpi,
      rgba: true,
    },
  })
    .png()
    .toBuffer();
  const meta = await sharp(png).metadata();
  const w0 = Math.max(1, meta.width ?? 1);
  const h0 = Math.max(1, meta.height ?? 1);
  const scale = Math.min(targetH / h0, maxW / w0);
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const raw = await sharp(png)
    .resize(w, h)
    .flatten({ background: '#ffffff' })
    .greyscale()
    .threshold(160)
    .raw()
    .toBuffer();
  // Emitted (post-rotation) dimensions; logical w/h stay available for layout.
  const pw = rot90 ? h : w;
  const ph = rot90 ? w : h;
  const wBytes = Math.ceil(pw / 8);
  const data = Buffer.alloc(wBytes * ph, 0xff);
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      // Quarter turn clockwise: emitted (px,py) reads logical (py, h-1-px).
      const lx = rot90 ? py : px;
      const ly = rot90 ? h - 1 - px : py;
      if (raw[ly * w + lx] < 128) data[py * wBytes + (px >> 3)] &= ~(0x80 >> (px & 7));
    }
  }
  return { w: pw, h: ph, logicalW: w, logicalH: h, wBytes, data };
}

const cmd = (s) => Buffer.from(s + '\r\n', 'ascii');
const bitmapCmd = (x, y, b) =>
  Buffer.concat([Buffer.from(`BITMAP ${x},${y},${b.wBytes},${b.h},0,`, 'ascii'), b.data, Buffer.from('\r\n', 'ascii')]);

/** The design layout in Montserrat: centered header / code / barcode /
 * readable. Returns a Buffer — BITMAP payloads are binary and must never pass
 * through string newline rewriting. */
async function buildPalletTagJob(sharp, c) {
  const g = geometry(c);
  const { wMm, hMm, oxMm, copies, dpi, dpm, W, ox, margin, landscape, LW, LH } = g;
  const usable = LW - margin * 2;
  const code = esc(c.palletCode);
  const title = palletCaption(c, code);
  const reference = palletReference(c, code);
  const gap = Math.max(8, Math.round(LH * 0.025));

  // Everything below is laid out in the LOGICAL canvas (LW across, LH down),
  // which in landscape is the label turned on its side. `place` is the only
  // place that knows about rotation.
  const [titleBmp, refBmp, footerBmp] = await Promise.all([
    textBitmap(sharp, title, FONT_BOLD, Math.max(28, Math.round(LH * TITLE_H)), usable, dpi, landscape),
    textBitmap(sharp, reference, FONT_BOLD, Math.max(18, Math.round(LH * REF_H)), usable, dpi, landscape),
    textBitmap(sharp, title, FONT_MEDIUM, Math.max(14, Math.round(LH * FOOTER_H)), usable, dpi, landscape),
  ]);

  const narrow = pickModule(code, usable, dpm);
  const barW = code128Modules(code) * narrow;
  const fixedH = titleBmp.logicalH + gap + refBmp.logicalH + gap + Math.round(gap / 2) + footerBmp.logicalH;
  const barH = Math.min(Math.round(LH * BAR_H_CAP), Math.max(40, LH - margin * 2 - fixedH));

  /** Logical (x,y) of an element sized lw x lh -> emitted top-left.
   *  A quarter turn clockwise sends the logical TOP edge to the physical RIGHT
   *  edge, so x becomes the down-feed coordinate and y is measured back from
   *  the label's across-head width. Portrait passes straight through. */
  const place = (x, y, lw, lh) => (landscape ? { x: ox + (W - y - lh), y: x } : { x: ox + x, y });
  const centred = (lw) => Math.max(margin, Math.round((LW - lw) / 2));

  let ly = margin + Math.max(0, Math.round((LH - margin * 2 - fixedH - barH) / 2));
  const parts = [cmd(`SIZE ${wMm + oxMm} mm,${hMm} mm`), cmd(`GAP ${GAP_MM} mm,0 mm`), cmd('DIRECTION 1'), cmd('CLS')];

  const emitBmp = (bmp) => {
    const p = place(centred(bmp.logicalW), ly, bmp.logicalW, bmp.logicalH);
    parts.push(bitmapCmd(p.x, p.y, bmp));
    ly += bmp.logicalH + gap;
  };

  emitBmp(titleBmp);
  emitBmp(refBmp);

  // Rasterised rather than printer-native. A native BARCODE is pixel-exact and
  // was the better choice while tags were portrait, but this firmware silently
  // drops a rotated one: the tag prints with its text and no barcode at all, and
  // nothing reports it. Drawing it here is exact too — bars are whole multiples
  // of a dot by construction — and works at any rotation.
  const barBmp = barcodeBitmap(code, narrow, barH, landscape);
  const bp = place(centred(barBmp.logicalW), ly, barBmp.logicalW, barBmp.logicalH);
  parts.push(bitmapCmd(bp.x, bp.y, barBmp));
  ly += barH + Math.round(gap / 2);

  emitBmp(footerBmp);
  parts.push(cmd(`PRINT ${copies},1`));
  return Buffer.concat(parts);
}

/**
 * Build one pallet-tag job. Content: { palletCode, palletLabel?, batchRef?, widthMm?, heightMm?,
 * leftOffsetMm?, copies?, dpi? } — sizes in mm, defaults 75×130 / offset 0 /
 * 1 copy / 203 dpi. Returns { data: Buffer, layout: 'montserrat' | 'builtin',
 * dpi }.
 */
async function buildPalletTag(content) {
  const sharp = getSharp();
  const { dpi, landscape } = geometry(content);
  if (sharp && existsSync(FONT_BOLD) && existsSync(FONT_MEDIUM)) {
    return {
      data: await buildPalletTagJob(sharp, content),
      layout: 'montserrat',
      dpi,
      orientation: landscape ? 'landscape' : 'portrait',
    };
  }
  // The built-in-font fallback has no rotation, so it reports the orientation it
  // actually produced rather than the one asked for — a caller that logs the
  // requested value would claim a landscape tag that printed portrait.
  // Already a Buffer with CRLF applied — the fallback carries a BITMAP barcode
  // now, and its binary payload must never pass through newline rewriting.
  return {
    data: palletTagTspl(content),
    layout: 'builtin',
    dpi,
    orientation: landscape ? 'landscape' : 'portrait',
  };
}

// code128bWidths and C128 are exported for test/code128.js only. The pattern
// table is safety-critical — a single wrong digit prints a barcode that looks
// perfect and never scans — so it is verified by a committed test, not just by
// the module-sum assertion above.
module.exports = { buildPalletTag, DEFAULT_PALLET_DPI, code128bWidths, C128 };
