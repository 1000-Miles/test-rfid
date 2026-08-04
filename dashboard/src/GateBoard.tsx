import { useEffect, useMemo, useRef, useState } from 'react';
import { activeDocs, docTotals, pct, sumTotals, type Direction, type GateDoc, type GateBoardApi } from './documents';
import { accent, C, dueChip, Icon, RING_CIRCUMFERENCE, Tile, u } from './boardKit';
import { AddButton, ReceivingTab, ShippingTab } from './FooterTabs';
import DirectionView from './DirectionView';
import type { BridgeState } from './useBridge';

/**
 * Portrait warehouse gate board — 1080 × 1920 kiosk.
 *
 * Three screens, switched by local state (the URL stays /gateboard):
 *   Overview      — both directions at a glance, one row per document
 *   DirectionView — a footer tab: every item from every PO / shipment
 *   DocumentView  — one document, opened from a row, a tile, or a gate read
 *
 * Layout is a port of warehousePrototypeLayout/, expressed in the fluid unit
 * `--u` (see .gate in index.css): one design pixel.
 */

const IDLE_TIMEOUT_MS = 45_000;

export default function GateBoard(props: { bridge: BridgeState; board: GateBoardApi; onOpenControls: () => void }) {
  const { bridge, board } = props;
  const { docs, pool, exceptions } = board.board;

  const [mode, setMode] = useState<'idle' | 'live'>('idle');
  const [dir, setDir] = useState<Direction>('in');
  /** null = the whole direction; an id = that one document. */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [showExc, setShowExc] = useState(false);
  const [pending, setPending] = useState<GateDoc | null>(null);
  const [filter, setFilter] = useState('All');

  const lastTouch = useRef(Date.now());
  const touch = () => (lastTouch.current = Date.now());

  // A gate read pulls the board to the document it credited.
  useEffect(() => {
    if (!board.lastCounted) return;
    touch();
    setDir(board.lastCounted.dir);
    setActiveId(board.lastCounted.docId);
    setMode('live');
    setShowAdd(false);
  }, [board.lastCounted]);

  // Kiosk returns to the overview when nobody is touching it.
  useEffect(() => {
    const t = setInterval(() => {
      if (mode === 'idle' || showAdd || showExc || pending) return;
      if (Date.now() - lastTouch.current > IDLE_TIMEOUT_MS) {
        setMode('idle');
        setActiveId(null);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [mode, showAdd, showExc, pending]);

  // "READING" pill: the reader is bursting, or a read just landed.
  const [justRead, setJustRead] = useState(false);
  useEffect(() => {
    if (!board.lastCounted) return;
    setJustRead(true);
    const t = setTimeout(() => setJustRead(false), 1100);
    return () => clearTimeout(t);
  }, [board.lastCounted]);

  const inDocs = useMemo(() => activeDocs(docs, 'in'), [docs]);
  const outDocs = useMemo(() => activeDocs(docs, 'out'), [docs]);
  const inTotals = useMemo(() => sumTotals(inDocs), [inDocs]);
  const outTotals = useMemo(() => sumTotals(outDocs), [outDocs]);

  const dirDocs = dir === 'in' ? inDocs : outDocs;
  const activeDoc = activeId ? (dirDocs.find((d) => d.id === activeId) ?? null) : null;

  const open = (nextDir: Direction, id: string | null) => {
    touch();
    setDir(nextDir);
    setActiveId(id);
    setMode('live');
  };

  const goIdle = () => {
    touch();
    setMode('idle');
    setActiveId(null);
    setShowAdd(false);
    setShowExc(false);
    setPending(null);
  };

  return (
    <div className="gate" style={{ width: u(1080), height: '100%', margin: '0 auto', position: 'relative', overflow: 'hidden', background: C.white, color: C.fg, display: 'flex', flexDirection: 'column', userSelect: 'none' }}>
      <Header
        scanning={bridge.status.reading || justRead}
        online={bridge.wsConnected && bridge.status.connected}
        exceptionCount={exceptions.length}
        onExceptions={() => {
          touch();
          setShowExc(true);
        }}
        onControls={() => {
          touch();
          props.onOpenControls();
        }}
      />

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {mode === 'idle' ? (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: u(22), padding: `${u(26)} ${u(32)}` }}>
            <SummaryCard dir="in" docs={inDocs} totals={inTotals} onOpen={(id) => open('in', id)} />
            <SummaryCard dir="out" docs={outDocs} totals={outTotals} onOpen={(id) => open('out', id)} />
          </div>
        ) : activeDoc ? (
          <DocumentView dir={dir} doc={activeDoc} onBack={goIdle} onAll={() => open(dir, null)} />
        ) : (
          <DirectionView dir={dir} docs={dirDocs} onBack={goIdle} onOpenDoc={(id) => open(dir, id)} />
        )}

        {board.dupMsg && <DupToast message={board.dupMsg} />}
        {board.flashTag && <UnknownFlash tag={board.flashTag} />}
      </div>

      <div style={{ flex: `0 0 ${u(168)}`, display: 'flex', gap: u(18), padding: `${u(20)} ${u(32)}`, background: C.white, borderTop: `1px solid ${C.border}`, position: 'relative', zIndex: 20 }}>
        <ReceivingTab active={mode === 'live' && dir === 'in'} totals={inTotals} onClick={() => open('in', null)} />
        <ShippingTab active={mode === 'live' && dir === 'out'} totals={outTotals} onClick={() => open('out', null)} />
        <AddButton
          onClick={() => {
            touch();
            setFilter('All');
            setShowAdd(true);
          }}
        />
      </div>

      {showAdd && (
        <AddScreen
          pool={pool}
          filter={filter}
          onFilter={setFilter}
          onPick={(doc) => {
            touch();
            setPending(doc);
          }}
          onClose={() => setShowAdd(false)}
          onOverview={goIdle}
        />
      )}

      {pending && (
        <ConfirmModal
          doc={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            board.addFromPool(pending.id);
            setPending(null);
            setShowAdd(false);
          }}
        />
      )}

      {showExc && (
        <ExceptionsScreen
          rows={exceptions}
          onClear={() => {
            board.clearExceptions();
            setShowExc(false);
          }}
          onClose={() => setShowExc(false)}
          onOverview={goIdle}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- header */

function Header(props: { scanning: boolean; online: boolean; exceptionCount: number; onExceptions: () => void; onControls: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dateLabel = `${days[now.getDay()]} · ${String(now.getDate()).padStart(2, '0')} ${mon[now.getMonth()]} ${now.getFullYear()}`;

  return (
    <div style={{ flex: `0 0 ${u(112)}`, display: 'flex', alignItems: 'center', gap: u(22), padding: `0 ${u(32)}`, background: C.white, borderBottom: `1px solid ${C.border}`, position: 'relative', zIndex: 20 }}>
      <div style={{ width: u(62), height: u(62), borderRadius: u(14), background: C.cyan, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: u(18), fontWeight: 800, color: C.white, letterSpacing: u(-0.4) }}>
        1000M
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: u(5) }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: u(10) }}>
          <span style={{ width: u(11), height: u(11), borderRadius: '50%', background: props.online ? C.green : C.red }} title={props.online ? 'Bridge and reader online' : 'Bridge or reader offline'} />
          <div style={{ fontSize: u(25), fontWeight: 700, letterSpacing: '0.01em' }}>RFID GATE 01</div>
        </div>
        <div style={{ fontSize: u(15), fontWeight: 600, letterSpacing: '0.14em', color: C.muted }}>WAREHOUSE A · DOCK 3</div>
      </div>
      <div style={{ flex: 1 }} />

      {props.scanning && (
        <div style={{ display: 'flex', alignItems: 'center', gap: u(12), padding: `${u(12)} ${u(22)}`, borderRadius: u(26), background: C.cyanBg, border: `1px solid ${C.cyanEdge}` }}>
          <div className="gate-dot" style={{ width: u(14), height: u(14), borderRadius: '50%', background: C.cyan }} />
          <div style={{ fontSize: u(17), fontWeight: 700, letterSpacing: '0.12em', color: C.cyanDk }}>READING</div>
        </div>
      )}

      {props.exceptionCount > 0 && (
        <div onClick={props.onExceptions} style={{ display: 'flex', alignItems: 'center', gap: u(12), padding: `${u(12)} ${u(24)}`, borderRadius: u(26), background: C.redBg, border: `1px solid ${C.redEdge}`, cursor: 'pointer' }}>
          <Icon.Warning size={24} color={C.red} />
          <div style={{ fontSize: u(26), fontWeight: 800, color: C.red, lineHeight: 1 }}>{props.exceptionCount}</div>
          <div style={{ fontSize: u(15), fontWeight: 700, letterSpacing: '0.1em', color: C.redDk }}>EXCEPTIONS</div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: u(4) }}>
        <div style={{ fontSize: u(34), fontWeight: 700, letterSpacing: u(-0.5), fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{clock}</div>
        <div style={{ fontSize: u(16), fontWeight: 600, letterSpacing: '0.08em', color: C.muted }}>{dateLabel}</div>
      </div>

      <div onClick={props.onControls} title="Engineering console" style={{ width: u(62), height: u(62), borderRadius: u(14), background: C.surface, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted, cursor: 'pointer' }}>
        <Icon.Gear size={28} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- overview */

function SummaryCard(props: { dir: Direction; docs: GateDoc[]; totals: { received: number; expected: number }; onOpen: (id: string) => void }) {
  const a = accent(props.dir);
  const p = pct(props.totals.received, props.totals.expected);
  const noun = props.dir === 'in' ? 'POs' : 'shipments';
  const late = props.docs.filter((d) => d.due < 0).length;
  const dueToday = props.docs.filter((d) => d.due === 0).length;
  const docLabel = [`${dueToday} ${noun} due today`, ...(late ? [`${late} overdue`] : [])].join(' · ');

  return (
    <div style={{ flex: 1, minHeight: 0, background: C.white, borderRadius: u(20), boxShadow: '0 0 0 1px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)', padding: `${u(26)} ${u(28)}`, display: 'flex', flexDirection: 'column', gap: u(20) }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: u(28) }}>
        <div style={{ position: 'relative', width: u(172), height: u(172), flex: `0 0 ${u(172)}` }}>
          <svg viewBox="0 0 172 172" style={{ width: '100%', height: '100%', transform: 'rotate(-90deg)', display: 'block' }}>
            <circle cx="86" cy="86" r="74" fill="none" stroke={C.track} strokeWidth="16" />
            <circle
              cx="86"
              cy="86"
              r="74"
              fill="none"
              stroke={a.fill}
              strokeWidth="16"
              strokeLinecap={p > 0 ? 'round' : 'butt'}
              strokeDasharray={`${(p / 100) * RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`}
              style={{ transition: 'stroke-dasharray .3s ease' }}
            />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: u(2) }}>
            <div style={{ fontSize: u(42), fontWeight: 800, letterSpacing: u(-1.5), color: a.text }}>{p}%</div>
            <div style={{ fontSize: u(14), fontWeight: 700, letterSpacing: '0.12em', color: C.faint }}>{props.dir === 'in' ? 'RECEIVED' : 'LOADED'}</div>
          </div>
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: u(10) }}>
          <div style={{ fontSize: u(15), fontWeight: 800, letterSpacing: '0.18em', color: a.text }}>
            {props.dir === 'in' ? 'INBOUND · RECEIVING' : 'OUTBOUND · SHIPPING'}
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: u(12) }}>
            <div style={{ fontSize: u(86), fontWeight: 800, lineHeight: 0.85, letterSpacing: u(-3), fontVariantNumeric: 'tabular-nums' }}>{props.totals.received}</div>
            <div style={{ fontSize: u(38), fontWeight: 700, color: C.faint, fontVariantNumeric: 'tabular-nums' }}>/ {props.totals.expected}</div>
            <div style={{ fontSize: u(16), fontWeight: 700, letterSpacing: '0.14em', color: C.faint, paddingBottom: u(6) }}>CARTONS</div>
          </div>
          <div style={{ fontSize: u(19), fontWeight: 600, color: C.muted }}>{docLabel}</div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: u(12) }}>
        {props.docs.length === 0 ? (
          <div style={{ fontSize: u(19), fontWeight: 600, color: C.faint, padding: `${u(20)} 0` }}>
            Nothing {props.dir === 'in' ? 'inbound' : 'outbound'} on today’s board.
          </div>
        ) : (
          props.docs.map((doc) => <DocRow key={doc.id} doc={doc} dir={props.dir} onOpen={() => props.onOpen(doc.id)} />)
        )}
      </div>
    </div>
  );
}

