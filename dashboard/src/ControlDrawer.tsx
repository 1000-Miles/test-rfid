import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { activeDocs, demoEpcsFor, type Direction, type GateBoardApi } from './documents';
import type { BridgeState } from './useBridge';
import type { EntryRow, GpiState, LastPrint, Mode, NexusConfig, PrinterConfig, TagRow, UdpFrameRow, UdpState } from './types';

/**
 * Engineering console — everything the gate board doesn't show.
 *
 * Reader connection, read mode, portal timing, printer, raw reads and UDP
 * frames used to be the whole dashboard; on the kiosk they live one tap away
 * behind the header gear so the board stays a board.
 *
 * Two tabs: "Console" is all of the above; "No-IR trial" drives the
 * toggle-mode experiment (antennas facing each other, direction inferred from
 * state instead of observed by the beams) without touching the IR setup.
 */
export default function ControlDrawer(props: {
  open: boolean;
  onClose: () => void;
  bridge: BridgeState;
  board: GateBoardApi;
  voiceOn: boolean;
  onToggleVoice: () => void;
  onOpenTv: () => void;
  onOpenPrinting: () => void;
}) {
  const { bridge, board } = props;
  const { status } = bridge;

  const [tab, setTab] = useState<'console' | 'noir'>('console');
  const [ip, setIp] = useState('192.168.254.202');
  const [port, setPort] = useState(8888);
  const [irDuration, setIrDuration] = useState(500);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    api
      .status()
      .then((s) => {
        if (s.defaults) {
          setIp(s.defaults.ip);
          setPort(s.defaults.port);
        }
        if (s.irDurationMs) setIrDuration(s.irDurationMs);
      })
      .catch(() => {});
  }, [props.open]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const setMode = (mode: Mode) => run(() => api.setMode({ mode, irDurationMs: irDuration }));
  const showUdp = status.mode === 'hw' || bridge.udpFrames.length > 0;

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={props.onClose} />
      <aside className="relative w-full max-w-3xl h-full overflow-y-auto bg-[#f4f7f8] bg-[radial-gradient(900px_420px_at_100%_-8%,rgba(0,188,212,.08),transparent_62%)] text-[#171717] border-l border-[#e5e5e5] shadow-2xl">
        <TriggerFlash lastTriggerAt={bridge.lastTriggerAt} />

        <header className="sticky top-0 z-10 flex items-center justify-between gap-4 px-5 py-4 bg-white/85 backdrop-blur-md border-b border-[#e5e5e5]/70">
          <div className="flex items-center gap-3">
            <span className="text-lg font-semibold tracking-tight">Engineering console</span>
            {status.reading && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-[#fffbeb] text-[#b45309] border border-[#fcd34d] animate-pulse">
                READING
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Pill ok={bridge.wsConnected} okText="Bridge" badText="Bridge" />
            <Pill ok={status.connected} okText="Reader" badText="Reader" />
            <button
              onClick={props.onOpenPrinting}
              title="Open pallet printing"
              className="text-sm rounded-lg px-3 py-1.5 border border-[#7fd9e4] bg-[#e0f7fa] text-[#008A9C] hover:bg-[#c9f0f5] font-medium"
            >
              Pallet printing
            </button>
            <button
              onClick={props.onOpenTv}
              title="Open TV wallboard mode"
              className="text-sm rounded-lg px-3 py-1.5 border border-[#fcd34d] bg-[#fffbeb] text-[#b45309] hover:bg-[#fef3c7] font-medium"
            >
              📺 TV
            </button>
            <button
              onClick={props.onToggleVoice}
              title={props.voiceOn ? 'Gate chime ON — click to mute' : 'Gate chime OFF — click to enable'}
              className={`text-lg rounded-lg px-2 py-1 border transition ${
                props.voiceOn ? 'bg-[#e0f7fa] border-[#7fd9e4]' : 'bg-[#f5f5f5] border-[#e5e5e5] opacity-60 hover:opacity-100'
              }`}
            >
              {props.voiceOn ? '🔊' : '🔇'}
            </button>
            <button onClick={props.onClose} className="rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all px-3 py-1.5 text-sm font-medium">
              Close ✕
            </button>
          </div>
        </header>

        <div className="px-5 py-5 flex flex-col gap-5">
          <div className="flex rounded-full bg-white border border-[#e3e8ea] p-1 shadow-[0_1px_2px_rgba(16,42,51,.05)]">
            <ModeButton active={tab === 'console'} onClick={() => setTab('console')} disabled={false}>
              Console
            </ModeButton>
            <ModeButton active={tab === 'noir'} onClick={() => setTab('noir')} disabled={false}>
              No-IR trial
            </ModeButton>
          </div>

          {tab === 'noir' ? (
            <NoIrPanel bridge={bridge} />
          ) : (
            <>
              <GateSimulator board={board} />

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ConnectPanel
                  ip={ip}
                  port={port}
                  connected={status.connected}
                  busy={busy}
                  onIp={setIp}
                  onPort={setPort}
                  onConnect={() => run(() => api.connect(ip, port))}
                  onDisconnect={() => run(() => api.disconnect())}
                  powerControl={<PowerControl connected={status.connected} minRssi={status.minRssi} weakDropped={status.weakDropped} />}
                />
                <ModePanel mode={status.mode} irDuration={irDuration} busy={busy} onIrDuration={setIrDuration} onSetMode={setMode} />
              </div>

              <PalletWindowCard />

              <GpiPanel gpi={bridge.gpi} mode={status.mode} />

              <ReadControls
                connected={status.connected}
                reading={status.reading}
                mode={status.mode}
                busy={busy}
                onStart={() => run(() => api.start())}
                onStop={() => run(() => api.stop())}
              />

              <Stats total={bridge.totalReads} unique={bridge.uniqueEpcs} rps={bridge.readsPerSec} />

              <PrintPanel rows={bridge.rows} readerConnected={status.connected} reading={status.reading} />

              <PalletTagPanel />

              <MovementsPanel entries={bridge.entries} />

              {showUdp && <UdpPanel udp={status.udp} frames={bridge.udpFrames} />}

              <TagTable rows={bridge.rows} onClear={bridge.clear} />
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

/**
 * How long a pallet stays open before it closes itself.
 *
 * On the CONSOLE tab, not the No-IR one, even though it only applies in no-IR
 * mode. That tab is still called a "trial" and this gate runs no-IR
 * permanently — so the setting that decides which cartons share a pallet, and
 * therefore share a printed label, sat behind a name that reads as optional.
 * Someone looking for it here is looking in the right place.
 *
 * Self-fetching rather than fed from the parent: it is one number, and threading
 * it through the console's state to be read once is more coupling than it earns.
 */
/** Host + port, controlled, applied on an explicit press. */
function AddressField(props: {
  label: string;
  value: string;
  port: number;
  placeholder?: string;
  onApply: (host: string, port: number) => void;
}) {
  const [host, setHost] = useState(props.value);
  const [port, setPort] = useState(String(props.port));
  // Follow the stored config, so the box never shows a value the bridge is not
  // actually using.
  useEffect(() => setHost(props.value), [props.value]);
  useEffect(() => setPort(String(props.port)), [props.port]);
  const dirty = host.trim() !== props.value || Number(port) !== props.port;
  return (
    <div className="text-sm">
      <span className="text-[#737373]">{props.label}</span>
      <div className="mt-1 flex gap-2">
        <input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder={props.placeholder}
          className="flex-1 rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm placeholder:text-[#a3a3a3]"
        />
        <input
          value={port}
          onChange={(e) => setPort(e.target.value)}
          className="w-20 rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm"
        />
        <button
          onClick={() => props.onApply(host.trim(), Number(port) || 9100)}
          disabled={!dirty}
          className="rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-40 px-3 py-2 text-sm"
        >
          Set
        </button>
      </div>
    </div>
  );
}

/** A single URL, controlled, applied on an explicit press. */
function UrlField(props: { label: string; value: string; placeholder?: string; hint?: string; onApply: (v: string) => void }) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  return (
    <div className="text-sm">
      <span className="text-[#737373]">{props.label}</span>
      <div className="mt-1 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={props.placeholder}
          title={props.hint}
          className="flex-1 rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm placeholder:text-[#a3a3a3]"
        />
        <button
          onClick={() => props.onApply(text.trim())}
          disabled={text.trim() === props.value}
          className="rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-40 px-3 py-2 text-sm"
        >
          Set
        </button>
      </div>
    </div>
  );
}

function PalletWindowCard() {
  const [sec, setSec] = useState(60);
  const [applied, setApplied] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .nexusSummary()
      .then((s) => {
        const v = Math.round((s.palletWindowMs ?? 60000) / 1000);
        setApplied(v);
        setSec(v);
      })
      .catch(() => {});
  }, []);
  useEffect(() => void refresh(), [refresh]);

  const apply = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.setNexusConfig({ palletWindowMs: Math.max(10, sec) * 1000 });
      if (!r.ok) setNote('The bridge refused that value.');
      else setApplied(Math.round((r.palletWindowMs ?? sec * 1000) / 1000));
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'The bridge did not answer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Pallet grouping">
      <label className="text-sm block">
        <span className="text-[#737373]">
          Close an unconfirmed pallet after (seconds)
          {applied != null ? <span className="text-[#15803d]"> — now {applied}s</span> : ''}
        </span>
        <div className="flex gap-2 mt-1 items-center">
          <input
            type="number"
            min={10}
            max={900}
            step={10}
            value={sec}
            disabled={busy}
            onChange={(e) => setSec(Number(e.target.value))}
            className="w-24 rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-2 py-1.5 text-sm"
          />
          <button
            onClick={apply}
            disabled={busy || sec === applied}
            className="rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-50 px-3 py-1.5 text-sm"
          >
            Set
          </button>
        </div>
      </label>
      {note && <p className="text-xs text-[#b45309] mt-2">{note}</p>}
    </Card>
  );
}

