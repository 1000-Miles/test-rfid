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
 * Default canvas used to compute coordinates when the caller leaves
 * widthDots/heightDots null (= "use the printer's calibrated label size").
 * ^PW/^LL are still not emitted in that case — the printer's own calibration
 * governs the media — but the ROW COORDINATES have to be computed against some
 * canvas, and it must be the real one. Our media is 60×40 mm on the 300 dpi
 * CP30 (12 dots/mm) = 709×472 dots.
 */
const DEFAULT_WIDTH_DOTS = 638;
const DEFAULT_HEIGHT_DOTS = 402;

/**
 * The EPC prints as two lines rather than one. It is the longest string on the
 * label by far, and since every row shares one type size (see the layout), a
 * 24-char EPC on ONE line is what caps that size — on 54x34 mm media it holds
 * every row down to ~3.6 mm. Split in half it needs less than half the width,
 * the cap roughly doubles, and the EPC still prints at the same size as the
 * rest. The break is explicit (ZPL's \&) because a hex string has no spaces for
 * ^FB to wrap on.
 */
const EPC_LINES = 2;

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
 *    label design, 2026-08-04): product name, item no., PO ref, EPC, barcode.
 *    Empty fields skip their row entirely. `boxId` selects this layout but is
 *    not printed (see the content section).
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
  // `boxId` still selects the semantic layout and is still recorded in the print
  // log, but it is NOT printed (Riza 2026-08-13): the carton is identified by its
  // EPC, and dropping it lets the product name have the row to itself.
  const semantic = boxId != null || productName != null || itemNo != null || poRef != null;
  // Bare values, no "ITEM No."/"PO Number"/"EPC" prefixes (Brian 2026-08-04);
  // the legacy title layout keeps its "EPC " prefix for the test prints.
  const heading = semantic ? clean(productName) : clean(title);
  const textRows = (semantic ? [heading, clean(itemNo), clean(poRef)] : [heading]).filter(Boolean);
  const epcText = semantic ? hex : `EPC ${hex}`;

  // ── Layout ─────────────────────────────────────────────────────────────────
  // Every coordinate is derived from the LABEL SIZE ALONE — never from the text
  // — so the same row lands in the same place on every label. Each row owns a
  // fixed-height SLOT; text too long for its slot shrinks its own font to fit
  // instead of growing the slot and pushing everything below it down. That is
  // what keeps a calibration test print and a live carton label identically
  // spaced even though their product names are different lengths.
  const W = widthDots || DEFAULT_WIDTH_DOTS;
  const H = heightDots || DEFAULT_HEIGHT_DOTS;
  const target = Math.round(W * 0.9); // 90% span for the wide elements
  // One shared left margin for every row so their left edges line up.
  const left = fx(0);
  // Usable text width = label width minus the left inset and a right margin, so a
  // long product name WRAPS (^FB) instead of running off the right edge.
  const textWidth = Math.max(120, W - left - Math.round(W * 0.05));

  const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
  // ^A0 (scalable font 0) draws roughly this wide per unit of height.
  const CHAR_ASPECT = 0.55;

  const margin = Math.round(H * 0.05);
  const usable = Math.max(1, H - margin * 2);

  // Row slots, as a proportion of the label height, all scaled together by
  // `scale` (see the fit loop below).
  //
  // Every text row — product name, assortment number, PO number, EPC — prints at
  // ONE size (TEXT_H); the rows differ only in how many lines they reserve.
  // `lines` is the space a slot RESERVES, not a measurement of the text.
  const plan = (scale) => {
    // One size for every row means that size is bounded by the LONGEST line on
    // the label — the EPC, split across EPC_LINES. Capping here, rather than
    // letting fitFont shrink the EPC on its own, is what keeps all rows
    // genuinely identical. (The EPC is a fixed 24 hex chars, so this stays
    // content-independent.)
    const epcPerLine = Math.ceil(epcText.length / EPC_LINES);
    const epcCap = Math.floor((textWidth * 0.95) / Math.max(1, epcPerLine) / CHAR_ASPECT);
    const TEXT_H = Math.min(clampInt(H * 0.22 * scale, 16, 140), Math.max(16, epcCap));
    // The name gets ONE line, like every other row. Reserving more so a long
    // name could wrap meant a short name left the spare line blank between
    // itself and the assortment number — a gap on most labels to accommodate a
    // few. A name too long for its line shrinks to fit (fitFont) instead, which
    // costs size only on the labels that actually need it and never moves a row.
    const HEAD = { h: TEXT_H, lines: 1, lead: 0 };
    const DETAIL = { h: TEXT_H, lines: 1, lead: 0 };
    const epcSlot = { h: TEXT_H, lines: EPC_LINES, lead: Math.round(TEXT_H * 0.1) };
    const gap = Math.max(8, Math.round(H * 0.02 * scale));
    const slots = textRows.map((t, i) => ({ text: t, ...(i === 0 ? HEAD : DETAIL) }));
    const block = (s) => s.lines * s.h + (s.lines - 1) * s.lead;
    const rows = [...slots.map(block), block(epcSlot)];
    const textH = rows.reduce((a, b) => a + b, 0) + gap * (rows.length - 1);
    // The barcode takes whatever height is left rather than a fixed share, so it
    // runs as tall as the label allows instead of leaving the bottom empty. It
    // depends only on the rows present, so it stays the same across labels.
    const barH = barcode ? clampInt(usable - textH - gap, 40, Math.round(H * 0.45)) : 0;
    const stackH = textH + (barcode ? gap + barH : 0);
    return { slots, block, epcSlot, barH, gap, stackH };
  };

  // Shrink the WHOLE stack — never one row — until it fits inside the label's
  // margins. Scaling everything together keeps the rows in proportion, and keeps
  // the result content-independent: short media just prints the same design
  // smaller. A couple of passes converge; the per-slot floors above win after
  // that, which is the point (legibility, not a fit at any cost).
  let scale = 1;
  let L = plan(scale);
  for (let i = 0; i < 4 && L.stackH > usable; i++) {
    scale *= usable / L.stackH;
    L = plan(scale);
  }

  // Largest character cell that draws `text` inside `lines` lines of `slot.h`.
  // The 0.95 factor leaves slack for ^FB's word wrapping, which can break a line
  // early and so needs a little more room than a raw character count implies.
  const fitFont = (text, slot) => {
    const maxW = Math.max(4, Math.floor(slot.h * CHAR_ASPECT));
    const perLine = Math.max(1, Math.ceil(text.length / slot.lines));
    const w = Math.max(5, Math.min(maxW, Math.floor((textWidth * 0.95) / perLine)));
    return { w, h: Math.max(10, Math.round(w / CHAR_ASPECT)) };
  };

  const measured = L.slots.map((s) => ({ ...s, ...fitFont(s.text, s), block: L.block(s) }));
  const epcFont = fitFont(epcText, L.epcSlot);
  const epcW = epcFont.w;
  const epcH = epcFont.h;

  // Barcode row (visual only; read by RFID, not laser). A Code 128's width =
  // (11·S + 13) modules; estimate S (digit pairs compress via subset C), then pick
  // the largest integer module whose bars fit the full width.
  const barH = L.barH;
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
  // sit close together, not spread across the whole height. Every block here is a
  // fixed SLOT height, so the stack — and therefore the start Y and every row
  // below it — depends only on which rows are present, never on how long their
  // text is.
  const gap = L.gap;
  let y = Math.max(margin, Math.round((H - L.stackH) / 2));

  for (const m of measured) {
    z.push(`^FO${left},${fy(y)}^A0N,${m.h},${m.w}^FB${textWidth},${m.lines},${m.lead},L,0^FD${m.text}^FS`);
    y += m.block + gap;
  }
  // The EPC over EPC_LINES lines. ^FB word-wraps, and a hex string is one
  // unbroken "word", so the breaks are placed explicitly with ZPL's \& — that
  // also keeps every line an equal, predictable length.
  const epcChunk = Math.ceil(epcText.length / EPC_LINES);
  const epcLines = [];
  for (let i = 0; i < epcText.length; i += epcChunk) epcLines.push(epcText.slice(i, i + epcChunk));
  z.push(
    `^FO${left},${fy(y)}^A0N,${epcH},${epcW}` +
      `^FB${textWidth},${L.epcSlot.lines},${L.epcSlot.lead},L,0^FD${epcLines.join('\\&')}^FS`,
  );
  y += L.block(L.epcSlot) + gap;
  if (barcode) z.push(`^FO${left},${fy(y)}^BY${mod},2,${barH}^BCN,${barH},N,N,N^FD${hex}^FS`);
  z.push(`^PQ${qty}`);
  z.push('^XZ');
  return z.join('\n') + '\n';
}

module.exports = { validateEpcHex, testEpc, buildLabel };
