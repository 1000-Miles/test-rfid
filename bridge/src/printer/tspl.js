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
  return {
    wMm,
    hMm,
    oxMm,
    copies,
    dpi,
    dpm,
    W: Math.round(wMm * dpm),
    H: Math.round(hMm * dpm),
    ox: Math.round(oxMm * dpm),
    margin: Math.round(2 * dpm),
  };
}

/** Built-in-font layout. Returns the job as a TSPL string (CRLF applied by the caller via toBuffer). */
function palletTagTspl(c) {
  const { wMm, hMm, oxMm, copies, dpm, W, H, ox, margin } = geometry(c);
  const usable = W - margin * 2;
  const code = esc(c.palletCode);
  const title = palletCaption(c, code);
  const reference = palletReference(c, code);
  const gap = Math.max(8, Math.round(H * 0.025));
  const titleFit = fitText(title.length, usable);
  const refFit = fitText(reference.length, usable);

  // Barcode centered; module width from fit math. Our own readable line below
  // (spaced out when it fits, plain when the code is long).
  const narrow = pickModule(code, usable, dpm);
  const barcodeWidth = code128Modules(code) * narrow;
  const bx = ox + Math.max(margin, Math.round((W - barcodeWidth) / 2));
  const footerFit = fitText(title.length, usable);

  // Barcode takes what's left of the height, capped near the design's ~1/3
  // proportion so tall media doesn't become one giant barcode.
  const fixedH = titleFit.h + gap + refFit.h + gap + footerFit.h + Math.round(gap / 2);
  const barH = Math.min(Math.round(H * 0.42), Math.max(40, H - margin * 2 - fixedH));

  // Center the whole block vertically (the cap above can leave slack).
  let y = margin + Math.max(0, Math.round((H - margin * 2 - fixedH - barH) / 2));

  const lines = [`SIZE ${wMm + oxMm} mm,${hMm} mm`, `GAP ${GAP_MM} mm,0 mm`, 'DIRECTION 1', 'CLS'];
  lines.push(`TEXT ${ox + centerX(title.length, titleFit.font, titleFit.mul, W)},${y},"${titleFit.font}",0,${titleFit.mul},${titleFit.mul},"${title}"`);
  y += titleFit.h + gap;
  lines.push(`TEXT ${ox + centerX(reference.length, refFit.font, refFit.mul, W)},${y},"${refFit.font}",0,${refFit.mul},${refFit.mul},"${reference}"`);
  y += refFit.h + gap;
  lines.push(`BARCODE ${bx},${y},"128",${barH},0,0,${narrow},${narrow * 2},"${code}"`);
  y += barH + Math.round(gap / 2);
  lines.push(`TEXT ${ox + centerX(title.length, footerFit.font, footerFit.mul, W)},${y},"${footerFit.font}",0,${footerFit.mul},${footerFit.mul},"${title}"`);
  lines.push(`PRINT ${copies},1`);
  return lines.join('\n');
}

// ── Montserrat bitmap rendering ───────────────────────────────────────────────

const pangoEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Rasterize one line of TTF text to a 1-bit TSPL bitmap, targetH dots tall
 * (shrunk proportionally if it would overflow maxW). TSPL BITMAP bit
 * convention: 0 = print (black), 1 = blank — so dark pixels clear bits. */
async function textBitmap(sharp, text, fontfile, targetH, maxW, dpi) {
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
  const wBytes = Math.ceil(w / 8);
  const data = Buffer.alloc(wBytes * h, 0xff);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (raw[y * w + x] < 128) data[y * wBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
  return { w, h, wBytes, data };
}

const cmd = (s) => Buffer.from(s + '\r\n', 'ascii');
const bitmapCmd = (x, y, b) =>
  Buffer.concat([Buffer.from(`BITMAP ${x},${y},${b.wBytes},${b.h},0,`, 'ascii'), b.data, Buffer.from('\r\n', 'ascii')]);

/** The design layout in Montserrat: centered header / code / barcode /
 * readable. Returns a Buffer — BITMAP payloads are binary and must never pass
 * through string newline rewriting. */
async function buildPalletTagJob(sharp, c) {
  const { wMm, hMm, oxMm, copies, dpi, dpm, W, H, ox, margin } = geometry(c);
  const usable = W - margin * 2;
  const code = esc(c.palletCode);
  const title = palletCaption(c, code);
  const reference = palletReference(c, code);
  const gap = Math.max(8, Math.round(H * 0.025));
  const centerBmp = (b) => ox + Math.max(margin, Math.round((W - b.w) / 2));

  const [titleBmp, refBmp, footerBmp] = await Promise.all([
    textBitmap(sharp, title, FONT_BOLD, Math.max(28, Math.round(H * 0.2)), usable, dpi),
    textBitmap(sharp, reference, FONT_BOLD, Math.max(18, Math.round(H * 0.09)), usable, dpi),
    textBitmap(sharp, title, FONT_MEDIUM, Math.max(14, Math.round(H * 0.065)), usable, dpi),
  ]);

  const narrow = pickModule(code, usable, dpm);
  const bx = ox + Math.max(margin, Math.round((W - code128Modules(code) * narrow) / 2));
  const fixedH = titleBmp.h + gap + refBmp.h + gap + Math.round(gap / 2) + footerBmp.h;
  const barH = Math.min(Math.round(H * 0.42), Math.max(40, H - margin * 2 - fixedH));
  let y = margin + Math.max(0, Math.round((H - margin * 2 - fixedH - barH) / 2));

  const parts = [cmd(`SIZE ${wMm + oxMm} mm,${hMm} mm`), cmd(`GAP ${GAP_MM} mm,0 mm`), cmd('DIRECTION 1'), cmd('CLS')];
  parts.push(bitmapCmd(centerBmp(titleBmp), y, titleBmp));
  y += titleBmp.h + gap;
  parts.push(bitmapCmd(centerBmp(refBmp), y, refBmp));
  y += refBmp.h + gap;
  parts.push(cmd(`BARCODE ${bx},${y},"128",${barH},0,0,${narrow},${narrow * 2},"${code}"`));
  y += barH + Math.round(gap / 2);
  parts.push(bitmapCmd(centerBmp(footerBmp), y, footerBmp));
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
  const { dpi } = geometry(content);
  if (sharp && existsSync(FONT_BOLD) && existsSync(FONT_MEDIUM)) {
    return { data: await buildPalletTagJob(sharp, content), layout: 'montserrat', dpi };
  }
  const text = palletTagTspl(content);
  return { data: Buffer.from(text.replace(/\n/g, '\r\n') + '\r\n', 'ascii'), layout: 'builtin', dpi };
}

module.exports = { buildPalletTag, DEFAULT_PALLET_DPI };
