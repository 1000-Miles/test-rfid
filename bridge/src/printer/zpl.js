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
 * Whether the EPC prints as a line of text, UNDER the barcode (Riza 2026-08-14).
 *
 * Below rather than above, and deliberately not part of the shared type size of
 * the rows above it. As one of those rows it was the most expensive thing on
 * the label: every row shares one size, that size is capped by the longest row,
 * and a 24-char EPC across 54 mm held ALL text to ~3.6 mm — while splitting it
 * over two lines to lift the cap cost a whole row and left the barcode at its
 * floor. As a caption it is sized on its own, so it costs only its own height
 * and caps nothing. It is also where a barcode's human-readable line belongs.
 */
const SHOW_EPC_TEXT = true;

/**
 * The product name is truncated to what fits its line, with an ellipsis, rather
 * than being allowed to set the type size.
 *
 * It is the only row whose length is unbounded — assortment number, PO
 * reference and carton count are all short. While the shared type size was
 * bounded by the longest row, one long name shrank every row on the label: the
 * same job printed 2.6mm rows under a ballooning barcode for "MMCT - Test
 * Product 1 - Purple Sheet" and 5.2mm rows for "A003945 - reess". Truncating
 * makes the name fit the label instead of the label fit the name, so every
 * carton comes out identical. ASCII dots, because clean() strips the single-
 * glyph ellipsis along with everything else the built-in font cannot draw.
 */