/* -------------------------------------------------------- No-IR trial tab */

/** Human phrasing for the bridge's direction-inference reason codes. */
const BASIS_LABEL: Record<string, string> = {
  'local-flip': 'flip of last gate verdict',
  'state-never-received': 'Nexus: never received → IN',
  'state-in-building': 'Nexus: in building → OUT',
  'state-shipped-return': 'Nexus: already shipped → IN (return?)',
  // '-stale' = the gate was offline too long to refresh, so this came from its
  // last saved copy of Nexus's records — still a better guess than nothing.
  'state-never-received-stale': 'Nexus (old copy): never received → IN',
  'state-in-building-stale': 'Nexus (old copy): in building → OUT',
  'state-shipped-return-stale': 'Nexus (old copy): already shipped → IN (return?)',
  'default-first-seen': 'nothing known → first pass IN',
};

function NumField(props: { label: string; value: number; min: number; step: number; onChange: (v: number) => void; hint: string }) {
  return (
    <label className="text-xs block">
      <span className="text-[#737373]">{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        step={props.step}
        onChange={(e) => props.onChange(Number(e.target.value))}
        title={props.hint}
        className="mt-0.5 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-2 py-1.5 text-sm"
      />
    </label>
  );
}

/**
 * Drives the no-IR ("toggle") trial: the IR beams stay wired and the IR code
 * path stays intact — this only flips the DETECTOR between observed direction
 * (beams) and inferred direction (first pass = received, next pass = ship,
 * anchored to Nexus carton state).
 */
function NoIrPanel(props: { bridge: BridgeState }) {
  const { bridge } = props;
  const { status } = bridge;

  const [cfg, setCfg] = useState<NexusConfig | null>(null);
  const [absenceSec, setAbsenceSec] = useState(30);
  const [rearmSec, setRearmSec] = useState(60);
  const [minRssiText, setMinRssiText] = useState(''); // blank = floor off
  const [minReads, setMinReads] = useState(2);
  const [fastCount, setFastCount] = useState(false);
  const [palletWindowSec, setPalletWindowSec] = useState(60);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const refresh = () =>
    api
      .nexusSummary()
      .then((s) => {
        setCfg(s);
        setAbsenceSec(Math.round((s.absenceMs ?? 30000) / 1000));
        setRearmSec(Math.round((s.toggleDedupMs ?? 60000) / 1000));
        setMinRssiText(s.minRssi != null ? String(s.minRssi) : '');
        setMinReads(s.toggleMinReads ?? 2);
        setFastCount(s.toggleFastCount === true);
        setPalletWindowSec(Math.round((s.palletWindowMs ?? 60000) / 1000));
      })
      .catch(() => {});
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enabled = cfg?.detectMode === 'toggle';
  // Toggle mode needs the reader reading CONTINUOUSLY — no beams to trigger bursts.
  const misconfigured = enabled && (!status.connected || !status.reading || status.mode === 'hw');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    run(async () => {
      await api.setNexusConfig({ detectMode: 'toggle' });
      if (status.connected) {
        await api.setMode({ mode: 'manual' }).catch(() => {});
        await api.start().catch(() => {}); // 409 when already reading is fine
      }
    });

  const disable = () =>
    run(async () => {
      await api.setNexusConfig({ detectMode: 'ir' });
      // Back to the beam-triggered setup; fails harmlessly on a reader without GPIO.
      if (status.connected) await api.setMode({ mode: 'ir' }).catch(() => {});
    });

  const applyTuning = () =>
    run(async () => {
      const rssi = minRssiText.trim();
      await api.setNexusConfig({
        absenceMs: Math.max(0, absenceSec) * 1000,
        toggleDedupMs: Math.max(0, rearmSec) * 1000,
        palletWindowMs: Math.max(10, palletWindowSec) * 1000,
        minRssi: rssi === '' ? null : Number(rssi),
        toggleMinReads: Math.max(1, minReads),
        toggleFastCount: fastCount,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });

  const simulateUnknown = () => {
    const hex = () => Math.floor(Math.random() * 65536).toString(16).toUpperCase().padStart(4, '0');
    api.mockVisit({ epc: `E280${hex()}${hex()}${hex()}${hex()}${hex()}` }).catch(() => {});
  };

  const decisions = bridge.entries.filter((e) => e.method === 'toggle');

  return (
    <>
      <Card title="No-IR trial — direction inferred, not observed">
        <div className="flex items-center gap-3 mb-3">
          <span
            className={`text-xs px-2.5 py-1 rounded-full border font-semibold ${
              enabled
                ? 'bg-[#e0f7fa] text-[#008A9C] border-[#7fd9e4]'
                : 'bg-[#f5f5f5] text-[#737373] border-[#e5e5e5]'
            }`}
          >
            {enabled ? 'NO-IR MODE ACTIVE' : 'IR mode (beams) active'}
          </span>
          {enabled && !misconfigured && (
            <span className="text-xs text-[#15803d]">reader is reading continuously — visits will be detected</span>
          )}
        </div>

        {misconfigured && (
          <div className="mb-3 rounded-lg border border-[#fcd34d] bg-[#fffbeb] px-3 py-2 text-sm text-[#b45309]">
            ⚠ No-IR mode is on but the reader is {!status.connected ? 'not connected' : status.mode === 'hw' ? 'in HW trigger mode' : 'not reading'} — nothing
            will be detected. It must read continuously: connect it, then Enable again (it sets Manual mode + Start).
          </div>
        )}

        <div className="flex gap-2">
          {!enabled ? (
            <button onClick={enable} disabled={busy} className="flex-1 rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-50 px-4 py-3 font-semibold">
              Enable no-IR trial
            </button>
          ) : (
            <button onClick={disable} disabled={busy} className="flex-1 rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-50 px-4 py-3 font-semibold">
              Back to IR (beams)
            </button>
          )}
        </div>
        {error && <p className="text-sm text-[#b41c1e] mt-2 break-all">{error}</p>}

      </Card>

      <Card title="No-IR tuning">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
          <NumField
            label="Pallet window (s)"
            value={palletWindowSec}
            min={10}
            step={10}
            onChange={setPalletWindowSec}
            hint="Everything read inside this window lands on ONE pallet and one printed label. Pressing Close & print ends it early — this is the fallback for when nobody does. Shorter separates back-to-back pallets; too short splits a slow unload across two labels. Applies to the next pallet, not one already open."
          />
          <NumField
            label="Absence (s)"
            value={absenceSec}
            min={0}
            step={5}
            onChange={setAbsenceSec}
            hint="A new visit opens only after the tag was unseen this long — the no-IR substitute for 'beams cleared'. Keep above the 10-20s RF tail."
          />
          <NumField
            label="Re-arm (s)"
            value={rearmSec}
            min={0}
            step={10}
            onChange={setRearmSec}
            hint="Same tag can't fire again for this long after an event. Raise a lot for production; low values make lingering pallets flip in/out."
          />
          <label className="text-xs block">
            <span className="text-[#737373]">RSSI floor (dBm)</span>
            <input
              value={minRssiText}
              onChange={(e) => setMinRssiText(e.target.value)}
              placeholder="off"
              title="Reads weaker than this are ignored entirely — logically shrinks the read zone. Blank = off. Try -60 and tune."
              className="mt-0.5 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-2 py-1.5 text-sm placeholder:text-[#a3a3a3]"
            />
          </label>
          <NumField
            label="Min reads / visit"
            value={minReads}
            min={1}
            step={1}
            onChange={setMinReads}
            hint="Visits with fewer reads are dropped as noise — one multipath ghost read must not flip warehouse state."
          />
        </div>
        <label className="flex items-start gap-2.5 mt-3 rounded-lg border border-[#e5e5e5] bg-[#fafafa] px-3 py-2 cursor-pointer">
          <input type="checkbox" checked={fastCount} onChange={(e) => setFastCount(e.target.checked)} className="mt-0.5 accent-[#00BCD4]" />
          <span className="text-xs">
            <span className="text-[#171717]">Count on the deciding read</span>
          </span>
        </label>
        <div className="flex items-center gap-3 mt-2">
          <button onClick={applyTuning} disabled={busy} className="flex-1 rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-50 px-3 py-1.5 text-sm">
            Apply tuning
          </button>
          {saved && <span className="text-xs text-[#15803d]">saved ✓</span>}
        </div>
      </Card>

      <Card title="Simulate (no hardware)">
        <div className="grid grid-cols-2 gap-2">
          <SimButton onClick={() => api.mockVisit({}).catch(() => {})} tone="cyan">
            Visit — known tag
          </SimButton>
          <SimButton onClick={simulateUnknown} tone="rose">
            Visit — unknown tag
          </SimButton>
        </div>
      </Card>

      <section className="rounded-2xl border border-[#d5eef2] bg-white overflow-hidden shadow-[0_1px_2px_rgba(16,42,51,.04),0_10px_28px_-16px_rgba(0,138,156,.14)]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#e5e5e5] bg-[#e0f7fa]">
          <h2 className="text-sm font-medium text-[#008A9C]">
            No-IR decisions <span className="text-[#8a8a8a]">(direction + why it was inferred)</span>
          </h2>
          <div className="text-sm text-[#008A9C] font-semibold tabular-nums">{decisions.length}</div>
        </div>
        <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-[#737373]">
              <tr>
                <th className="text-left font-medium px-4 py-2 w-28">Time</th>
                <th className="text-left font-medium px-4 py-2 w-28">SKU</th>
                <th className="text-left font-medium px-4 py-2 w-56">EPC</th>
                <th className="text-left font-medium px-4 py-2 w-20">Dir</th>
                <th className="text-left font-medium px-4 py-2">Why</th>
                <th className="text-left font-medium px-4 py-2 w-36">Flag</th>
              </tr>
            </thead>
            <tbody>
              {decisions.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[#8a8a8a]">
                    No inferred movements yet — enable the trial and pass a tagged box through, or use Simulate above.
                  </td>
                </tr>
              ) : (
                decisions.map((e) => (
                  <tr key={e.id} className="border-t border-[#f0f0f0] hover:bg-[#f0fbfd]">
                    <td className="px-4 py-1.5 text-xs text-[#737373]">{new Date(e.timestamp).toLocaleTimeString(undefined, { hour12: false })}</td>
                    <td className={`px-4 py-1.5 text-xs ${e.known ? 'text-[#008A9C]' : 'text-[#b45309]'}`}>{e.item.sku}</td>
                    <td className="px-4 py-1.5 text-xs text-[#8a8a8a] break-all">{e.epc}</td>
                    <td className="px-4 py-1.5">
                      {e.direction === 'in' ? (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[#f0fdf4] text-[#15803d] border border-[#a7e3bd]">IN</span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-[#e0f2fe] text-[#0369a1] border border-[#7dd3fc]">OUT</span>
                      )}
                    </td>
                    <td className="px-4 py-1.5 text-xs text-[#404040]">{e.basis ? BASIS_LABEL[e.basis] ?? e.basis : '—'}</td>
                    <td className="px-4 py-1.5 text-xs">
                      {e.unexpected ? <span className="text-[#b41c1e]">⚠ {e.unexpected}</span> : <span className="text-[#a3a3a3]">—</span>}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Card title="What to watch during the trial (the known edge cases)">
        <ul className="text-sm text-[#404040] flex flex-col gap-2 list-disc pl-5">
          <li>
            <span className="text-[#0a0a0a] font-medium">Read-zone test first.</span> Park a tagged carton 1–3 m from the gate, off to the side, for 10
            minutes. If decisions appear for it, the field is too big — lower read power or set the RSSI floor before trusting anything else.
          </li>
          <li>
            <span className="text-[#0a0a0a] font-medium">Quick in-and-back-out is swallowed.</span> Within the re-arm window the second pass is deliberately
            ignored. If forklifts genuinely enter and leave within {'<'}1 minute, that pass is lost — decide whether that is acceptable before lowering re-arm.
          </li>
          <li>
            <span className="text-[#0a0a0a] font-medium">The 10–20 s read tail is normal.</span> Tags keep reading after a pallet passes; the absence window
            exists to absorb it. Never set absence below ~25 s.
          </li>
          <li>
            <span className="text-[#0a0a0a] font-medium">A wrong flip self-perpetuates.</span> One bad decision inverts the next one for that box. The "why"
            column is how you catch it; fix by correcting the carton in Nexus — a Nexus record newer than the gate's last sighting of that box wins within a
            few minutes. The gate's memory itself survives restarts (rebuilt from its journal).
          </li>
          <li>
            <span className="text-[#0a0a0a] font-medium">Boxes with reprinted labels flip per-label.</span> A box carrying several live EPCs can read IN under
            one label and OUT under another. Retire old labels before relying on this mode.
          </li>
          <li>
            <span className="text-[#0a0a0a] font-medium">OUT is judged, not trusted.</span> An inferred OUT for a carton Nexus says was never received (or
            already shipped) is flagged in the Flag column and not counted as a dispatch — same protection as IR mode.
          </li>
        </ul>
      </Card>
    </>
  );
}

/* ------------------------------------------------------- gate simulator */

const BURST_SPACING_MS = 450;

/** Fires real bridge passages so the board can be exercised without hardware. */
function GateSimulator(props: { board: GateBoardApi }) {
  const { board } = props;
  const [autoplay, setAutoplay] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const auto = useRef<ReturnType<typeof setInterval> | null>(null);
  const boardRef = useRef(board);
  boardRef.current = board;

  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      if (auto.current) clearInterval(auto.current);
    },
    []
  );

  /** One pallet's worth of reads against the most urgent open document. */
  const burst = (dir: Direction) => {
    const state = boardRef.current.board;
    const doc = activeDocs(state.docs, dir).find((d) => d.lines.some((l) => l.received < l.expected));
    if (!doc) return;

    const counted = new Set(state.counted);
    const remaining = doc.lines.map((l) => ({ sku: l.sku, left: l.expected - l.received }));
    const epcs: string[] = [];
    const n = 6 + Math.floor(Math.random() * 5);

    for (let i = 0; i < n; i++) {
      const line = remaining.find((l) => l.left > 0);
      if (!line) break;
      const epc = demoEpcsFor(line.sku).find((e) => !counted.has(e));
      if (!epc) {
        line.left = 0; // demo tag block exhausted for this SKU
        continue;
      }
      counted.add(epc);
      line.left -= 1;
      epcs.push(epc);
    }

    epcs.forEach((epc, i) => {
      timers.current.push(setTimeout(() => api.mockPassage({ epc, direction: dir }).catch(() => {}), i * BURST_SPACING_MS));
    });
  };

  const fireUnknown = () => {
    const hex = () => Math.floor(Math.random() * 65536).toString(16).toUpperCase().padStart(4, '0');
    // Outside the demo block (which is AA00-prefixed) so it lands in exceptions.
    api.mockPassage({ epc: `E280${hex()}${hex()}${hex()}${hex()}${hex()}`, direction: 'in' }).catch(() => {});
  };

  const fireDuplicate = () => {
    const counted = boardRef.current.board.counted;
    const last = counted[counted.length - 1];
    if (last) api.mockPassage({ epc: last, direction: 'in' }).catch(() => {});
  };

  const toggleAuto = () => {
    if (auto.current) {
      clearInterval(auto.current);
      auto.current = null;
      setAutoplay(false);
      return;
    }
    setAutoplay(true);
    // Receiving-only gate: there is no outbound document to burst against, so
    // an 'out' leg here would fire nothing and just make autoplay look stalled.
    const step = () => {
      if (Math.random() < 0.85) burst('in');
      else fireUnknown();
    };
    step();
    auto.current = setInterval(step, 9000);
  };

  const resetDay = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    boardRef.current.resetDay();
  };

  return (
    <Card title="Gate simulator — mock passages through the bridge">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <SimButton onClick={toggleAuto} tone={autoplay ? 'green' : 'slate'}>
          Autoplay day · {autoplay ? 'ON' : 'OFF'}
        </SimButton>
        <SimButton onClick={() => burst('in')} tone="cyan">
          Inbound pallet burst
        </SimButton>
        <SimButton onClick={fireUnknown} tone="rose">
          Unknown tag
        </SimButton>
        <SimButton onClick={fireDuplicate} tone="yellow">
          Duplicate scan
        </SimButton>
        <SimButton onClick={resetDay} tone="slate">
          Reset day
        </SimButton>
      </div>
    </Card>
  );
}

function SimButton(props: { onClick: () => void; tone: 'cyan' | 'amber' | 'rose' | 'yellow' | 'green' | 'slate'; children: React.ReactNode }) {
  const tones = {
    cyan: 'bg-[#e0f7fa] border-[#7fd9e4] text-[#008A9C] hover:bg-[#c9f0f5]',
    amber: 'bg-[#fff7ed] border-[#fdba74] text-[#c2410c] hover:bg-[#ffedd5]',
    rose: 'bg-[#fef2f2] border-[#f0a1a2] text-[#b41c1e] hover:bg-[#fee2e2]',
    yellow: 'bg-[#fefce8] border-[#fde047] text-[#a16207] hover:bg-[#fef9c3]',
    green: 'bg-[#f0fdf4] border-[#86d49f] text-[#15803d] hover:bg-[#dcfce7]',
    slate: 'bg-[#f5f5f5] border-[#e5e5e5] text-[#404040] hover:bg-[#e0f7fa]',
  };
  return (
    <button onClick={props.onClick} className={`rounded-lg border px-3 py-3 text-sm font-medium transition ${tones[props.tone]}`}>
      {props.children}
    </button>
  );
}

/* --------------------------------------------------------------- shared */

function Pill(props: { ok: boolean; okText: string; badText: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className={`h-2.5 w-2.5 rounded-full ${props.ok ? 'bg-[#22c55e] shadow-[0_0_8px] shadow-[#22c55e]/50' : 'bg-[#dc2626]'}`} />
      <span className={props.ok ? 'text-[#15803d]' : 'text-[#b41c1e]'}>{props.ok ? props.okText : props.badText}</span>
    </span>
  );
}

function Card(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[#eef1f2] bg-white p-5 shadow-[0_1px_2px_rgba(16,42,51,.04),0_10px_28px_-16px_rgba(0,138,156,.14)]">
      <h2 className="text-[11px] font-bold uppercase tracking-[0.16em] text-[#008A9C] mb-4">{props.title}</h2>
      {props.children}
    </section>
  );
}

function ModeButton(props: { active: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      className={`flex-1 rounded-full px-3 py-1.5 text-sm font-semibold transition-all ${
        props.active
          ? 'bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_8px_rgba(0,188,212,.30)]'
          : 'text-[#404040] hover:bg-[#f0fbfd]'
      } disabled:opacity-50`}
    >
      {props.children}
    </button>
  );
}

/* ----------------------------------------------------------- connection */

function ConnectPanel(props: {
  ip: string;
  port: number;
  connected: boolean;
  busy: boolean;
  onIp: (v: string) => void;
  onPort: (v: number) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  powerControl?: React.ReactNode;
}) {
  return (
    <Card title="Connection">
      <div className="flex flex-col gap-3">
        <label className="text-sm">
          <span className="text-[#737373]">Reader IP</span>
          <input
            value={props.ip}
            onChange={(e) => props.onIp(e.target.value)}
            disabled={props.connected}
            className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm disabled:opacity-50"
          />
        </label>
        <label className="text-sm">
          <span className="text-[#737373]">Port</span>
          <input
            type="number"
            value={props.port}
            onChange={(e) => props.onPort(Number(e.target.value))}
            disabled={props.connected}
            className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm disabled:opacity-50"
          />
        </label>
        {!props.connected ? (
          <button onClick={props.onConnect} disabled={props.busy} className="rounded-lg bg-[#16a34a] text-white hover:bg-[#15803d] disabled:opacity-50 px-4 py-2 font-medium">
            Connect
          </button>
        ) : (
          <button onClick={props.onDisconnect} disabled={props.busy} className="rounded-lg bg-[#dc2626] text-white hover:bg-[#b91c1c] disabled:opacity-50 px-4 py-2 font-medium">
            Disconnect
          </button>
        )}
        {props.powerControl}
      </div>
    </Card>
  );
}

function PowerControl(props: { connected: boolean; minRssi?: number | null; weakDropped?: number }) {
  const [current, setCurrent] = useState<number | null>(null);
  const [value, setValue] = useState(20);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!props.connected) {
      setCurrent(null);
      return;
    }
    api
      .getPower()
      .then((r) => {
        if (r.dBm != null) {
          setCurrent(r.dBm);
          setValue(r.dBm);
        }
      })
      .catch(() => {});
  }, [props.connected]);

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.setPower(value);
      if (r.dBm != null) setCurrent(r.dBm);
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="text-sm">
      <span className="text-[#737373]">
        Read power (dBm){current != null ? <span className="text-[#15803d]"> — current {current}</span> : ''}
      </span>
      <div className="flex gap-2 mt-1 items-center">
        <input
          type="range"
          min={1}
          max={30}
          value={value}
          disabled={!props.connected || busy}
          onChange={(e) => setValue(Number(e.target.value))}
          className="flex-1 accent-[#00BCD4] disabled:opacity-40"
        />
        <span className="w-8 text-right text-sm tabular-nums">{value}</span>
        <button onClick={apply} disabled={!props.connected || busy || value === current} className="rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-50 px-3 py-1.5 text-sm">
          Set
        </button>
      </div>
      <AntennaPower connected={props.connected} />
      <ReadFloor minRssi={props.minRssi} weakDropped={props.weakDropped} />
      <BeeperControl connected={props.connected} />
    </label>
  );
}

/**
 * The READER's buzzer — the hardware chirp, not this app's voice.
 *
 * The UR4 beeps once per tag read out of the box, and a gate reads continuously,
 * so it arrives on site sounding like a stuck alarm. Kept next to power and the
 * read floor because that is where someone goes when the gate is behaving badly,
 * and "make it stop" is usually the first thing they want.
 *
 * The setting lives in the reader and survives a power cycle, so this is one
 * press forever — no need to re-apply on connect.
 */
function BeeperControl(props: { connected: boolean }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!props.connected) {
      setOn(null);
      return;
    }
    api
      .getBeep()
      .then((r) => setOn(r.ok ? r.on : null))
      .catch(() => setOn(null));
  }, [props.connected]);

  const toggle = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.setBeep(!on);
      if (!r.ok) setNote(r.error ?? 'the reader refused the change');
      else setOn(r.on ?? !on);
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'the bridge did not answer');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[#404040]">Reader beeper</span>
        <button
          onClick={toggle}
          disabled={!props.connected || busy}
          className={`rounded-lg px-2 py-1 text-xs font-semibold disabled:opacity-40 ${
            on ? 'bg-[#fffbeb] text-[#b45309] border border-[#fcd34d]' : 'bg-[#f5f5f5] text-[#737373] border border-[#e5e5e5]'
          }`}
        >
          {on == null ? '—' : on ? 'BEEPING' : 'SILENT'}
        </button>
      </div>
      {note && <p className="text-xs text-[#b45309] mt-2">{note}</p>}
    </div>
  );
}

