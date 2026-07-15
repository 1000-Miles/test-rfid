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
 * Coordinates assume 203 dpi; widthDots/heightDots are optional overrides
 * (^PW/^LL) — leave null to use the printer's calibrated label size.
 */
function buildLabel(opts = {}) {
  const {
    epc,
    title = 'RFID TEST',
    barcode = true,
    widthDots = null,
    heightDots = null,
    // The CP30 starts printing ~this many dots before the label's leading edge
    // reaches the head, so shift all fields down to compensate (203 dpi: 8 dots/mm).
    topOffsetDots = 0,
    // The label web is narrower than the 4.26" head and sits centered/right in
    // the feed path, so head-x=0 is off the label — shift all fields right.
    leftOffsetDots = 0,
    extraZpl = '',
    copies = 1,
  } = opts;
  const hex = validateEpcHex(epc);
  // Strip ZPL control prefixes (^ ~) + control chars from the human title so a
  // crafted product name can't break out of ^FD…^FS and inject ZPL commands.
  const safeTitle = String(title == null ? '' : title).replace(/[\^~\x00-\x1f]/g, ' ');
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
  z.push(`^FO${fx(24)},${fy(24)}^A0N,32,32^FD${safeTitle}^FS`);
  z.push(`^FO${fx(24)},${fy(68)}^A0N,28,28^FDEPC ${hex}^FS`);
  if (barcode) z.push(`^FO${fx(24)},${fy(112)}^BY2,3,80^BCN,80,N,N,N^FD${hex}^FS`);
  z.push(`^PQ${qty}`);
  z.push('^XZ');
  return z.join('\n') + '\n';
}

module.exports = { validateEpcHex, testEpc, buildLabel };