function DocRow(props: { doc: GateDoc; dir: Direction; onOpen: () => void }) {
  const a = accent(props.dir);
  const t = docTotals(props.doc);
  const p = pct(t.received, t.expected);
  const done = t.received >= t.expected && t.expected > 0;
  const started = t.received > 0;
  const due = dueChip(props.doc.due);

  const bar = done ? C.green : started ? a.fill : C.off;
  const color = done ? C.green : started ? a.text : C.faint;
  const status = done ? 'COMPLETE' : started ? 'IN PROGRESS' : 'WAITING';
  const chipBg = done ? C.greenBg : started ? a.soft : C.surface;
  const chipFg = done ? C.greenDk : started ? a.text : C.faint;

  return (
    <div onClick={props.onOpen} style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: u(18), padding: `${u(14)} ${u(20)}`, borderRadius: u(14), background: C.white, border: `1px solid ${C.border}`, cursor: 'pointer' }}>
      <div style={{ flex: `0 0 ${u(46)}`, width: u(46), height: u(46), borderRadius: u(12), background: a.soft, color: a.text, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {props.dir === 'in' ? <Icon.Box size={23} /> : <Icon.Truck size={23} />}
      </div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: u(6), minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: u(12) }}>
          <div style={{ fontSize: u(24), fontWeight: 700, letterSpacing: '0.01em' }}>{props.doc.id}</div>
          <div style={{ padding: `${u(4)} ${u(12)}`, borderRadius: u(26), fontSize: u(14), fontWeight: 800, letterSpacing: '0.08em', background: chipBg, color: chipFg }}>{status}</div>
          <div style={{ padding: `${u(4)} ${u(12)}`, borderRadius: u(26), fontSize: u(14), fontWeight: 800, letterSpacing: '0.08em', background: due.bg, color: due.fg, border: `1px solid ${due.edge}` }}>{due.label}</div>
        </div>
        <div style={{ fontSize: u(15), fontWeight: 500, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {props.doc.party} · {props.doc.meta}
        </div>
        <div style={{ height: u(10), borderRadius: u(8), background: C.track, overflow: 'hidden', marginTop: u(2) }}>
          <div style={{ height: '100%', borderRadius: u(8), width: `${p}%`, background: bar, transition: 'width .3s ease' }} />
        </div>
      </div>
      <div style={{ fontSize: u(38), fontWeight: 800, letterSpacing: u(-1), fontVariantNumeric: 'tabular-nums', color, minWidth: u(170), textAlign: 'right' }}>
        {t.received} / {t.expected}
      </div>
    </div>
  );
}