/**
 * Software read-zone floor: drop any read weaker than N dBm.
 *
 * The companion to power, not a substitute for it. Turning power down shrinks
 * the physical field, which also weakens the read you actually want; this leaves
 * the field alone and throws away what comes back too faint. A doorway usually
 * needs both — power enough to read the carton passing through, plus a floor
 * that discards the shelf stock the same power reaches.
 *
 * RSSI is negative and closer to zero is stronger, so the floor is an upper
 * bound on weakness: -55 is strict (near the antenna only), -80 is permissive.
 * `weakDropped` climbing while the read count stays flat means the floor is too
 * strict and real cartons are going in the bin — the reason that number is on
 * screen at all.
 */
function ReadFloor(props: { minRssi?: number | null; weakDropped?: number }) {
  const on = props.minRssi != null;
  // Deliberately a STRING, starting empty: the box shows no number until someone
  // puts one there. A pre-filled default would be this console suggesting a
  // threshold it has no way to know — the right figure depends on the doorway,
  // the antenna placement and the cartons, so it is the operator's call and the
  // UI should not pretend otherwise.
  const [text, setText] = useState(props.minRssi != null ? String(props.minRssi) : '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const typed = text.trim() === '' ? null : Number(text);
  const valid = typed != null && Number.isFinite(typed) && typed < 0;
  // Slider thumb needs somewhere to sit before anything is typed. This positions
  // it only; it never writes a number into the box on its own.
  const sliderAt = valid ? typed : -65;

  // Follow the bridge when it reports a different floor (another console, a
  // restart, READ_MIN_RSSI from the env) — but never while a change is in
  // flight, or the box would change under the operator's fingers mid-edit.
  useEffect(() => {
    if (!busy && props.minRssi != null) setText(String(props.minRssi));
  }, [props.minRssi, busy]);

  const send = async (minRssi: number | null) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.setReadFilter(minRssi);
      if (!r.ok) setNote(r.error ?? 'the bridge refused the change');
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'the bridge did not answer');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold text-[#404040]">Ignore weak reads</span>
        <button
          onClick={() => send(on ? null : typed)}
          disabled={busy || (!on && !valid)}
          title={!on && !valid ? 'Type a cut-off first' : undefined}
          className={`rounded-lg px-2 py-1 text-xs font-semibold disabled:opacity-40 ${
            on ? 'bg-[#f0fdf4] text-[#15803d] border border-[#86d49f]' : 'bg-[#f5f5f5] text-[#737373] border border-[#e5e5e5]'
          }`}
        >
          {on ? 'ON' : 'OFF'}
        </button>
      </div>
      <div className="flex gap-2 items-center">
        <input
          type="number"
          inputMode="numeric"
          max={-1}
          step={1}
          value={text}
          placeholder="e.g. -65"
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          className="w-24 rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-2 py-1 text-xs tabular-nums text-[#171717] placeholder:text-[#a3a3a3] disabled:opacity-40"
        />
        <span className="text-[11px] text-[#8a8a8a]">dBm</span>
        <input
          type="range"
          min={-90}
          max={-40}
          value={sliderAt}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          className="flex-1 accent-[#00BCD4] disabled:opacity-40"
          aria-label="Read floor, coarse adjust"
        />
        <button
          onClick={() => send(typed)}
          disabled={busy || !valid || typed === props.minRssi}
          className="rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-40 px-2 py-1 text-xs"
        >
          Set
        </button>
      </div>
      {text.trim() !== '' && !valid && <p className="text-xs text-[#b45309] mt-2">Signal strength is a negative number, e.g. -65.</p>}
      {note && <p className="text-xs text-[#b45309] mt-2">{note}</p>}
    </div>
  );
}