const ELLIPSIS = '...';


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
    // Which carton this is, and how many the product has in total. Rendered as
    // "Carton 1 of 30"; with no total, just "Carton 1".
    cartonNo = null,
    cartonTotal = null,
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
  const semantic =
    boxId != null || productName != null || itemNo != null || poRef != null || cartonNo != null;
  // "Carton 3 of 30" — the count is dropped when unknown rather than printing a
  // half-sentence, and a non-numeric or zero carton number drops the row.
  const cartonN = Math.round(Number(cartonNo));
  const cartonT = Math.round(Number(cartonTotal));
  const cartonText =
    Number.isFinite(cartonN) && cartonN > 0
      ? `Carton ${cartonN}${Number.isFinite(cartonT) && cartonT > 0 ? ` of ${cartonT}` : ''}`
      : '';
  // Bare values, no "ITEM No."/"PO Number"/"EPC" prefixes (Brian 2026-08-04);
  // the legacy title layout keeps its "EPC " prefix for the test prints.
  // Assortment number and product name share one row ("A001837 - Bunny Socks",
  // Riza 2026-08-14). They read as one identifier, and on 54x34mm media the row
  // this saves is worth more than the separation: every remaining row gets
  // taller, and so does the barcode.
  const heading = semantic
    ? [clean(itemNo), clean(productName)].filter(Boolean).join(' - ')
    : clean(title);
  const textRows = (semantic ? [heading, clean(poRef), cartonText] : [heading]).filter(Boolean);
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
  // How wide each character actually is, as a fraction of the nominal cell.
  //
  // ^A0 is proportional, and NOT by a single average — that was the mistake
  // behind every wrong guess at this. A capital is far wider than a lowercase
  // letter, so one average is too tight for "PURPLE GLOVES" and too loose for
  // "Purple Gloves", and the fit moved with whatever the product happened to be
  // called. Too loose is the damaging direction: ^FB clips a line silently and
  // takes the "..." with it, so the name then looks complete when it is not.
  //
  // Measured off a ruler label printed at this exact font (^A0N,53,29 on 54 mm
  // media, 2026-08-14): 36 uppercase ran out at ~32, 36 lowercase fitted whole,
  // 40 digits ran out at ~34. Those three give the weights below, which predict
  // all three rows — and a real product name — to within a character.
  const charUnits = (ch) => {
    if (ch >= 'A' && ch <= 'Z') return 0.7;
    if (ch >= '0' && ch <= '9') return 0.66;
    if (ch >= 'a' && ch <= 'z') return 0.55;
    return 0.35; // space, hyphen, punctuation — narrower than either case
  };
  const textUnits = (s) => {
    let u = 0;
    for (const ch of s) u += charUnits(ch);
    return u;
  };

  const margin = Math.round(H * 0.03);
  const usable = Math.max(1, H - margin * 2);

  // Every text row is ONE line at ONE size, and a row's SLOT is exactly as tall
  // as the glyphs in it.
  //
  // Both halves of that matter. Sizing the slot from the label while letting the
  // glyphs shrink to fit their text leaves dead space under every row — visible
  // as gaps between the lines, and worse the longer the text, because the
  // glyphs shrink while the slot does not. So the shared glyph size is settled
  // FIRST and the slots are built from it.
  const plan = (scale) => {
    // The type size, as a share of label height — and with it, how much of the
    // product name survives, since the two trade directly: bigger type, fewer
    // characters before the ellipsis. 0.13 is ~4.5 mm on 54x34 mm media, which
    // holds ~33 characters (Riza's pick, 2026-08-14; 0.17 gave 5.8 mm and only
    // ~25). It is also a budget, not just a target — set it high enough that the
    // rows alone fill the label and there is nothing left for the barcode.
    const maxH = clampInt(H * 0.13 * scale, 16, 140);
    // The type size comes from the LABEL ALONE — no text of any kind feeds into
    // it. Anything else couples the two: while the size was fitted to the
    // "short" rows, a product on two POs ("POP-2026-156, POP-2026-157") or a
    // carton row reading "Carton 12 of 240" was enough to shrink the type and,
    // because the barcode takes what the rows leave, stretch the barcode to
    // match. Cartons of one job came out looking like different designs.
    //
    // With the size fixed, everything downstream is fixed too: row heights, the
    // gaps, and the barcode all follow from the label size and the NUMBER of
    // rows. Text that does not fit is cut (see ELLIPSIS) instead of resizing the
    // label around itself.
    const sharedW = Math.max(5, Math.floor(maxH * CHAR_ASPECT));
    const TEXT_H = Math.max(10, Math.round(sharedW / CHAR_ASPECT));
    const gap = Math.max(8, Math.round(H * 0.02 * scale));
    // Cut a row to what its own characters actually occupy, against the SAME
    // width ^FB clips at. Measuring the string beats any character count: the
    // count that fits depends on what the characters ARE, so "PURPLE GLOVES"
    // and "Purple Gloves" do not fit the same number of them.
    //
    // Applied to every row, not just the name — a PO row for a product ordered
    // on several POs can outrun the line too, and an ellipsis beats ^FB silently
    // dropping the tail.
    const fitText = (t) => {
      if (textUnits(t) * sharedW <= textWidth) return t;
      let s = t;
      while (s.length > 1 && textUnits(s + ELLIPSIS) * sharedW > textWidth) s = s.slice(0, -1);
      return s.trimEnd() + ELLIPSIS;
    };
    const slots = textRows.map((t) => ({ text: fitText(t), h: TEXT_H, w: sharedW, lines: 1, lead: 0 }));
    const block = (s) => s.lines * s.h + (s.lines - 1) * s.lead;
    const rows = slots.map(block);
    const textH = rows.reduce((a, b) => a + b, 0) + gap * Math.max(0, rows.length - 1);
    // EPC caption under the barcode: one line, as large as the width allows but
    // never bigger than the rows above. It is width-bound, not height-bound, so
    // it gets the label's FULL width (the rows keep a right margin to wrap in;
    // a single unwrappable line does not need one) and only a slim advance
    // discount — hex is uppercase and digit-heavy, so it advances much closer to
    // the nominal cell than a lowercase-heavy row and must not overrun the edge.
    const capWidth = Math.max(120, W - left);
    const capW = SHOW_EPC_TEXT
      ? Math.max(5, Math.min(Math.floor(TEXT_H * CHAR_ASPECT), Math.floor((capWidth * 0.97) / Math.max(1, textUnits(epcText)))))
      : 0;
    const capH = SHOW_EPC_TEXT ? Math.max(10, Math.round(capW / CHAR_ASPECT)) : 0;
    // The barcode takes whatever height is left rather than a fixed share, so it
    // runs as tall as the label allows instead of leaving the bottom empty. It
    // depends only on the rows present, so it stays the same across labels.
    const capCost = SHOW_EPC_TEXT ? capH + gap : 0;
    // Capped, not merely "whatever is left": uncapped, a label whose rows happen
    // to be short handed the entire surplus to the barcode, which then dwarfed
    // the text. Surplus beyond the cap becomes margin instead (the stack is
    // centred), which reads as deliberate.
    const barH = barcode ? clampInt(usable - textH - gap - capCost, 40, Math.round(H * 0.45)) : 0;
    const stackH = textH + (barcode ? gap + barH : 0) + capCost;
    return { slots, block, barH, gap, stackH, capW, capH };
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

  // The slots already carry the shared glyph size (see plan), so a row's box is
  // exactly as tall as its text — no dead space to show up as a gap.
  const measured = L.slots.map((s) => ({ ...s, block: L.block(s) }));

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
  if (barcode) {
    z.push(`^FO${left},${fy(y)}^BY${mod},2,${barH}^BCN,${barH},N,N,N^FD${hex}^FS`);
    y += barH + gap;
  }
  // The EPC, reading under the barcode it encodes.
  if (SHOW_EPC_TEXT) z.push(`^FO${left},${fy(y)}^A0N,${L.capH},${L.capW}^FD${epcText}^FS`);
  z.push(`^PQ${qty}`);
  z.push('^XZ');
  return z.join('\n') + '\n';
}

module.exports = { validateEpcHex, testEpc, buildLabel };
