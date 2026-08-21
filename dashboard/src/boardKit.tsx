import { useEffect, useRef } from 'react';
import type { DocLine, Direction } from './documents';
import { pct } from './documents';

/**
 * Shared vocabulary for the gate board screens — the design tokens from the
 * 1000 Miles Hub system, the fluid unit, and the two pieces every screen
 * draws with (item tiles and icons).
 */

/** One design pixel. See `.gate` in index.css — 1px at 1920 × 1080, fluid elsewhere. */
export const u = (n: number) => `calc(${n} * var(--u))`;

export const C = {
  white: '#ffffff',
  fg: '#0a0a0a',
  muted: '#737373',
  faint: '#a3a3a3',
  border: '#e5e5e5',
  surface: '#f5f5f5',
  track: '#eef0f2',
  off: '#c7ccd3',
  cyan: '#00BCD4',
  cyanDk: '#008A9C',
  cyanBg: '#e0f7fa',
  cyanEdge: '#7fd9e4',
  orange: '#FF8A00',
  orangeDk: '#C25E00',
  orangeBg: '#fff4e6',
  orangeEdge: '#f5c48a',
  green: '#16a34a',
  greenDk: '#15803d',
  greenBg: '#f0fdf4',
  red: '#df2225',
  redDk: '#b41c1e',
  redBg: '#fef2f2',
  redEdge: '#f0a1a2',
  amberDk: '#b45309',
  amberBg: '#fffbeb',
  amberEdge: '#d97706',
} as const;

export const accent = (dir: Direction) =>
  dir === 'in'
    ? { fill: C.cyan, text: C.cyanDk, soft: C.cyanBg, edge: C.cyanEdge }
    : { fill: C.orange, text: C.orangeDk, soft: C.orangeBg, edge: C.orangeEdge };