/**
 * Per-antenna enable and power.
 *
 * The gate's ports are NOT equivalent — one antenna covers the doorway and
 * another reaches down the aisle — so one global dBm is the wrong knob: raise it
 * until the passing carton reads well and you have also pulled every shelf in
 * the building into the read zone. There was no UI for any of this, which is how
 * a gate ended up running on a single port that returned no reads at all while
 * the two working antennas sat disabled.
 *
 * Enabling a DEAD port is not free either: the reader round-robins across every
 * enabled port, so each one that answers nothing is dwell time taken from the
 * ones that do. Turn a port off if nothing is plugged into it.
 *
 * The right-hand figure is the port's actual power: the reader's own per-port
 * read-back where it answers, overridden by what this bridge last wrote. Blank
 * means neither was available — not "unset".
 */
function AntennaPower(props: { connected: boolean }) {
  const PORTS = [1, 2, 3, 4];
  const [enabled, setEnabled] = useState<number[]>([]);
  const [applied, setApplied] = useState<Record<number, number>>({});
  const [draft, setDraft] = useState<Record<number, number>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!props.connected) return;
    try {
      const [a, p] = await Promise.all([api.antennas(), api.getPower()]);
      setEnabled(Array.isArray(a.enabled) ? a.enabled : []);
      // This firmware DOES answer the per-port read-back, so prefer the reader's
      // own numbers over nothing — showing "—" for a port that is sitting at
      // 15dBm is what made a working setting look like one that never saved.
      // `applied` still wins where present: it is what we last wrote, and it
      // survives a firmware that goes quiet mid-read.
      const back = Object.fromEntries(
        Object.entries(p.perAntenna ?? {})
          .map(([port, v]) => [Number(port), v?.read ?? v?.write])
          .filter(([, v]) => typeof v === 'number')
      ) as Record<number, number>;
      const app = { ...back, ...(p.applied ?? {}) };
      setApplied(app);
      setDraft((d) => ({ ...Object.fromEntries(PORTS.map((n) => [n, app[n] ?? p.dBm ?? 18])), ...d }));
    } catch {
      /* console is best-effort */
    }
  }, [props.connected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (port: number) => {
    const next = enabled.includes(port) ? enabled.filter((p) => p !== port) : [...enabled, port].sort();
    if (!next.length) {
      setNote('At least one antenna has to stay on.');
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const r = await api.setAntennas(next);
      if (!r.ok) setNote(`Reader refused the change (rc ${r.rc}).`);
      setEnabled(Array.isArray(r.enabled) ? r.enabled : next);
    } finally {
      setBusy(false);
      // A port just came on: pull its real dBm so the slider does not start at
      // a default the reader disagrees with.
      void refresh();
    }
  };

  const applyPower = async (port: number) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.setAntennaPower({ [port]: draft[port] });
      if (!r.ok) setNote(`Reader refused the change (rc ${r.rc}).`);
      if (r.applied) setApplied(r.applied);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-lg border border-[#e5e5e5] bg-[#fafafa] p-3">
      <div className="text-xs font-semibold text-[#404040] mb-2">Antennas</div>
      <div className="space-y-2">
        {PORTS.map((port) => {
          const on = enabled.includes(port);
          return (
            <div key={port} className="flex items-center gap-2">
              <button
                onClick={() => toggle(port)}
                disabled={!props.connected || busy}
                className={`w-14 shrink-0 rounded-lg px-2 py-1 text-xs font-semibold disabled:opacity-40 ${
                  on ? 'bg-[#f0fdf4] text-[#15803d] border border-[#86d49f]' : 'bg-[#f5f5f5] text-[#8a8a8a] border border-[#e5e5e5]'
                }`}
              >
                ANT {port}
              </button>
              <input
                type="range"
                min={1}
                max={30}
                value={draft[port] ?? 18}
                disabled={!props.connected || busy || !on}
                onChange={(e) => setDraft((d) => ({ ...d, [port]: Number(e.target.value) }))}
                className="flex-1 accent-[#00BCD4] disabled:opacity-30"
              />
              <span className="w-8 text-right text-xs tabular-nums text-[#404040]">{draft[port] ?? 18}</span>
              <span className="w-14 text-right text-[11px] tabular-nums text-[#8a8a8a]">
                {applied[port] != null ? `${applied[port]} dBm` : '—'}
              </span>
              <button
                onClick={() => applyPower(port)}
                disabled={!props.connected || busy || !on || draft[port] === applied[port]}
                className="rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-40 px-2 py-1 text-xs"
              >
                Set
              </button>
            </div>
          );
        })}
      </div>
      {note && <p className="text-xs text-[#b45309] mt-2">{note}</p>}
    </div>
  );
}

