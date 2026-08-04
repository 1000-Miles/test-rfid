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
 *  - Semantic (any of boxId / productName / itemNo / poRef given — the carton
 *    label design, 2026-08-04): heading (box ID + product name), item no.,
 *    PO ref, EPC, barcode. Empty fields skip their row entirely.
 *  - Legacy single `title` line + "EPC …" + barcode (test prints, old callers).
 *
 * Either way the ROWS are only declared as content here; their coordinates are
 * computed from the label size below (never hardcoded), so the label stays
 * correct at any resolution and adding/removing a row never means re-picking
 * coordinates by hand.
 */
function buildLabel(opts = {}) {
  const {
    epc,
    title = 'RFID TEST',
    boxId = null,
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
  // Applied to every piece of human text on the label.
  const clean = (s) =>
    String(s == null ? '' : s)
      .replace(/[\^~\x00-\x1f]/g, ' ') // strip ZPL control prefixes + control chars so a crafted product name can't break out of ^FD…^FS and inject ZPL
      .replace(/[^\x20-\x7e]/g, '') // drop glyphs the built-in font can't draw (CJK, em-dash) — they print as tofu / ??
      .replace(/\s{2,}/g, ' ') // collapse the gaps left by removed characters
      .trim();
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
  // Always encode the FULL EPC to the chip — independent of what fits in print.
  z.push(`^RFW,H^FD${hex}^FS`);

  // ── Content ────────────────────────────────────────────────────────────────
  // Which text rows this label carries. Empty fields drop out entirely rather
  // than leaving a blank gap, and the layout below re-spaces whatever survives.
  const semantic = boxId != null || productName != null || itemNo != null || poRef != null;
  // Bare values, no "ITEM No."/"PO Number"/"EPC" prefixes (Brian 2026-08-04);
  // the legacy title layout keeps its "EPC " prefix for the test prints.
  const heading = semantic
    ? [clean(boxId), clean(productName)].filter(Boolean).join('  ')
    : clean(title);
  const textRows = (semantic ? [heading, clean(itemNo), clean(poRef)] : [heading]).filter(Boolean);
  const epcText = semantic ? hex : `EPC ${hex}`;

  // ── Layout ─────────────────────────────────────────────────────────────────
  // Everything below is computed from the label size (never hardcoded) so it
  // stays correct at any resolution — the rows are measured, then spaced with
  // EQUAL gaps and centred on the label.
  const W = widthDots || 400;
  const H = heightDots || Math.round(W * 1.03);
  const target = Math.round(W * 0.9); // 90% span for the wide elements
  // One shared left margin for every row so their left edges line up.
  const left = fx(0);
  // Usable text width = label width minus the left inset and a right margin, so a
  // long product name WRAPS (^FB) instead of running off the right edge.
  const textWidth = Math.max(120, W - left - Math.round(W * 0.05));

  // Text rows — the heading is the largest; the detail lines under it a step
  // smaller. Estimate each row's wrapped line count so the spacing stays even
  // regardless of text length (the printer does the real wrapping via ^FB; this
  // only budgets the vertical space for it).
  const HEAD = { h: 34, w: 18, lead: 8, maxLines: 3 };
  const DETAIL = { h: 28, w: 14, lead: 6, maxLines: 2 };
  const measure = (text, m) => {
    const charsPerLine = Math.max(1, Math.floor(textWidth / m.w));
    const lines = Math.min(m.maxLines, Math.max(1, Math.ceil(text.length / charsPerLine)));
    return { ...m, text, block: lines * m.h + (lines - 1) * m.lead };
  };
  const measured = textRows.map((t, i) => measure(t, i === 0 ? HEAD : DETAIL));

  // EPC row — one line, char width sized so the whole string fills ~90%.
  const epcW = Math.max(6, Math.floor(target / epcText.length));
  const epcH = Math.round(epcW * 1.5);

  // Barcode row (visual only; read by RFID, not laser). A Code 128's width =
  // (11·S + 13) modules; estimate S (digit pairs compress via subset C), then pick
  // the largest integer module whose bars fit the full width.
  const barH = 120;
  let mod = 0;
  if (barcode) {
    let sym = 1; // start char
    for (let i = 0; i < hex.length; ) {
      const run = (hex.slice(i).match(/^[0-9]+/) || [''])[0].length;
      if (run >= 4) { const pairs = Math.floor(run / 2); sym += 1 + pairs; i += pairs * 2; } // subset C
      else { sym += 1; i += 1; } // subset B
    }
    sym += 1; // checksum
    const modules = 11 * sym + 13;
    // Fit within ~90% (not the full width) so the bars keep a margin off the
    // right/left edges instead of bleeding to the media edge.
    mod = Math.min(10, Math.max(1, Math.floor(target / modules)));
  }

  // Distribute the rows with EQUAL gaps and centre the stack vertically — rows
  // sit close together, not spread across the whole height. The gap is clamped so
  // it's neither cramped nor absurdly sparse on a tall label.
  const gap = Math.max(20, Math.round(H * 0.04));
  const blocks = [...measured.map((m) => m.block), epcH, ...(barcode ? [barH] : [])];
  const stackH = blocks.reduce((a, b) => a + b, 0) + gap * (blocks.length - 1);
  let y = Math.max(Math.round(H * 0.05), Math.round((H - stackH) / 2));

  for (const m of measured) {
    z.push(`^FO${left},${fy(y)}^A0N,${m.h},${m.w}^FB${textWidth},${m.maxLines},${m.lead},L,0^FD${m.text}^FS`);
    y += m.block + gap;
  }
  z.push(`^FO${left},${fy(y)}^A0N,${epcH},${epcW}^FD${epcText}^FS`);
  y += epcH + gap;
  if (barcode) z.push(`^FO${left},${fy(y)}^BY${mod},2,${barH}^BCN,${barH},N,N,N^FD${hex}^FS`);
  z.push(`^PQ${qty}`);
  z.push('^XZ');
  return z.join('\n') + '\n';
}

module.exports = { validateEpcHex, testEpc, buildLabel };
