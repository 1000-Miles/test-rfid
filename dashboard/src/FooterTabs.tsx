import { accent, C, Icon, u } from './boardKit';
import type { Direction } from './documents';

/**
 * The two direction tabs in the board footer. Same shape, so they share a
 * private base — but each is its own component, so the receiving and shipping
 * tabs can be reached, styled and changed independently.
 */

export interface TabTotals {
  received: number;
  expected: number;
}

export function ReceivingTab(props: { active: boolean; totals: TabTotals; onClick: () => void }) {
  return <FooterTab dir="in" label="RECEIVING" big="IN" icon={<Icon.ArrowIn size={38} />} {...props} />;
}

export function ShippingTab(props: { active: boolean; totals: TabTotals; onClick: () => void }) {
  return <FooterTab dir="out" label="SHIPPING" big="OUT" icon={<Icon.ArrowOut size={38} />} {...props} />;
}

export function AddButton(props: { onClick: () => void }) {
  return (
    <div
      onClick={props.onClick}
      title="Add an open PO to today’s board"
      style={{ flex: `0 0 ${u(128)}`, borderRadius: u(18), background: C.cyan, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.white, cursor: 'pointer' }}
    >
      <Icon.Plus size={52} />
    </div>
  );
}

function FooterTab(props: {
  dir: Direction;
  active: boolean;
  label: string;
  big: string;
  icon: React.ReactNode;
  totals: TabTotals;
  onClick: () => void;
}) {
  const a = accent(props.dir);
  const bg = props.active ? a.soft : C.white;
  const edge = props.active ? a.fill : C.border;
  const fg = props.active ? a.text : C.muted;
  const sub = props.active ? a.text : C.faint;

  return (
    <div onClick={props.onClick} style={{ flex: 1, borderRadius: u(18), display: 'flex', alignItems: 'center', gap: u(20), padding: `0 ${u(26)}`, background: bg, border: `2px solid ${edge}`, cursor: 'pointer' }}>
      <div style={{ flex: '0 0 auto', color: fg, display: 'flex', alignItems: 'center' }}>{props.icon}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: u(6) }}>
        <div style={{ fontSize: u(15), fontWeight: 800, letterSpacing: '0.18em', color: sub }}>{props.label}</div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: u(12) }}>
          <div style={{ fontSize: u(44), fontWeight: 800, letterSpacing: u(-1.5), color: fg }}>{props.big}</div>
          <div style={{ fontSize: u(27), fontWeight: 700, color: sub, fontVariantNumeric: 'tabular-nums' }}>
            {props.totals.received}/{props.totals.expected}
          </div>
        </div>
      </div>
    </div>
  );
}