/* ------------------------------------------------------------ read mode */

function ModePanel(props: { mode: Mode; irDuration: number; busy: boolean; onIrDuration: (v: number) => void; onSetMode: (m: Mode) => void }) {
  return (
    <Card title="Read Mode">
      <div className="flex rounded-full bg-white border border-[#e3e8ea] p-1 mb-3 shadow-[0_1px_2px_rgba(16,42,51,.05)]">
        <ModeButton active={props.mode === 'manual'} onClick={() => props.onSetMode('manual')} disabled={props.busy}>
          Manual
        </ModeButton>
        <ModeButton active={props.mode === 'ir'} onClick={() => props.onSetMode('ir')} disabled={props.busy}>
          IR (bridge)
        </ModeButton>
        <ModeButton active={props.mode === 'hw'} onClick={() => props.onSetMode('hw')} disabled={props.busy}>
          IR (HW+UDP)
        </ModeButton>
      </div>
      <label className="text-sm block">
        <span className="text-[#737373]">Burst duration (ms) — read window per IR trigger</span>
        <div className="flex gap-2 mt-1">
          <input
            type="number"
            value={props.irDuration}
            min={50}
            step={50}
            onChange={(e) => props.onIrDuration(Number(e.target.value))}
            className="w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm"
          />
          <button onClick={() => props.onSetMode(props.mode)} disabled={props.busy} className="rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-50 px-3 py-2 text-sm">
            Apply
          </button>
        </div>
      </label>
      <TimingControl />
    </Card>
  );
}

