import { useEffect, useMemo, useState } from 'react';
import { BRIDGE_HTTP } from './api';
import type { BridgeState } from './useBridge';
import type { EntryRow, NexusItem } from './types';

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
export default function TvBoard(props: { bridge: BridgeState }) {
  const { bridge } = props;
  const { status } = bridge;
  const latest: EntryRow | undefined = bridge.entries[0];

  // Inventory: seed from the bridge, refresh periodically (survives TV reloads).
  const [inventory, setInventory] = useState<InvRecord[]>([]);
  useEffect(() => {
    let stop = false;
    const pull = () =>
      fetch(`${BRIDGE_HTTP}/nexus/inventory`)
        .then((r) => r.json())
        .then((d) => {
          if (!stop && d.inventory) setInventory(d.inventory);
        })
        .catch(() => {});
    pull();
    const t = setInterval(pull, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [bridge.entries.length]);

  const insideRecords = useMemo(() => inventory.filter((r) => r.status === 'INSIDE'), [inventory]);
  const insideCount = insideRecords.length;
  const history = bridge.entries.slice(0, 5);

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
                  !latest.known
                    ? 'border-[#ff4545] text-[#ff4545]'
                    : latest.kind === 'exit'
                      ? 'border-[#4aa8ff] text-[#4aa8ff]'
                      : 'border-[#3ddc84] text-[#3ddc84]'
                }`}
              >
                {!latest.known ? 'UNKNOWN ITEM' : latest.kind === 'exit' ? 'CHECKED OUT' : 'CHECKED IN'}
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
                      !e.known
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
                      {e.item.pallet ? ` · ${e.item.pallet}` : ''} · {e.kind === 'exit' ? 'OUT' : 'IN'}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <a href="#" className="tv-mono text-xs text-[#f5edd8]/25 hover:text-[#f5edd8]/60 mt-4">
            ← exit TV mode
          </a>
        </aside>
      </main>

      <div className="tv-hazard h-4 shrink-0" />
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
