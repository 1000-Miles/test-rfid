import { useEffect, useMemo, useState } from 'react';
import { BRIDGE_HTTP } from './api';
import type { BridgeState } from './useBridge';
import type { EntryMsg, EntryRow, MovementFault, NexusItem } from './types';

/**
 * How many past movements the board keeps. Five are rendered in RECENT; the
 * extra headroom means a burst of live passages cannot push the history out
 * before it has been merged.
 */
const HISTORY_LIMIT = 10;

/**
 * What the board stamps instead of CHECKED IN / CHECKED OUT when the bridge
 * flagged the passage. Short enough to read across a warehouse floor — the
 * detail lives in the gate board's exceptions list, not here.
 */
const FAULT_STAMP: Record<MovementFault, string> = {
  'no-open-batch': 'NO OPEN BATCH',
  'not-received': 'NEVER RECEIVED',
  'already-shipped': 'ALREADY SHIPPED',
};

interface InvRecord {
  epc: string;
  item: NexusItem;
  known: boolean;
  status: string;
  lastSeen: string;
  entries: number;
}

/**
 * Warehouse TV wallboard — glanceable from across the floor.
 * Open with #tv. Industrial depot-signage look: hazard amber on near-black.
 */
export default function TvBoard(props: { bridge: BridgeState; onExit: () => void }) {
  const { bridge } = props;
  const { status } = bridge;
  // Unrecognised tags are ignored OUTRIGHT. At a doorway they are traffic, not
  // stock — pallet wrap, returnable crates, a badge in someone's pocket — and a
  // wallboard that stamps UNKNOWN ITEM at each of them is one people stop
  // reading. They still reach the engineering console's raw feed; they just do
  // not get the screen the floor watches.
  // Inventory and the gate's last decision, on one fixed 5s beat. Both come from
  // the bridge rather than from this page's own state, so both survive a TV
  // reload.
  //
  // The poll is mount-only ON PURPOSE. It used to depend on
  // `bridge.entries.length`, which tore the interval down and rebuilt it on
  // every single movement, and then stopped re-running at all once entries hit
  // their 100-item cap — a dependency that never changed what the poll did and
  // only made the refresh look as though it hung off traffic.
  const [inventory, setInventory] = useState<InvRecord[]>([]);
  const [pastMovements, setPastMovements] = useState<EntryRow[]>([]);
  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const [inv, ev] = await Promise.all([
          fetch(`${BRIDGE_HTTP}/nexus/inventory`).then((r) => r.json()),
          // The BRIDGE's movement history, not this page's.
          //
          // This is why the wallboard used to sit blank. The hero card and the
          // RECENT list were built from `bridge.entries`, which is filled ONLY
          // by live WebSocket messages and therefore starts empty on every page
          // load — so a TV opened (or reloaded, or woken from sleep) after the
          // last passage showed AWAITING SCAN and "no activity yet" while the
          // bridge held a full history. Nothing was broken; the screen simply
          // had no memory of anything it had not personally witnessed.
          fetch(`${BRIDGE_HTTP}/nexus/events?limit=${HISTORY_LIMIT}`).then((r) => r.json()),
        ]);
        if (stop) return;
        if (inv.inventory) setInventory(inv.inventory);
        if (Array.isArray(ev.events)) {
          setPastMovements(
            ev.events.map((e: EntryMsg, i: number): EntryRow => ({
              ...e,
              // Negative ids cannot collide with the live counter in useBridge.
              id: -1 - i,
              kind: e.type,
            }))
          );
        }
      } catch {
        /* bridge unreachable — the BRIDGE lamp already says so; keep the last figures */
      }
    };
    void pull();
    const t = setInterval(pull, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const now = useNow(1000);

  /**
   * What the board shows as movements: live WebSocket passages first, then the
   * bridge's own history for anything this page did not see itself.
   *
   * Live wins on overlap so a passage still appears the instant it happens
   * rather than on the next 5s poll; history fills the gap that made a
   * freshly-loaded wallboard look dead.
   *
   * Unrecognised tags are dropped OUTRIGHT from both sources. At a doorway they
   * are traffic, not stock — pallet wrap, returnable crates, a badge in
   * someone's pocket — and a wallboard that stamps UNKNOWN ITEM at each of them
   * is one people stop reading. They still reach the engineering console.
   */
  const movements = useMemo(() => {
    const seen = new Set<string>();
    const out: EntryRow[] = [];
    for (const e of [...bridge.entries, ...pastMovements]) {
      if (!e.known) continue;
      const key = `${e.epc}|${e.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    return out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, HISTORY_LIMIT);
  }, [bridge.entries, pastMovements]);
  const latest: EntryRow | undefined = movements[0];
  const lastMovementAt = latest?.timestamp ?? null;

  const insideRecords = useMemo(() => inventory.filter((r) => r.status === 'INSIDE'), [inventory]);
  const insideCount = insideRecords.length;
  const history = movements.slice(0, 5);

  return (
    <div className="tv-display tv-grain min-h-full flex flex-col bg-[#0c0b07] text-[#f5edd8] select-none overflow-hidden">
      {/* hazard top edge */}
      <div className="tv-hazard h-4 shrink-0" />

      {/* masthead */}
      <header className="flex items-end justify-between px-10 pt-6 pb-4 border-b-2 border-[#ffb000]/30">
        <div>
          <div className="text-[#ffb000] text-5xl leading-none tracking-wide">WAREHOUSE ENTRANCE</div>
          <div className="tv-mono text-sm text-[#f5edd8]/50 mt-1">WH-ENTRANCE-1 · RFID CHECK-IN</div>
        </div>
        <div className="flex items-center gap-8">
          <Activity readsPerSec={bridge.readsPerSec} lastMovementAt={lastMovementAt} now={now} />
          {bridge.passageComplete && (
            <div className={`tv-mono rounded-lg border px-4 py-2 text-sm ${bridge.passageComplete.systemMs <= 15000 ? 'border-[#3ddc84] text-[#3ddc84]' : 'border-[#ff4545] text-[#ff4545]'}`}>
              {bridge.passageComplete.assignment?.palletCode ?? `${bridge.passageComplete.processed} CARTONS`}
              {' · '}{bridge.passageComplete.assignment?.location ?? 'NEXUS'}
              {' · '}{(bridge.passageComplete.systemMs / 1000).toFixed(1)}s
            </div>
          )}
          <StatusLamp on={bridge.wsConnected} label="BRIDGE" />
          <StatusLamp on={status.connected} label="READER" />
          <BeamLamp broken={bridge.gpi.gpi1 === true} unknown={bridge.gpi.gpi1 === null} />
          <Clock />
        </div>
      </header>

      {/* main area */}
      <main className="flex-1 grid grid-cols-3 gap-8 px-10 py-8 min-h-0">
        {/* hero: latest check-in */}
        <section className="col-span-2 flex flex-col min-h-0">
          {latest ? (
            <div key={latest.id} className="tv-flash-bg flex-1 flex flex-col justify-center rounded-2xl border-2 border-[#ffb000]/40 px-12 relative overflow-hidden">
              <div
                className={`tv-stamp absolute top-8 right-10 border-4 rounded-lg px-6 py-2 text-4xl tracking-widest ${
                  latest.unexpected
                    ? 'border-[#ff4545] text-[#ff4545]'
                    : latest.kind === 'exit'
                      ? 'border-[#4aa8ff] text-[#4aa8ff]'
                      : 'border-[#3ddc84] text-[#3ddc84]'
                }`}
              >
                {/* A contested passage must never be stamped CHECKED IN. This
                    printed that on ANY inbound movement, so a carton on no open
                    receiving batch got the same green confirmation as a genuine
                    delivery — the one thing on screen the floor actually reads.
                    The wallboard keeps showing these when the gate board does
                    not: a forgotten batch has to be visible somewhere, and this
                    is the screen that reports what physically happened. */}
                {latest.unexpected ? FAULT_STAMP[latest.unexpected] : latest.kind === 'exit' ? 'CHECKED OUT' : 'CHECKED IN'}
              </div>
              <div className="tv-mono text-[#ffb000] text-2xl mb-2">{latest.item.sku}</div>
              <div className="text-7xl leading-[0.95] break-words max-w-full">
                {latest.item.name}
              </div>
              <div className="tv-mono text-xl text-[#f5edd8]/60 mt-6 flex gap-10">
                <span>PALLET {latest.item.pallet ?? '—'}</span>
                <span>{new Date(latest.timestamp).toLocaleTimeString(undefined, { hour12: false })}</span>
                <span className="text-[#f5edd8]/35">{latest.epc}</span>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-[#ffb000]/25">
              <div className="tv-beam-wait text-6xl text-[#ffb000] tracking-widest">AWAITING SCAN</div>
              <div className="tv-mono text-lg text-[#f5edd8]/40 mt-4">pass a tagged pallet through the beam</div>
            </div>
          )}

          {/* inside-now shelf */}
          <div className="mt-8">
            <div className="flex items-baseline gap-6 mb-3">
              <span className="text-3xl text-[#ffb000] tracking-wider">INSIDE NOW</span>
              <span className="tv-mono text-5xl text-[#3ddc84] leading-none tabular-nums">{insideCount}</span>
            </div>
            <div className="flex gap-4 overflow-x-auto pb-2">
              {insideRecords.length === 0 ? (
                <div className="tv-mono text-[#f5edd8]/30 text-lg py-6">warehouse empty</div>
              ) : (
                insideRecords.slice(0, 8).map((r) => (
                  <div
                    key={r.epc}
                    className={`shrink-0 w-56 rounded-xl border px-4 py-3 ${
                      r.known ? 'border-[#ffb000]/35 bg-[#ffb000]/5' : 'border-[#ff4545]/40 bg-[#ff4545]/5'
                    }`}
                  >
                    <div className="tv-mono text-sm text-[#ffb000]">{r.item.sku}</div>
                    <div className="text-2xl leading-tight truncate" title={r.item.name}>
                      {r.item.name}
                    </div>
                    <div className="tv-mono text-xs text-[#f5edd8]/45 mt-2 flex justify-between">
                      <span>{r.item.pallet ?? '—'}</span>
                      <span>×{r.entries}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </section>

        {/* recent history — last 5, list style */}
        <aside className="flex flex-col min-h-0">
          <div className="text-3xl text-[#ffb000] tracking-wider mb-4">RECENT</div>
          <div className="flex-1 flex flex-col gap-4">
            {history.length === 0 ? (
              <div className="tv-mono text-[#f5edd8]/30 text-lg">no activity yet</div>
            ) : (
              history.map((e, i) => (
                <div key={e.id} className="tv-slide-in flex items-center gap-4" style={{ animationDelay: `${i * 40}ms` }}>
                  <span
                    className={`h-4 w-4 rounded-full shrink-0 ${
                      e.unexpected
                        ? 'bg-[#ff4545] shadow-[0_0_12px] shadow-[#ff4545]/60'
                        : e.kind === 'exit'
                          ? 'bg-[#4aa8ff] shadow-[0_0_12px] shadow-[#4aa8ff]/60'
                          : 'bg-[#3ddc84] shadow-[0_0_12px] shadow-[#3ddc84]/60'
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-3xl leading-tight truncate">
                      <span className={e.kind === 'exit' ? 'text-[#4aa8ff]' : 'text-[#3ddc84]'}>
                        {e.kind === 'exit' ? '⟵ ' : '⟶ '}
                      </span>
                      {e.item.name}
                    </div>
                    <div className="tv-mono text-sm text-[#f5edd8]/45">
                      {new Date(e.timestamp).toLocaleTimeString(undefined, { hour12: false })} · {e.item.sku}
                      {e.item.pallet ? ` · ${e.item.pallet}` : ''} ·{' '}
                      {e.unexpected ? <span className="text-[#ff4545]">{FAULT_STAMP[e.unexpected]}</span> : e.kind === 'exit' ? 'OUT' : 'IN'}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <button onClick={props.onExit} className="tv-mono text-xs text-[#f5edd8]/25 hover:text-[#f5edd8]/60 mt-4 self-start">
            ← exit TV mode
          </button>
        </aside>
      </main>

      <div className="tv-hazard h-4 shrink-0" />
    </div>
  );
}

/** A value that changes every `ms` — for anything that has to visibly age. */
function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "42s" / "21 MIN" / "3H 20M" — coarse on purpose; this is read across a room. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} MIN`;
  return `${Math.floor(m / 60)}H ${m % 60}M`;
}

/**
 * The chain that tells a QUIET gate from a DEAD one — which the two lamps alone
 * could not. BRIDGE says the socket is up and READER says the reader is open,
 * but neither says whether tags are being seen, nor whether the gate has
 * decided anything at all recently. Without that, a board showing nothing but a
 * ticking clock is indistinguishable from a hung page, and the honest answer
 * ("the reader is busy but nothing has moved for 20 minutes") was on screen
 * nowhere.
 */
function Activity(props: { readsPerSec: number; lastMovementAt: string | null; now: number }) {
  const reading = props.readsPerSec > 0;
  const ageMs = props.lastMovementAt ? props.now - Date.parse(props.lastMovementAt) : null;
  // Amber past a minute: the gate is alive but has decided nothing lately,
  // which on this gate usually means tags are sitting in the read zone.
  const stale = ageMs != null && ageMs > 60_000;
  return (
    <div className="text-right">
      <div className="tv-mono text-xs text-[#f5edd8]/40 tracking-wider">READS/S · LAST MOVE</div>
      <div className="tv-mono text-3xl leading-none tabular-nums flex items-center gap-3 justify-end mt-1">
        <span className={reading ? 'text-[#3ddc84]' : 'text-[#ff4545]'}>{props.readsPerSec}</span>
        <span className="text-[#f5edd8]/25">·</span>
        <span className={ageMs == null ? 'text-[#f5edd8]/35' : stale ? 'text-[#ffb000]' : 'text-[#3ddc84]'}>
          {ageMs == null ? '—' : ago(ageMs)}
        </span>
      </div>
    </div>
  );
}

function StatusLamp(props: { on: boolean; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <span
        className={`h-5 w-5 rounded-full ${
          props.on ? 'bg-[#3ddc84] shadow-[0_0_14px] shadow-[#3ddc84]/70' : 'bg-[#ff4545] shadow-[0_0_14px] shadow-[#ff4545]/70'
        }`}
      />
      <span className="tv-mono text-xs text-[#f5edd8]/50">{props.label}</span>
    </div>
  );
}

function BeamLamp(props: { broken: boolean; unknown: boolean }) {
  const color = props.unknown ? 'bg-[#5a5647]' : props.broken ? 'bg-[#ff4545] shadow-[0_0_14px] shadow-[#ff4545]/70' : 'bg-[#ffb000] shadow-[0_0_14px] shadow-[#ffb000]/60';
  return (
    <div className="flex flex-col items-center gap-1">
      <span className={`h-5 w-5 rounded-full ${color}`} />
      <span className="tv-mono text-xs text-[#f5edd8]/50">BEAM</span>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="text-right">
      <div className="tv-mono text-5xl leading-none tabular-nums text-[#f5edd8]">
        {now.toLocaleTimeString(undefined, { hour12: false })}
      </div>
      <div className="tv-mono text-xs text-[#f5edd8]/40 mt-1">
        {now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
      </div>
    </div>
  );
}
