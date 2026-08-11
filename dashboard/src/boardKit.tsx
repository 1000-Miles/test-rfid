import type { DocLine, Direction } from './documents';
import { lineUnits, pct } from './documents';

/**
 * Shared vocabulary for the gate board screens — the design tokens from the
 * 1000 Miles Hub system, the fluid unit, and the two pieces every screen
 * draws with (item tiles and icons).
 */

/** One design pixel. See `.gate` in index.css — 1px at 1080 × 1920, fluid elsewhere. */
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

/** 2πr for the r = 74 progress ring. */
export const RING_CIRCUMFERENCE = 465;

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

/* ------------------------------------------------------------------ tile */

/**
 * One SKU line of one document. `doc` adds the owning PO / shipment strip —
 * needed when tiles from several documents share a grid.
 */
export function Tile(props: { line: DocLine; dir: Direction; doc?: { label: string; due: number }; onClick?: () => void }) {
  const a = accent(props.dir);
  const { line, doc } = props;
  const done = line.received >= line.expected;
  const started = line.received > 0;
  const due = doc ? dueChip(doc.due) : null;
  // Cartons are what staff act on at the gate — that stays the big badge over
  // the photo. Units are supporting detail (only known when Nexus can derive
  // units-per-carton), so it earns one quiet line of text, not a second badge
  // competing with the first on an already-small card.
  const units = lineUnits(line);

  return (
    <div
      onClick={props.onClick}
      style={{
        borderRadius: u(12),
        background: C.white,
        border: `2px solid ${done ? C.green : started ? a.fill : C.border}`,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        cursor: props.onClick ? 'pointer' : 'default',
      }}
    >
      {doc && due && (
        <div style={{ display: 'flex', alignItems: 'center', gap: u(8), padding: `${u(7)} ${u(11)}`, background: doc.due < 0 ? C.redBg : C.surface, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ fontSize: u(14), fontWeight: 800, letterSpacing: '0.01em', color: C.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.label}</div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: u(10), fontWeight: 800, letterSpacing: '0.1em', color: due.fg, flex: '0 0 auto' }}>{due.short}</div>
        </div>
      )}

      {/* Photo first, then the product's own emoji, then the shared box icon —
          the same precedence Nexus's own UI uses for the same idea record. */}
      <div style={{ position: 'relative', height: u(140), background: C.surface }}>
        {line.photoUrl ? (
          <img src={line.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: done ? C.greenBg : started ? a.soft : C.surface, color: done ? C.greenDk : started ? a.text : C.off }}>
            {line.emoji ? <div style={{ fontSize: u(48), lineHeight: 1 }}>{line.emoji}</div> : <Icon.Box size={44} />}
          </div>
        )}
        <div style={{ position: 'absolute', left: u(8), top: u(8), padding: `${u(3)} ${u(9)}`, borderRadius: u(20), background: 'rgba(255,255,255,0.92)', boxShadow: '0 1px 4px rgba(0,0,0,0.18)', fontSize: u(11), fontWeight: 700, letterSpacing: '0.08em', color: '#525252', fontFamily: "'Courier New', monospace", pointerEvents: 'none' }}>
          {line.sku}
        </div>
        <div style={{ position: 'absolute', right: u(8), bottom: u(8), padding: `${u(5)} ${u(11)}`, borderRadius: u(20), fontSize: u(17), fontWeight: 800, fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', background: done ? C.green : started ? a.text : 'rgba(255,255,255,0.94)', color: done || started ? C.white : C.muted, boxShadow: '0 2px 10px rgba(0,0,0,0.24)' }}>
          {line.received}/{line.expected}
        </div>
      </div>

      <div style={{ padding: `${u(9)} ${u(11)} ${u(11)} ${u(11)}`, display: 'flex', flexDirection: 'column', gap: u(7), flex: 1 }}>
        <div style={{ fontSize: u(14), fontWeight: 600, lineHeight: 1.25, color: C.fg, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{line.name}</div>
        {units && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: u(5), fontSize: u(11) }}>
            <span style={{ fontWeight: 800, letterSpacing: '0.08em', color: C.faint }}>UNITS</span>
            <span style={{ fontWeight: 700, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
              {units.received.toLocaleString()}/{units.expected.toLocaleString()}
            </span>
          </div>
        )}
        <div style={{ marginTop: 'auto', height: u(6), borderRadius: u(4), background: '#e9ebee', overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: u(4), width: `${pct(line.received, line.expected)}%`, background: done ? C.green : started ? a.fill : C.off, transition: 'width .3s ease' }} />
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- icons */

const strokeProps = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const svg = (size: number) => ({ width: u(size), height: u(size), viewBox: '0 0 24 24', ...strokeProps });

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