export const dayShort = (offset: number) => {
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${String(d.getDate()).padStart(2, '0')} ${mon[d.getMonth()]}`;
};

export const dueChip = (due: number) =>
  due < 0
    ? { label: `OVERDUE · ${dayShort(due)}`, short: 'OVERDUE', bg: C.redBg, fg: C.redDk, edge: C.redEdge }
    : { label: 'DUE TODAY', short: 'TODAY', bg: C.surface, fg: '#525252', edge: C.border };

/** First three words of a product name — the tile shows a short slug, not the
 *  full catalogue title. */
const nameSlug = (name: string) => name.trim().split(/\s+/).slice(0, 3).join(' ');

/* ------------------------------------------------------------------ tile */

/**
 * One SKU line of one document. `doc` adds the owning PO / shipment line —
 * needed when tiles from several documents share a grid.
 *
 * Reading order is product first: photo, name, then the PO it rides on, then
 * the two quantities. The PO used to be a strip across the top of the card,
 * which gave the paperwork the most prominent line on a tile whose whole point
 * is the product — and truncated it to "POP-202…" at compact width, where the
 * body has the full card width to spell it out.
 *
 * Both quantities are shown because they answer different questions and are
 * off by the case pack: CARTONS is what crosses the gate and gets counted
 * (it stays the badge over the photo, where the eye lands), UNITS is what the
 * PO is actually for. Units only appear when Nexus can derive units-per-carton.
 *
 * `compact` shrinks the photo and the type by roughly a quarter. The overview
 * stacks two directions of three status boxes each, which leaves a box about
 * 240u tall — a full-size tile (~260u) wouldn't show even one row there. Every
 * other screen gives a grid the whole content area and uses the full size.
 *
 * `focused` marks the product a gate read just credited. Nobody can scroll a
 * wall-mounted TV, so the tile scrolls itself into view inside whatever box it
 * has landed in — and it may well have just landed in a different box, since
 * counting a carton is exactly what moves a line from "to receive" to
 * "partially received".
 */
export function Tile(props: { line: DocLine; dir: Direction; doc?: { label: string; due: number }; compact?: boolean; large?: boolean; focused?: boolean; onClick?: () => void }) {
  const a = accent(props.dir);
  const { line, doc } = props;
  const done = line.received >= line.expected;
  const started = line.received > 0;
  const due = doc ? dueChip(doc.due) : null;

  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!props.focused) return;
    // 'nearest' scrolls the box's own overflow only — never the page.
    ref.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [props.focused]);
  // On the 43" panel 1u ≈ 0.5 mm, so the photo is what shrinks hard in compact
  // and the type barely moves: the name and the two quantities are what anyone
  // actually reads off a tile, and dropping them below ~10u would put them
  // under a metre of legible viewing distance.
  const s = props.large
    ? { photo: 164, po: 14, short: 13, sku: 13, badge: 19, glyph: 58, icon: 52, name: 19, qty: 23, padX: 16, padY: 13, inset: 10, gap: 10 }
    : props.compact
      ? { photo: 78, po: 8, short: 8, sku: 8, badge: 12, glyph: 28, icon: 24, name: 10, qty: 8, padX: 8, padY: 7, inset: 6, gap: 4 }
      : { photo: 140, po: 10, short: 9, sku: 9, badge: 14, glyph: 48, icon: 44, name: 12, qty: 10, padX: 11, padY: 9, inset: 8, gap: 6 };

  return (
    <div
      ref={ref}
      onClick={props.onClick}
      className={props.focused ? 'gate-focus' : undefined}
      style={{
        position: 'relative',
        borderRadius: u(12),
        background: C.white,
        border: `2px solid ${props.focused ? a.text : done ? C.green : started ? a.fill : C.border}`,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        cursor: props.onClick ? 'pointer' : 'default',
      }}
    >
      {/* Photo first, then the product's own emoji, then the shared box icon —
          the same precedence Nexus's own UI uses for the same idea record. */}
      <div style={{ position: 'relative', height: u(s.photo), background: C.surface }}>
        {line.photoUrl ? (
          <img src={line.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: done ? C.greenBg : started ? a.soft : C.surface, color: done ? C.greenDk : started ? a.text : C.off }}>
            {line.emoji ? <div style={{ fontSize: u(s.glyph), lineHeight: 1 }}>{line.emoji}</div> : <Icon.Box size={s.icon} />}
          </div>
        )}
      </div>

      <div style={{ padding: `${u(s.padY)} ${u(s.padX)} ${u(s.padX)} ${u(s.padX)}`, display: 'flex', flexDirection: 'column', gap: u(s.gap), flex: 1 }}>
        <div style={{ fontSize: u(s.name), fontWeight: 600, lineHeight: 1.25, color: C.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{nameSlug(line.name)}</div>

        {/* Only the exception is worth a word: OVERDUE still earns its place
            even with the PO label gone. */}
        {due && doc && doc.due < 0 && (
          <div style={{ fontSize: u(s.po), fontWeight: 800, letterSpacing: '0.08em', color: due.fg }}>{due.short}</div>
        )}

        {/* Cartons moved off the photo — the badge obstructed the product
            image, so the pair now reads as a labelled row. */}
        <div style={{ fontSize: u(s.qty), padding: props.large ? `${u(8)} ${u(10)}` : 0, borderRadius: props.large ? u(8) : 0, background: props.large ? (done ? C.greenBg : started ? a.soft : C.surface) : 'transparent' }}>
          <Qty label="CTN" received={line.received} expected={line.expected} prominent={props.large} accent={done ? C.greenDk : a.text} />
        </div>

        <div style={{ marginTop: 'auto', height: u(props.large ? 10 : 6), borderRadius: u(5), background: '#e9ebee', overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: u(4), width: `${pct(line.received, line.expected)}%`, background: done ? C.green : started ? a.fill : C.off, transition: 'width .3s ease' }} />
        </div>
      </div>
    </div>
  );
}

/** One labelled `received / expected` pair on a tile. Fixed-width label so the
 *  numbers line up between the carton row and the unit row. */
function Qty(props: { label: string; received: number; expected: number; prominent?: boolean; accent?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: u(props.prominent ? 9 : 6), whiteSpace: 'nowrap', lineHeight: 1 }}>
      <span style={{ fontWeight: 800, letterSpacing: '0.08em', color: props.prominent ? C.muted : C.faint, flex: '0 0 auto', minWidth: u(props.prominent ? 52 : 38) }}>{props.label}</span>
      <span style={{ fontWeight: 800, color: props.prominent ? props.accent : C.fg, fontVariantNumeric: 'tabular-nums' }}>{props.received.toLocaleString()}</span>
      <span style={{ fontWeight: props.prominent ? 700 : 600, color: props.prominent ? C.muted : C.faint, fontVariantNumeric: 'tabular-nums' }}>/ {props.expected.toLocaleString()}</span>
    </div>
  );
}

/* ----------------------------------------------------------------- icons */

const strokeProps = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
// Size via style, not the width/height attributes: older TV browsers don't
// accept calc()/var() in SVG presentation attributes, and an invalid width
// makes the SVG default to 100% — a screen-filling icon on the wallboard.
const svg = (size: number) => ({ style: { width: u(size), height: u(size), flex: '0 0 auto' }, viewBox: '0 0 24 24', ...strokeProps });

export const Icon = {
  Box: ({ size }: { size: number }) => (
    <svg {...svg(size)}>
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </svg>
  ),
  Truck: ({ size }: { size: number }) => (
    <svg {...svg(size)}>
      <path d="M14 18V6a1 1 0 0 0-1-1H2a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h2" />
      <path d="M14 9h4l3 3v5a1 1 0 0 1-1 1h-1" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
    </svg>
  ),
  Warning: ({ size, color }: { size: number; color?: string }) => (
    <svg {...svg(size)} stroke={color ?? 'currentColor'}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  ),
  Gear: ({ size }: { size: number }) => (
    <svg {...svg(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.6.66 1.03 1.28 1.05H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  ),
  ArrowIn: ({ size }: { size: number }) => (
    <svg {...svg(size)}>
      <path d="M12 3v11" />
      <path d="m7.5 9.5 4.5 4.5 4.5-4.5" />
      <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
    </svg>
  ),
  ArrowOut: ({ size }: { size: number }) => (
    <svg {...svg(size)}>
      <path d="M12 21V10" />
      <path d="m7.5 14.5 4.5-4.5 4.5 4.5" />
      <path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" />
    </svg>
  ),
  Plus: ({ size }: { size: number }) => (
    <svg {...svg(size)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  ),
};