/* -------------------------------------------------------- one document */

function DocumentView(props: { dir: Direction; doc: GateDoc; onBack: () => void; onAll: () => void }) {
  const a = accent(props.dir);
  const { doc } = props;
  const t = docTotals(doc);
  const done = t.received >= t.expected && t.expected > 0;
  const due = dueChip(doc.due);
  const complete = doc.lines.filter((l) => l.received >= l.expected).length;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: C.white }}>
      <div style={{ flex: '0 0 auto', padding: `${u(26)} ${u(32)} ${u(22)} ${u(32)}`, background: C.white, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: u(20) }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: u(10) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: u(14) }}>
              <div onClick={props.onBack} style={{ display: 'flex', alignItems: 'center', gap: u(10), height: u(60), padding: `0 ${u(24)}`, borderRadius: u(26), background: C.surface, border: `1px solid ${C.border}`, fontSize: u(19), fontWeight: 700, color: C.muted, cursor: 'pointer' }}>
                ‹ Overview
              </div>
              <div onClick={props.onAll} style={{ padding: `${u(8)} ${u(18)}`, borderRadius: u(26), fontSize: u(15), fontWeight: 800, letterSpacing: '0.16em', background: a.soft, color: a.text, cursor: 'pointer' }}>
                {props.dir === 'in' ? 'ALL RECEIVING' : 'ALL SHIPPING'}
              </div>
              <div style={{ padding: `${u(8)} ${u(18)}`, borderRadius: u(26), fontSize: u(15), fontWeight: 800, letterSpacing: '0.12em', background: due.bg, color: due.fg, border: `1px solid ${due.edge}` }}>{due.label}</div>
              <div style={{ fontSize: u(16), fontWeight: 600, letterSpacing: '0.08em', color: C.muted }}>{doc.meta}</div>
            </div>
            <div style={{ fontSize: u(66), fontWeight: 800, lineHeight: 0.95, letterSpacing: u(-2) }}>{doc.id}</div>
            <div style={{ fontSize: u(24), fontWeight: 600, color: C.muted }}>{doc.party}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: u(10), paddingTop: u(8) }}>
            <div style={{ fontSize: u(132), fontWeight: 800, lineHeight: 0.8, letterSpacing: u(-6), fontVariantNumeric: 'tabular-nums', color: done ? C.green : a.text }}>{t.received}</div>
            <div style={{ fontSize: u(52), fontWeight: 700, color: C.faint, fontVariantNumeric: 'tabular-nums' }}>/ {t.expected}</div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: u(6), marginTop: u(20), alignItems: 'center' }}>
          {doc.lines.map((l) => (
            <div key={l.sku} style={{ height: u(20), borderRadius: u(12), background: C.track, overflow: 'hidden', flex: l.expected }}>
              <div style={{ height: '100%', borderRadius: u(12), width: `${pct(l.received, l.expected)}%`, background: l.received >= l.expected ? C.green : a.fill, transition: 'width .3s ease' }} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: u(10), marginTop: u(12), fontSize: u(16), fontWeight: 600, color: C.faint }}>
          <div style={{ width: u(12), height: u(12), borderRadius: u(4), background: done ? C.green : a.fill }} />
          <div>
            {complete} of {doc.lines.length} SKUs complete
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `${u(24)} ${u(32)} ${u(32)} ${u(32)}` }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: u(20) }}>
          {doc.lines.map((line) => (
            <Tile key={line.sku} line={line} dir={props.dir} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- overlays */

function DupToast(props: { message: string }) {
  return (
    <div className="gate-toast" style={{ position: 'absolute', left: u(32), right: u(32), bottom: u(28), zIndex: 40, padding: `${u(22)} ${u(28)}`, borderRadius: u(16), background: C.amberBg, border: `2px solid ${C.amberEdge}`, display: 'flex', alignItems: 'center', gap: u(20), boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
      <div style={{ fontSize: u(15), fontWeight: 800, letterSpacing: '0.16em', color: C.amberDk }}>ALREADY COUNTED</div>
      <div style={{ fontSize: u(20), fontWeight: 600, color: '#7c4a08' }}>{props.message}</div>
    </div>
  );
}

function UnknownFlash(props: { tag: string }) {
  return (
    <>
      <div className="gate-flash" style={{ position: 'absolute', inset: 0, zIndex: 45, pointerEvents: 'none', boxShadow: `inset 0 0 0 ${u(16)} ${C.red}, inset 0 0 ${u(200)} rgba(223,34,37,0.28)` }} />
      <div style={{ position: 'absolute', left: u(32), right: u(32), top: u(28), zIndex: 46, pointerEvents: 'none', padding: `${u(24)} ${u(30)}`, borderRadius: u(16), background: C.red, color: C.white, display: 'flex', alignItems: 'center', gap: u(22), boxShadow: '0 8px 24px rgba(0,0,0,0.18)' }}>
        <div style={{ fontSize: u(17), fontWeight: 800, letterSpacing: '0.16em' }}>UNKNOWN TAG</div>
        <div style={{ fontSize: u(22), fontWeight: 600, fontFamily: "'Courier New', monospace", letterSpacing: '0.04em' }}>{props.tag}</div>
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: u(17), fontWeight: 700, letterSpacing: '0.1em', opacity: 0.8 }}>NOT ON TODAY’S BOARD</div>
      </div>
    </>
  );
}

function OverlayHeader(props: { eyebrow: string; eyebrowColor: string; title: string; onOverview: () => void; onClose: () => void }) {
  return (
    <div style={{ flex: `0 0 ${u(132)}`, display: 'flex', alignItems: 'center', gap: u(24), padding: `0 ${u(32)}`, borderBottom: `1px solid ${C.border}`, background: C.white }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: u(8) }}>
        <div style={{ fontSize: u(15), fontWeight: 800, letterSpacing: '0.18em', color: props.eyebrowColor }}>{props.eyebrow}</div>
        <div style={{ fontSize: u(38), fontWeight: 700, letterSpacing: u(-0.5) }}>{props.title}</div>
      </div>
      <div onClick={props.onOverview} style={{ height: u(84), padding: `0 ${u(30)}`, borderRadius: u(18), background: C.surface, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', fontSize: u(22), fontWeight: 700, color: C.muted, cursor: 'pointer' }}>
        ‹ Overview
      </div>
      <div onClick={props.onClose} style={{ width: u(84), height: u(84), borderRadius: u(18), background: C.surface, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: u(44), fontWeight: 300, color: C.muted, cursor: 'pointer' }}>
        ×
      </div>
    </div>
  );
}

function AddScreen(props: {
  pool: GateDoc[];
  filter: string;
  onFilter: (f: string) => void;
  onPick: (doc: GateDoc) => void;
  onClose: () => void;
  onOverview: () => void;
}) {
  const suppliers = ['All', ...new Set(props.pool.map((p) => p.party))];
  const rows = props.pool.filter((p) => props.filter === 'All' || p.party === props.filter);

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 70, background: C.white, display: 'flex', flexDirection: 'column' }}>
      <OverlayHeader eyebrow="MANUAL ADD · INBOUND" eyebrowColor={C.cyanDk} title="Add an Open PO to Today’s Board" onOverview={props.onOverview} onClose={props.onClose} />
      <div style={{ flex: '0 0 auto', display: 'flex', gap: u(14), padding: `${u(22)} ${u(32)}`, overflowX: 'auto' }}>
        {suppliers.map((name) => {
          const on = name === props.filter;
          return (
            <div key={name} onClick={() => props.onFilter(name)} style={{ flex: '0 0 auto', padding: `${u(18)} ${u(28)}`, borderRadius: u(26), fontSize: u(20), fontWeight: 700, whiteSpace: 'nowrap', background: on ? C.cyan : C.white, color: on ? C.white : C.muted, border: `2px solid ${on ? C.cyan : C.border}`, cursor: 'pointer' }}>
              {name}
            </div>
          );
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `${u(8)} ${u(32)} ${u(32)} ${u(32)}`, display: 'flex', flexDirection: 'column', gap: u(16) }}>
        {rows.length === 0 ? (
          <div style={{ fontSize: u(22), fontWeight: 600, color: C.faint, padding: u(20) }}>No open POs left in the pool.</div>
        ) : (
          rows.map((p) => (
            <div key={p.id} onClick={() => props.onPick(p)} style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: u(24), padding: `${u(26)} ${u(28)}`, borderRadius: u(16), background: C.white, boxShadow: '0 0 0 1px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.04)', cursor: 'pointer' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: u(6), minWidth: 0 }}>
                <div style={{ fontSize: u(34), fontWeight: 700, letterSpacing: u(-0.5) }}>{p.id}</div>
                <div style={{ fontSize: u(20), fontWeight: 600, color: C.muted }}>{p.party}</div>
                <div style={{ fontSize: u(17), fontWeight: 500, color: C.faint }}>{p.meta}</div>
              </div>
              <div style={{ fontSize: u(19), fontWeight: 800, letterSpacing: '0.1em', color: C.cyanDk }}>SELECT ›</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ConfirmModal(props: { doc: GateDoc; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 80, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: u(80) }}>
      <div style={{ width: '100%', background: C.white, borderRadius: u(20), padding: u(44), display: 'flex', flexDirection: 'column', gap: u(24), boxShadow: '0 12px 32px rgba(0,0,0,0.2)' }}>
        <div style={{ fontSize: u(15), fontWeight: 800, letterSpacing: '0.18em', color: C.cyanDk }}>CONFIRM</div>
        <div style={{ fontSize: u(44), fontWeight: 700, letterSpacing: u(-1) }}>{props.doc.id}</div>
        <div style={{ fontSize: u(23), fontWeight: 500, color: C.muted, lineHeight: 1.45 }}>
          {props.doc.party} — {props.doc.meta}. It joins today’s board at 0 received and starts counting on the next gate read.
        </div>
        <div style={{ display: 'flex', gap: u(16), marginTop: u(12) }}>
          <div onClick={props.onCancel} style={{ flex: 1, height: u(104), borderRadius: u(16), background: C.surface, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: u(26), fontWeight: 700, color: C.muted, cursor: 'pointer' }}>
            Cancel
          </div>
          <div onClick={props.onConfirm} style={{ flex: 2, height: u(104), borderRadius: u(16), background: C.cyan, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: u(28), fontWeight: 800, color: C.white, cursor: 'pointer' }}>
            Add to Today ›
          </div>
        </div>
        <div style={{ fontSize: u(16), fontWeight: 600, color: C.faint }}>Prototype: no supervisor PIN — open question for production.</div>
      </div>
    </div>
  );
}

function ExceptionsScreen(props: { rows: { id: number; tag: string; note: string; at: string }[]; onClear: () => void; onClose: () => void; onOverview: () => void }) {
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 75, background: C.white, display: 'flex', flexDirection: 'column' }}>
      <OverlayHeader eyebrow="EXCEPTIONS" eyebrowColor={C.redDk} title={`${props.rows.length} unmatched tags today`} onOverview={props.onOverview} onClose={props.onClose} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `${u(24)} ${u(32)}`, display: 'flex', flexDirection: 'column', gap: u(14) }}>
        {props.rows.map((e) => (
          <div key={e.id} style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: u(24), padding: `${u(26)} ${u(28)}`, borderRadius: u(16), background: C.redBg, border: `1px solid ${C.redEdge}` }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: u(8), minWidth: 0 }}>
              <div style={{ fontSize: u(26), fontWeight: 700, fontFamily: "'Courier New', monospace", letterSpacing: '0.04em', color: C.redDk, wordBreak: 'break-all' }}>{e.tag}</div>
              <div style={{ fontSize: u(18), fontWeight: 600, color: C.muted }}>{e.note}</div>
            </div>
            <div style={{ fontSize: u(24), fontWeight: 700, color: C.faint, fontVariantNumeric: 'tabular-nums' }}>{e.at}</div>
          </div>
        ))}
      </div>
      <div style={{ flex: '0 0 auto', padding: `${u(24)} ${u(32)} ${u(32)} ${u(32)}` }}>
        <div onClick={props.onClear} style={{ height: u(104), borderRadius: u(16), background: C.white, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: u(26), fontWeight: 700, color: C.muted, cursor: 'pointer' }}>
          Clear List
        </div>
      </div>
    </div>
  );
}
