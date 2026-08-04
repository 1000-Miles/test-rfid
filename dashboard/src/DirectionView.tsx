import { docTotals, pct, sumTotals, type Direction, type DocLine, type GateDoc } from './documents';
import { accent, C, Tile, u } from './boardKit';

/**
 * The RECEIVING / SHIPPING tab: every open item from every document on
 * today's board in one grid, each tile carrying the PO or shipment it belongs
 * to. The header totals the whole direction rather than a single document —
 * drilling into one document is DocumentView's job.
 */
export default function DirectionView(props: {
  dir: Direction;
  docs: GateDoc[];
  onBack: () => void;
  onOpenDoc: (id: string) => void;
}) {
  const { dir, docs } = props;
  const a = accent(dir);
  const totals = sumTotals(docs);
  const overdue = docs.filter((d) => d.due < 0).length;
  const complete = docs.filter((d) => {
    const t = docTotals(d);
    return t.expected > 0 && t.received >= t.expected;
  }).length;
  const allDone = totals.expected > 0 && totals.received >= totals.expected;

  const noun = dir === 'in' ? 'POs' : 'shipments';
  const items: { line: DocLine; doc: GateDoc }[] = docs.flatMap((doc) => doc.lines.map((line) => ({ line, doc })));

  if (docs.length === 0) {
    return (
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: u(18), background: C.white }}>
        <div style={{ fontSize: u(34), fontWeight: 700, color: C.faint }}>Nothing {dir === 'in' ? 'inbound' : 'outbound'} on today’s board</div>
        <div onClick={props.onBack} style={{ padding: `${u(18)} ${u(30)}`, borderRadius: u(26), background: C.surface, border: `1px solid ${C.border}`, fontSize: u(20), fontWeight: 700, color: C.muted, cursor: 'pointer' }}>
          ‹ Overview
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: C.white }}>
      <div style={{ flex: '0 0 auto', padding: `${u(26)} ${u(32)} ${u(22)} ${u(32)}`, background: C.white, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: u(20) }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: u(10) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: u(14) }}>
              <div onClick={props.onBack} style={{ display: 'flex', alignItems: 'center', gap: u(10), height: u(60), padding: `0 ${u(24)}`, borderRadius: u(26), background: C.surface, border: `1px solid ${C.border}`, fontSize: u(19), fontWeight: 700, color: C.muted, cursor: 'pointer' }}>
                ‹ Overview
              </div>
              <div style={{ padding: `${u(8)} ${u(18)}`, borderRadius: u(26), fontSize: u(15), fontWeight: 800, letterSpacing: '0.16em', background: a.soft, color: a.text }}>
                {dir === 'in' ? 'IN · RECEIVING' : 'OUT · SHIPPING'}
              </div>
              {overdue > 0 && (
                <div style={{ padding: `${u(8)} ${u(18)}`, borderRadius: u(26), fontSize: u(15), fontWeight: 800, letterSpacing: '0.12em', background: C.redBg, color: C.redDk, border: `1px solid ${C.redEdge}` }}>
                  {overdue} OVERDUE
                </div>
              )}
            </div>
            <div style={{ fontSize: u(58), fontWeight: 800, lineHeight: 0.95, letterSpacing: u(-1.5) }}>
              Today’s {dir === 'in' ? 'Inbound' : 'Outbound'}
            </div>
            <div style={{ fontSize: u(24), fontWeight: 600, color: C.muted }}>
              {docs.length} {noun} · {items.length} SKU lines
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: u(10), paddingTop: u(8) }}>
            <div style={{ fontSize: u(132), fontWeight: 800, lineHeight: 0.8, letterSpacing: u(-6), fontVariantNumeric: 'tabular-nums', color: allDone ? C.green : a.text }}>{totals.received}</div>
            <div style={{ fontSize: u(52), fontWeight: 700, color: C.faint, fontVariantNumeric: 'tabular-nums' }}>/ {totals.expected}</div>
          </div>
        </div>

        {/* one segment per document, weighted by how much it expects */}
        <div style={{ display: 'flex', gap: u(6), marginTop: u(20), alignItems: 'center' }}>
          {docs.map((doc) => {
            const t = docTotals(doc);
            return (
              <div key={doc.id} title={doc.id} style={{ height: u(20), borderRadius: u(12), background: C.track, overflow: 'hidden', flex: t.expected }}>
                <div style={{ height: '100%', borderRadius: u(12), width: `${pct(t.received, t.expected)}%`, background: t.received >= t.expected ? C.green : a.fill, transition: 'width .3s ease' }} />
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: u(10), marginTop: u(12), fontSize: u(16), fontWeight: 600, color: C.faint }}>
          <div style={{ width: u(12), height: u(12), borderRadius: u(4), background: allDone ? C.green : a.fill }} />
          <div>
            {complete} of {docs.length} {noun} complete
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `${u(24)} ${u(32)} ${u(32)} ${u(32)}` }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: u(20) }}>
          {items.map(({ line, doc }) => (
            <Tile key={`${doc.id}-${line.sku}`} line={line} dir={dir} doc={{ id: doc.id, due: doc.due }} onClick={() => props.onOpenDoc(doc.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}
