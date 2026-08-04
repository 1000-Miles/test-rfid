'use strict';

/**
 * ZPL generation for the Chainway CP30 (ZPL-compatible RFID label printer).
 *
 * RFID encoding in ZPL is just another field in the label format:
 *   ^RFW,H        set up a write to EPC memory, data given as hex
 *   ^FD<hex>^FS   the EPC words to write (96-bit EPC = 24 hex chars)
 * The printer positions the label over its RFID antenna, writes the chip,
 * then prints. If the printer needs tuning on large inlays, adjust offset /
 * write power in the printer's on-screen RFID Setup (or via ^RS in extraZpl).
 */

/** EPC memory is written in 16-bit words -> hex length must be a multiple of 4. */
function validateEpcHex(epc) {
  if (typeof epc !== 'string' || !/^[0-9A-Fa-f]+$/.test(epc)) {
    throw new Error(`EPC must be hex characters only, got "${epc}"`);
  }
  if (epc.length % 4 !== 0) {
    throw new Error(`EPC hex length must be a multiple of 4 (16-bit words), got ${epc.length} chars`);
  }
  return epc.toUpperCase();
}

/**
 * Sequential, recognizable 96-bit test EPCs: <prefix> + zero-padded hex counter.
 * e.g. testEpc('AA00', 7) -> 'AA000000000000000000' + '0007'... (24 chars total)
 */
function testEpc(prefix = 'AA00', counter = 1) {
  if (!/^[0-9A-Fa-f]*$/.test(prefix)) throw new Error(`EPC prefix must be hex, got "${prefix}"`);
  const digits = 24 - prefix.length;
  if (digits < 1) throw new Error('EPC prefix too long (max 23 hex chars)');
  const c = Math.max(0, Math.floor(counter)).toString(16).toUpperCase();
  if (c.length > digits) throw new Error(`test EPC counter overflows ${digits} hex digits`);
  return prefix.toUpperCase() + c.padStart(digits, '0');
}

/**
 * Build a complete print+encode label format.
 * Coordinates are printhead dots — our CP30 is the 300 dpi model (12 dots/mm),
 * so 60×40 mm media = 709×472 dots. widthDots/heightDots are optional overrides
 * (^PW/^LL) — leave null to use the printer's calibrated label size (preferred:
 * after the printer's label learning + RFID calibration, its own numbers are
 * what keep the RFID encode on the SAME label as the print).
 *
 * Two content layouts:
 *  - Semantic (any of productName / itemNo / poRef given — the carton label
 *    design, 2026-08-04): product name, "ITEM No. …", "PO Number …", "EPC …",
 *    barcode. Empty fields skip their line; positions stay fixed so the label
 *    reads the same across a run.
 *  - Legacy single `title` line + EPC + barcode (test prints, old callers).
 */
function buildLabel(opts = {}) {
  const {
    epc,
    title = 'RFID TEST',
    productName = null,
    itemNo = null,
    poRef = null,
    barcode = true,
    widthDots = null,
    heightDots = null,
    // Shift all fields down to position content on the media (printhead dots).
    topOffsetDots = 0,
    // The label web is narrower than the 4.26" head and sits centered/right in
    // the feed path, so head-x=0 is off the label — shift all fields right.
    leftOffsetDots = 0,
    extraZpl = '',
    copies = 1,
  } = opts;
  const hex = validateEpcHex(epc);
  // Strip ZPL control prefixes (^ ~) + control chars from human text so a
  // crafted product name can't break out of ^FD…^FS and inject ZPL commands.
  const clean = (s) => String(s == null ? '' : s).replace(/[\^~\x00-\x1f]/g, ' ').trim();
  const qty = Math.max(1, Math.min(50, Number(copies) || 1));
  // Offsets may be NEGATIVE to move content up / left (toward the leading / left
  // edge); the final ^FO coordinate is clamped at 0 so it never goes off-canvas.
  const oy = Math.round(Number(topOffsetDots) || 0);
  const ox = Math.round(Number(leftOffsetDots) || 0);
  const fx = (bx) => Math.max(0, bx + ox);
  const fy = (by) => Math.max(0, by + oy);

  const z = ['^XA', '^CI28'];
  if (widthDots) z.push(`^PW${widthDots}`);
  if (heightDots) z.push(`^LL${heightDots}`);
  if (extraZpl) z.push(extraZpl);
  z.push(`^RFW,H^FD${hex}^FS`);
  const line = (y, font, text) => z.push(`^FO${fx(24)},${fy(y)}^A0N,${font},${font}^FD${text}^FS`);
  if (productName != null || itemNo != null || poRef != null) {
    // Bare values, no "ITEM No."/"PO Number"/"EPC" prefixes (Brian 2026-08-04).
    if (clean(productName)) line(24, 32, clean(productName));
    if (clean(itemNo)) line(68, 28, clean(itemNo));
    if (clean(poRef)) line(104, 28, clean(poRef));
    line(140, 24, hex);
    if (barcode) z.push(`^FO${fx(24)},${fy(172)}^BY2,3,80^BCN,80,N,N,N^FD${hex}^FS`);
  } else {
    line(24, 32, clean(title));
    line(68, 28, `EPC ${hex}`);
    if (barcode) z.push(`^FO${fx(24)},${fy(112)}^BY2,3,80^BCN,80,N,N,N^FD${hex}^FS`);
  }
  z.push(`^PQ${qty}`);
  z.push('^XZ');
  return z.join('\n') + '\n';
}

module.exports = { validateEpcHex, testEpc, buildLabel };
