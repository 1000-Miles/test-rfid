import { docTitle, docTotals, pct, sumTotals, type Direction, type DocLine, type GateDoc } from './documents';
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
  focus: string | null;
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
      {/* Landscape keeps this band as low as it can — the grid below only fits
          two rows of tiles in 1080 of height — so the title and the count sit
          on one line and the document bar shares its row with the tally. */}
      <div style={{ flex: '0 0 auto', padding: `${u(18)} ${u(28)} ${u(14)} ${u(28)}`, background: C.white, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: u(20) }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: u(8) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: u(14) }}>
              <div onClick={props.onBack} style={{ display: 'flex', alignItems: 'center', gap: u(10), height: u(50), padding: `0 ${u(22)}`, borderRadius: u(26), background: C.surface, border: `1px solid ${C.border}`, fontSize: u(18), fontWeight: 700, color: C.muted, cursor: 'pointer' }}>
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
            <div style={{ display: 'flex', alignItems: 'baseline', gap: u(20), minWidth: 0 }}>
              <div style={{ fontSize: u(52), fontWeight: 800, lineHeight: 1, letterSpacing: u(-1.5), whiteSpace: 'nowrap' }}>
                Today’s {dir === 'in' ? 'Inbound' : 'Outbound'}
              </div>
              <div style={{ fontSize: u(22), fontWeight: 600, color: C.muted, whiteSpace: 'nowrap' }}>
                {docs.length} {noun} · {items.length} SKU lines
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: u(10), flex: '0 0 auto' }}>
            <div style={{ fontSize: u(104), fontWeight: 800, lineHeight: 0.8, letterSpacing: u(-5), fontVariantNumeric: 'tabular-nums', color: allDone ? C.green : a.text }}>{totals.received}</div>
            <div style={{ fontSize: u(44), fontWeight: 700, color: C.faint, fontVariantNumeric: 'tabular-nums' }}>/ {totals.expected}</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: u(16), marginTop: u(14) }}>
          {/* one segment per document, weighted by how much it expects */}
          <div style={{ flex: 1, display: 'flex', gap: u(6), alignItems: 'center' }}>
            {docs.map((doc) => {
              const t = docTotals(doc);
              return (
                <div key={doc.id} title={docTitle(doc)} style={{ height: u(18), borderRadius: u(12), background: C.track, overflow: 'hidden', flex: t.expected }}>
                  <div style={{ height: '100%', borderRadius: u(12), width: `${pct(t.received, t.expected)}%`, background: t.received >= t.expected ? C.green : a.fill, transition: 'width .3s ease' }} />
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: u(10), fontSize: u(16), fontWeight: 600, color: C.faint, flex: '0 0 auto' }}>
            <div style={{ width: u(12), height: u(12), borderRadius: u(4), background: allDone ? C.green : a.fill }} />
            <div style={{ whiteSpace: 'nowrap' }}>
              {complete} of {docs.length} {noun} complete
            </div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `${u(20)} ${u(28)} ${u(24)} ${u(28)}` }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${u(212)}, 1fr))`, gap: u(14) }}>
          {items.map(({ line, doc }) => (
            <Tile key={`${doc.id}-${line.sku}`} line={line} dir={dir} focused={props.focus === `${doc.id}-${line.sku}`} doc={{ label: docTitle(doc), due: doc.due }} onClick={() => props.onOpenDoc(doc.id)} />
          ))}
        </div>
      </div>
    </div>
  );
}