function TimingControl() {
  const [dedupMs, setDedupMs] = useState(5000);
  const [quietMs, setQuietMs] = useState(700);
  const [maxWindowMs, setMaxWindowMs] = useState(4000);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api
      .nexusSummary()
      .then((s) => {
        if (Number.isFinite(s.dedupMs)) setDedupMs(s.dedupMs);
        if (Number.isFinite(s.quietMs)) setQuietMs(s.quietMs);
        if (Number.isFinite(s.maxWindowMs)) setMaxWindowMs(s.maxWindowMs);
      })
      .catch(() => {});
  }, []);

  const apply = async () => {
    setBusy(true);
    setSaved(false);
    try {
      await api.setNexusConfig({ dedupMs, quietMs, maxWindowMs });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setBusy(false);
    }
  };

  const Field = (p: { label: string; value: number; step: number; min: number; onChange: (v: number) => void; hint: string }) => (
    <label className="text-xs block">
      <span className="text-[#737373]">{p.label}</span>
      <input
        type="number"
        value={p.value}
        min={p.min}
        step={p.step}
        onChange={(e) => p.onChange(Number(e.target.value))}
        title={p.hint}
        className="mt-0.5 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-2 py-1.5 text-sm"
      />
    </label>
  );

  return (
    <div className="mt-4 pt-3 border-t border-[#e5e5e5]">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wider text-[#737373]">Portal timing (ms)</span>
        {saved && <span className="text-xs text-[#15803d]">saved ✓</span>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Dedup" value={dedupMs} min={0} step={500} onChange={setDedupMs} hint="Ignore the same tag for this long after a movement event" />
        <Field label="Quiet" value={quietMs} min={100} step={100} onChange={setQuietMs} hint="Decide direction after this much read-silence" />
        <Field label="Max window" value={maxWindowMs} min={500} step={500} onChange={setMaxWindowMs} hint="Hard cap on one decision window" />
      </div>
      <button onClick={apply} disabled={busy} className="mt-2 w-full rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-50 px-3 py-1.5 text-sm">
        Apply timing
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ GPI */

function GpiPanel(props: { gpi: GpiState; mode: Mode }) {
  return (
    <Card title="GPI Status (IR sensor)">
      <div className="flex gap-6">
        <GpiLamp label="GPI1" state={props.gpi.gpi1} primary={props.mode === 'ir'} />
        <GpiLamp label="GPI2" state={props.gpi.gpi2} primary={false} />
      </div>
      <div className="mt-3 text-xs text-[#8a8a8a] break-all">raw: {props.gpi.raw || '—'}</div>
    </Card>
  );
}

function GpiLamp(props: { label: string; state: boolean | null; primary: boolean }) {
  const broken = props.state === true;
  const unknown = props.state === null;
  const color = unknown ? 'bg-[#00BCD4] text-white' : broken ? 'bg-[#dc2626] shadow-[0_0_14px] shadow-[#dc2626]/50' : 'bg-[#16a34a]';
  const text = unknown ? 'no data' : broken ? 'BEAM BROKEN' : 'beam clear';
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className={`h-6 w-6 rounded-full ${color} ${broken ? 'animate-pulse' : ''}`} />
      <span className={`text-sm font-medium ${props.primary ? 'text-[#008A9C]' : 'text-[#404040]'}`}>{props.label}</span>
      <span className={`text-xs ${broken ? 'text-[#b91c1c]' : unknown ? 'text-[#8a8a8a]' : 'text-[#15803d]'}`}>{text}</span>
    </div>
  );
}

/* --------------------------------------------------------- read controls */

function ReadControls(props: { connected: boolean; reading: boolean; mode: Mode; busy: boolean; onStart: () => void; onStop: () => void }) {
  const disabled = !props.connected || props.busy || props.mode === 'hw';
  if (props.mode === 'hw') {
    return (
      <div className="rounded-xl border border-[#e5e5e5] bg-white px-4 py-4 text-sm text-[#737373] text-center">
        HW trigger mode — the reader starts reading by itself when the IR beam breaks. Manual Start / Stop is disabled; watch
        the UDP panel below.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-4">
      <button
        onClick={props.onStart}
        disabled={disabled || props.reading}
        className="flex-1 rounded-xl bg-[#16a34a] text-white hover:bg-[#15803d] disabled:opacity-40 disabled:cursor-not-allowed py-4 text-lg font-semibold"
      >
        ▶ Start Reading
      </button>
      <button
        onClick={props.onStop}
        disabled={disabled || !props.reading}
        className="flex-1 rounded-xl bg-[#dc2626] text-white hover:bg-[#b91c1c] disabled:opacity-40 disabled:cursor-not-allowed py-4 text-lg font-semibold"
      >
        ■ Stop Reading
      </button>
    </div>
  );
}

/* --------------------------------------------------- Printer (CP30, ZPL) */

function PrintPanel(props: { rows: TagRow[]; readerConnected: boolean; reading: boolean }) {
  const [cfg, setCfg] = useState<PrinterConfig | null>(null);
  const [queues, setQueues] = useState<string[]>([]);
  const [nextEpc, setNextEpc] = useState('');
  const [lastPrint, setLastPrint] = useState<LastPrint | null>(null);
  const [lastZpl, setLastZpl] = useState('');
  const [epcInput, setEpcInput] = useState('');
  const [copies, setCopies] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [rawZpl, setRawZpl] = useState('^XA\n^FO24,24^A0N,32,32^FDPRINTER SELF TEST^FS\n^XZ\n');

  useEffect(() => {
    api
      .printerStatus()
      .then((s) => {
        if (s.config) setCfg(s.config);
        if (s.nextEpc) setNextEpc(s.nextEpc);
        if (s.lastPrint) setLastPrint(s.lastPrint);
      })
      .catch(() => {});
    api
      .printerQueues()
      .then((r) => setQueues(r.queues ?? []))
      .catch(() => {});
  }, []);

  const applyCfg = async (partial: Partial<PrinterConfig>) => {
    setError('');
    // optimistic update so the inputs feel live; bridge response is authoritative
    setCfg((c) => (c ? { ...c, ...partial } : c));
    try {
      const r = await api.printerConfig(partial);
      if (r.config) setCfg(r.config);
      else if (r.error) setError(r.error);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const print = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.printerPrint({ epc: epcInput.trim() || undefined, copies });
      if (!r.ok) throw new Error(r.error || 'print failed');
      setLastPrint({ epc: r.epc, at: new Date().toISOString(), transport: r.transport, target: r.target });
      setLastZpl(r.zpl);
      if (r.nextEpc) setNextEpc(r.nextEpc);
      setEpcInput('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendRaw = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.printerRaw(rawZpl);
      if (!r.ok) throw new Error(r.error || 'raw send failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // A print is verified once the UR4 reads that EPC *after* the print was sent.
  const verified = !!lastPrint && props.rows.some((r) => r.epc.toUpperCase() === lastPrint.epc.toUpperCase() && r.timestamp >= lastPrint.at);

  const readToVerify = async () => {
    setVerifying(true);
    try {
      await api.start();
      setTimeout(async () => {
        await api.stop().catch(() => {});
        setVerifying(false);
      }, 5000);
    } catch {
      setVerifying(false);
    }
  };

  return (
    <Card title="Chainway CP30 — Print & Encode (ZPL)">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* transport / target */}
        <div className="flex flex-col gap-3">
          <div className="flex rounded-full bg-white border border-[#e3e8ea] p-1 shadow-[0_1px_2px_rgba(16,42,51,.05)]">
            <ModeButton active={cfg?.transport !== 'tcp'} onClick={() => applyCfg({ transport: 'usb' })} disabled={busy || !cfg}>
              USB (queue)
            </ModeButton>
            <ModeButton active={cfg?.transport === 'tcp'} onClick={() => applyCfg({ transport: 'tcp' })} disabled={busy || !cfg}>
              Network :9100
            </ModeButton>
          </div>
          {cfg?.transport === 'tcp' ? (
            <div className="flex gap-2">
              <label className="text-sm flex-1">
                <span className="text-[#737373]">Printer IP</span>
                <input value={cfg.host} onChange={(e) => applyCfg({ host: e.target.value })} className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm" />
              </label>
              <label className="text-sm w-24">
                <span className="text-[#737373]">Port</span>
                <input
                  type="number"
                  value={cfg.port}
                  onChange={(e) => applyCfg({ port: Number(e.target.value) })}
                  className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm"
                />
              </label>
            </div>
          ) : (
            <label className="text-sm">
              <span className="text-[#737373]">Windows print queue</span>
              <select
                value={cfg?.printerName ?? ''}
                onChange={(e) => applyCfg({ printerName: e.target.value })}
                disabled={!cfg}
                className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm"
              >
                {cfg && !queues.includes(cfg.printerName) && <option value={cfg.printerName}>{cfg.printerName}</option>}
                {queues.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="flex items-center gap-2 text-sm text-[#404040]">
            <input type="checkbox" checked={cfg?.barcode ?? true} onChange={(e) => applyCfg({ barcode: e.target.checked })} disabled={!cfg} />
            Print Code-128 barcode of the EPC
          </label>
          <div className="flex gap-2">
            <label className="text-sm flex-1">
              <span className="text-[#737373]">Top offset (dots)</span>
              <input
                type="number"
                min={0}
                step={8}
                value={cfg?.topOffsetDots ?? 0}
                onChange={(e) => applyCfg({ topOffsetDots: Number(e.target.value) || 0 })}
                disabled={!cfg}
                className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-sm flex-1">
              <span className="text-[#737373]">Left offset (dots)</span>
              <input
                type="number"
                min={0}
                step={8}
                value={cfg?.leftOffsetDots ?? 0}
                onChange={(e) => applyCfg({ leftOffsetDots: Number(e.target.value) || 0 })}
                disabled={!cfg}
                className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm"
              />
            </label>
          </div>
        </div>

        {/* EPC + print + verify */}
        <div className="flex flex-col gap-3">
          <label className="text-sm">
            <span className="text-[#737373]">EPC to encode (hex, blank = auto)</span>
            <input
              value={epcInput}
              onChange={(e) => setEpcInput(e.target.value)}
              placeholder={nextEpc ? `auto: ${nextEpc}` : 'auto'}
              className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm placeholder:text-[#a3a3a3]"
            />
          </label>
          <label className="text-sm w-28">
            <span className="text-[#737373]">Copies</span>
            <input
              type="number"
              min={1}
              max={50}
              value={copies}
              onChange={(e) => setCopies(Number(e.target.value) || 1)}
              className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm"
            />
          </label>
          <button onClick={print} disabled={busy || !cfg} className="rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-50 px-4 py-3 font-semibold">
            🖨 Print & Encode
          </button>
          {error && <p className="text-sm text-[#b41c1e] break-all">{error}</p>}

          <div className="text-sm">
            <span className="text-[#737373]">Last printed EPC</span>
            <div className="mt-1 text-sm break-all">
              {lastPrint ? <span className={verified ? 'text-[#15803d]' : 'text-[#b45309]'}>{lastPrint.epc}</span> : <span className="text-[#a3a3a3]">none yet</span>}
            </div>
          </div>
          {lastPrint && (
            <div
              className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                verified ? 'border-[#86d49f] bg-[#f0fdf4] text-[#15803d]' : 'border-[#fcd34d] bg-[#fffbeb] text-[#b45309]'
              }`}
            >
              {verified ? '✓ VERIFIED — EPC read back by the UR4' : 'Not verified yet — read the tag with the UR4'}
            </div>
          )}
          <button
            onClick={readToVerify}
            disabled={!props.readerConnected || props.reading || verifying || !lastPrint}
            className="rounded-lg bg-[#15803d] text-white hover:bg-[#15803d] disabled:opacity-40 px-4 py-2 text-sm font-medium"
            title={props.readerConnected ? 'Runs a 5s read burst on the UR4' : 'Connect the UR4 reader first'}
          >
            {verifying ? 'Reading… hold the label near the UR4' : 'Read 5s to verify'}
          </button>
          {lastZpl && (
            <details className="text-xs text-[#737373]">
              <summary className="cursor-pointer select-none">ZPL sent</summary>
              <pre className="mt-2 rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 p-2 overflow-x-auto">{lastZpl}</pre>
            </details>
          )}
        </div>
      </div>

      <details className="mt-4 text-sm text-[#737373]">
        <summary className="cursor-pointer select-none">Raw ZPL console (tuning / experiments)</summary>
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            value={rawZpl}
            onChange={(e) => setRawZpl(e.target.value)}
            rows={5}
            spellCheck={false}
            className="w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-xs"
          />
          <button onClick={sendRaw} disabled={busy} className="self-start rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-50 px-4 py-2 text-sm">
            Send raw ZPL
          </button>
        </div>
      </details>
    </Card>
  );
}

/* ------------------------------------------- Pallet tag printer (TSPL) */

/** Printhead densities that exist on TSPL hardware we'd use. Free-text would
 *  let a typo silently rescale every tag, so this is a fixed choice. */
const PALLET_DPI_OPTIONS = [203, 300, 600];

/**
 * Config for the barcode-only pallet tag and the printer that makes it — a
 * different device from the CP30 above (plain paper, no RFID encode, TSPL not
 * ZPL), so it gets its own queue, media size and printhead density.
 *
 * The density is the reason this panel exists. TSPL declares label size in mm
 * but positions every element in printhead DOTS, so a 300 dpi printer driven at
 * 203 prints the whole design squashed into a corner and reports success. The
 * printer only tells you its dpi on its own config label, hence the SELFTEST
 * button next to the selector.
 */
function PalletTagPanel() {
  const [cfg, setCfg] = useState<PrinterConfig | null>(null);
  const [queues, setQueues] = useState<string[]>([]);
  const [ready, setReady] = useState<{ ok?: boolean; detail?: string }>({});
  const [testCode, setTestCode] = useState('Pallet-TEST');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const refresh = () => {
    api
      .printerStatus()
      .then((s) => {
        if (s.config) setCfg(s.config);
        setReady({ ok: s.palletReady, detail: s.palletDetail });
      })
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    api
      .printerQueues()
      .then((r) => setQueues(r.queues ?? []))
      .catch(() => {});
  }, []);

  const applyCfg = async (partial: Partial<PrinterConfig>) => {
    setError('');
    setNote('');
    // Optimistic so the inputs feel live; the bridge response is authoritative
    // (it clamps/whitelists, e.g. a rejected dpi snaps back to 203).
    setCfg((c) => (c ? { ...c, ...partial } : c));
    try {
      const r = await api.printerConfig(partial);
      if (r.config) setCfg(r.config);
      else if (r.error) setError(r.error);
      // Queue changes invalidate the readiness verdict — re-probe the new one.
      if (partial.palletPrinterName) refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const run = async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      const r = await fn();
      if (!r.ok) throw new Error(r.error || `${label} failed`);
      setNote(`${label} sent`);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const numField = (label: string, key: keyof PrinterConfig, step = 1) => (
    <label className="text-sm flex-1">
      <span className="text-[#737373]">{label}</span>
      <input
        type="number"
        min={0}
        step={step}
        value={(cfg?.[key] as number) ?? 0}
        onChange={(e) => applyCfg({ [key]: Number(e.target.value) || 0 } as Partial<PrinterConfig>)}
        disabled={!cfg}
        className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm"
      />
    </label>
  );

  return (
    <Card title="Pallet Tag Printer (TSPL — Gprinter / TSC)">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* printer + density */}
        <div className="flex flex-col gap-3">
          {/* HOW the printer is reached. Network needs no second machine switched
              on, which is why it is first and recommended. */}
          <div className="text-sm">
            <span className="text-[#737373]">How the pallet printer is reached</span>
            <div className="mt-1 flex rounded-full bg-white border border-[#e3e8ea] p-1 shadow-[0_1px_2px_rgba(16,42,51,.05)]">
              <ModeButton active={cfg?.palletTransport === 'tcp'} onClick={() => applyCfg({ palletTransport: 'tcp' })} disabled={busy || !cfg}>
                Network (printer IP)
              </ModeButton>
              <ModeButton
                active={cfg?.palletTransport !== 'tcp'}
                onClick={() => applyCfg({ palletTransport: 'sidecar' })}
                disabled={busy || !cfg}
              >
                Via a PC (sidecar)
              </ModeButton>
            </div>
          </div>

          {cfg?.palletTransport === 'tcp' ? (
            /* CONTROLLED, with an explicit Set. Uncontrolled inputs kept their
               first value while the stored config changed underneath them, then
               wrote that stale value back on blur — which is how the printer PC's
               address ended up in the PRINTER IP field and the sidecar's port in
               the TCP port field, and why the setting appeared to change on its
               own. */
            <AddressField
              label="Printer IP — the label printer itself, not a PC"
              value={cfg?.palletHost ?? ''}
              port={cfg?.palletTcpPort ?? 9100}
              placeholder="192.168.1.137"
              onApply={(host, port) => applyCfg({ palletHost: host, palletTcpPort: port })}
            />
          ) : (
            <>
              <UrlField
                label="Printer PC address (sidecar) — the PC, not the printer"
                value={cfg?.palletSidecarUrl ?? ''}
                placeholder="http://192.168.1.112:3011"
                hint="Blank = print on this machine. Must be an address this bridge can reach — a PC on a different network will always time out."
                onApply={(url) => applyCfg({ palletSidecarUrl: url })}
              />
              <label className="text-sm">
                <span className="text-[#737373]">Windows print queue</span>
                <select
                  value={cfg?.palletPrinterName ?? ''}
                  onChange={(e) => applyCfg({ palletPrinterName: e.target.value })}
                  disabled={!cfg}
                  className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm"
                >
                  {cfg && !queues.includes(cfg.palletPrinterName) && (
                    <option value={cfg.palletPrinterName}>{cfg.palletPrinterName}</option>
                  )}
                  {queues.map((q) => (
                    <option key={q} value={q}>
                      {q}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {ready.detail && (
            <div
              className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                ready.ok ? 'border-[#86d49f] bg-[#f0fdf4] text-[#15803d]' : 'border-[#f0a1a2] bg-[#fef2f2] text-[#b41c1e]'
              }`}
            >
              {ready.ok ? '✓ ' : '✕ '}
              {ready.detail}
            </div>
          )}

          <div className="text-sm">
            <span className="text-[#737373]">Printhead density</span>
            <div className="mt-1 flex rounded-full bg-white border border-[#e3e8ea] p-1 shadow-[0_1px_2px_rgba(16,42,51,.05)]">
              {PALLET_DPI_OPTIONS.map((d) => (
                <ModeButton key={d} active={cfg?.palletDpi === d} onClick={() => applyCfg({ palletDpi: d })} disabled={busy || !cfg}>
                  {d} dpi
                </ModeButton>
              ))}
            </div>
          </div>
          <button
            onClick={() => run('Config label', () => api.palletSelfTest())}
            disabled={busy || !cfg}
            className="rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-50 px-4 py-2 text-sm font-medium"
            title="Prints the printer's own configuration label, which lists its dpi"
          >
            🧾 Print config label — read the dpi off it
          </button>
        </div>

        {/* media + test print */}
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            {numField('Label width (mm)', 'palletWidthMm')}
            {numField('Label height (mm)', 'palletHeightMm')}
          </div>
          {numField('Left offset (mm)', 'palletLeftOffsetMm')}
          <label className="text-sm">
            <span className="text-[#737373]">Test tag code</span>
            <input
              value={testCode}
              onChange={(e) => setTestCode(e.target.value)}
              className="mt-1 w-full rounded-lg bg-white border border-[#e3e8ea] outline-none transition focus:border-[#00BCD4] focus:ring-2 focus:ring-[#00BCD4]/20 px-3 py-2 text-sm"
            />
          </label>
          <button
            onClick={() => run('Test tag', () => api.palletTestTag({ palletCode: testCode.trim() || undefined }))}
            disabled={busy || !cfg}
            className="rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all disabled:opacity-50 px-4 py-3 font-semibold"
          >
            🏷 Print test tag
          </button>
          {note && <p className="text-sm text-[#15803d]">{note}</p>}
          {error && <p className="text-sm text-[#b41c1e] break-all">{error}</p>}
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ stats */

function Stats(props: { total: number; unique: number; rps: number }) {
  return (
    <div className="grid grid-cols-3 gap-4">
      <Stat label="Total reads" value={props.total.toLocaleString()} />
      <Stat label="Unique EPCs" value={props.unique.toLocaleString()} />
      <Stat label="Reads / sec" value={String(props.rps)} />
    </div>
  );
}

function Stat(props: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-[#eef1f2] bg-white p-5 shadow-[0_1px_2px_rgba(16,42,51,.04),0_10px_28px_-16px_rgba(0,138,156,.14)] text-center">
      <div className="text-3xl font-bold tabular-nums">{props.value}</div>
      <div className="text-xs uppercase tracking-wider text-[#737373] mt-1">{props.label}</div>
    </div>
  );
}

/* ------------------------------------------------------ gate movements */

function MovementsPanel(props: { entries: EntryRow[] }) {
  const { entries } = props;
  // latest movement per EPC decides who's inside
  const latestByEpc = new Map<string, EntryRow>();
  for (const e of entries) if (!latestByEpc.has(e.epc)) latestByEpc.set(e.epc, e);
  const insideCount = [...latestByEpc.values()].filter((e) => e.kind === 'entry').length;
  return (
    <section className="rounded-2xl border border-[#d5eef2] bg-white overflow-hidden shadow-[0_1px_2px_rgba(16,42,51,.04),0_10px_28px_-16px_rgba(0,138,156,.14)]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#e5e5e5] bg-[#e0f7fa]">
        <h2 className="text-sm font-medium text-[#008A9C]">
          🏭 Gate Movements <span className="text-[#8a8a8a]">(Mock Nexus · GPI1 first = IN, GPI2 first = OUT)</span>
        </h2>
        <div className="text-sm text-[#008A9C] font-semibold tabular-nums">{insideCount} inside</div>
      </div>
      <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white text-[#737373]">
            <tr>
              <th className="text-left font-medium px-4 py-2 w-32">Time</th>
              <th className="text-left font-medium px-4 py-2 w-28">SKU</th>
              <th className="text-left font-medium px-4 py-2">Item</th>
              <th className="text-left font-medium px-4 py-2 w-56">EPC</th>
              <th className="text-left font-medium px-4 py-2 w-24">Status</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-[#8a8a8a]">
                  No movements yet — pass a tagged box through the IR beam.
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id} className="border-t border-[#f0f0f0] hover:bg-[#f0fbfd]">
                  <td className="px-4 py-1.5 text-xs text-[#737373]">{new Date(e.timestamp).toLocaleTimeString(undefined, { hour12: false })}</td>
                  <td className={`px-4 py-1.5 text-xs ${e.known ? 'text-[#008A9C]' : 'text-[#b45309]'}`}>{e.item.sku}</td>
                  <td className={`px-4 py-1.5 ${e.known ? '' : 'text-[#b45309] italic'}`}>{e.item.name}</td>
                  <td className="px-4 py-1.5 text-xs text-[#8a8a8a]">{e.epc}</td>
                  <td className="px-4 py-1.5">
                    {/* A contested passage gets its own pill rather than a green
                        IN. This list is where "the console says 8 IN" comes
                        from, and a pallet that then reports 4 looks like a bug
                        until you can see that 4 of the 8 were on no open batch.
                        The No-IR decisions table has carried this all along; the
                        movement list had not. */}
                    {e.unexpected ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[#fef2f2] text-[#b41c1e] border border-[#f0a1a2]" title={e.unexpected}>
                        {e.kind === 'entry' ? 'IN' : 'OUT'} · {e.unexpected}
                      </span>
                    ) : e.kind === 'entry' ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[#f0fdf4] text-[#15803d] border border-[#a7e3bd]">IN</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-[#e0f2fe] text-[#0369a1] border border-[#7dd3fc]">OUT</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- UDP feed */

function UdpPanel(props: { udp?: UdpState; frames: UdpFrameRow[] }) {
  const { udp, frames } = props;
  return (
    <section className="rounded-2xl border border-[#eef1f2] bg-white overflow-hidden shadow-[0_1px_2px_rgba(16,42,51,.04),0_10px_28px_-16px_rgba(0,138,156,.14)]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#e5e5e5]">
        <h2 className="text-sm font-medium text-[#404040]">
          UDP Frames from Reader <span className="text-[#8a8a8a]">(HW trigger output, last 50)</span>
        </h2>
        <div className="text-xs text-[#737373]">
          {udp?.listening ? (
            <>
              listening :{udp.port} · dest {udp.destIp ?? '?'} · {udp.frames} frames
            </>
          ) : (
            'listener off'
          )}
        </div>
      </div>
      <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white text-[#737373]">
            <tr>
              <th className="text-left font-medium px-4 py-2 w-40">Time</th>
              <th className="text-left font-medium px-4 py-2 w-40">From</th>
              <th className="text-right font-medium px-4 py-2 w-16">Len</th>
              <th className="text-left font-medium px-4 py-2 w-56">Parsed EPC</th>
              <th className="text-left font-medium px-4 py-2">Raw (hex)</th>
            </tr>
          </thead>
          <tbody>
            {frames.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-[#8a8a8a]">
                  No UDP datagrams yet — break the IR beam. If nothing arrives, check reader work mode and dest IP via{' '}
                  <span className="font-semibold">GET /debug/workmode</span>.
                </td>
              </tr>
            ) : (
              frames.map((f) => (
                <tr key={f.id} className="border-t border-[#f0f0f0] hover:bg-[#f0fbfd]">
                  <td className="px-4 py-1.5 text-xs text-[#737373]">
                    {new Date(f.timestamp).toLocaleTimeString(undefined, { hour12: false })}.
                    {String(new Date(f.timestamp).getMilliseconds()).padStart(3, '0')}
                  </td>
                  <td className="px-4 py-1.5 text-xs text-[#737373]">{f.from}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{f.len}</td>
                  <td className={`px-4 py-1.5 text-xs ${f.parsed ? 'text-[#15803d]' : 'text-[#a3a3a3]'}`}>{f.epc ?? 'unparsed'}</td>
                  <td className="px-4 py-1.5 text-xs text-[#b45309] break-all">{f.raw}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- Tag table */

function TagTable(props: { rows: TagRow[]; onClear: () => void }) {
  return (
    <section className="rounded-2xl border border-[#eef1f2] bg-white overflow-hidden shadow-[0_1px_2px_rgba(16,42,51,.04),0_10px_28px_-16px_rgba(0,138,156,.14)]">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#e5e5e5]">
        <h2 className="text-sm font-medium text-[#404040]">
          Live Reads <span className="text-[#8a8a8a]">(newest first, last 100)</span>
        </h2>
        <button onClick={props.onClear} className="text-sm rounded-lg bg-gradient-to-b from-[#00BCD4] to-[#00a3b9] text-white shadow-[0_2px_10px_rgba(0,188,212,.28)] hover:from-[#009fb4] hover:to-[#008A9C] active:scale-[.98] transition-all px-3 py-1.5">
          Clear
        </button>
      </div>
      <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white text-[#737373]">
            <tr>
              <th className="text-left font-medium px-4 py-2 w-40">Time</th>
              <th className="text-left font-medium px-4 py-2">EPC</th>
              <th className="text-right font-medium px-4 py-2 w-24">Antenna</th>
              <th className="text-right font-medium px-4 py-2 w-28">RSSI</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-[#8a8a8a]">
                  No reads yet.
                </td>
              </tr>
            ) : (
              props.rows.map((r) => (
                <tr key={r.id} className="border-t border-[#f0f0f0] hover:bg-[#f0fbfd]">
                  <td className="px-4 py-1.5 text-xs text-[#737373]">
                    {new Date(r.timestamp).toLocaleTimeString(undefined, { hour12: false })}.
                    {String(new Date(r.timestamp).getMilliseconds()).padStart(3, '0')}
                  </td>
                  <td className="px-4 py-1.5 text-[#15803d]">{r.epc}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{r.antenna ?? '—'}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{r.rssi != null ? `${r.rssi} dBm` : '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* -------------------------------------------------------- Trigger flash */

function TriggerFlash(props: { lastTriggerAt: number }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!props.lastTriggerAt) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), 900);
    return () => clearTimeout(t);
  }, [props.lastTriggerAt]);

  if (!show) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
      <div key={props.lastTriggerAt} className="trigger-flash rounded-2xl bg-[#00BCD4] text-white px-12 py-8 text-5xl font-black tracking-tight shadow-2xl">
        ⚡ TRIGGERED!
      </div>
    </div>
  );
}
