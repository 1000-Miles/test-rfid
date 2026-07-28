import { useEffect, useState } from 'react';
import { api } from './api';
import { useBridge } from './useBridge';
import { useVoice } from './useVoice';
import TvBoard from './TvBoard';
import type { EntryRow, GpiState, LastPrint, Mode, PrinterConfig, TagRow, UdpFrameRow, UdpState } from './types';

export default function App() {
  const bridge = useBridge();
  const { status } = bridge;

  const [ip, setIp] = useState('192.168.99.202');
  const [port, setPort] = useState(8888);
  const [irDuration, setIrDuration] = useState(500);
  const [busy, setBusy] = useState(false);

  // pull defaults from the bridge once
  useEffect(() => {
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
  }, []);

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

  // --- voice announcements on warehouse check-ins ---
  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem('voiceOn') === '1');
  useEffect(() => {
    localStorage.setItem('voiceOn', voiceOn ? '1' : '0');
  }, [voiceOn]);
  useVoice(bridge.entries, voiceOn);

  // --- TV wallboard mode via #tv ---
  const [tvMode, setTvMode] = useState(() => window.location.hash === '#tv');
  useEffect(() => {
    const onHash = () => setTvMode(window.location.hash === '#tv');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (tvMode) return <TvBoard bridge={bridge} />;

  return (
    <div className="min-h-full flex flex-col">
      <TriggerFlash lastTriggerAt={bridge.lastTriggerAt} />

      <Header
        wsConnected={bridge.wsConnected}
        connected={status.connected}
        reading={status.reading}
        voiceOn={voiceOn}
        onToggleVoice={() => setVoiceOn((v) => !v)}
      />

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-6 flex flex-col gap-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <ConnectPanel
            ip={ip}
            port={port}
            connected={status.connected}
            busy={busy}
            onIp={setIp}
            onPort={setPort}
            onConnect={() => run(() => api.connect(ip, port))}
            onDisconnect={() => run(() => api.disconnect())}
            powerControl={<PowerControl connected={status.connected} />}
          />
          <ModePanel
            mode={status.mode}
            irDuration={irDuration}
            connected={status.connected}
            busy={busy}
            onIrDuration={setIrDuration}
            onSetMode={setMode}
          />
          <GpiPanel gpi={bridge.gpi} mode={status.mode} />
        </div>

        <ReadControls
          connected={status.connected}
          reading={status.reading}
          mode={status.mode}
          busy={busy}
          onStart={() => run(() => api.start())}
          onStop={() => run(() => api.stop())}
        />

        <PrintPanel rows={bridge.rows} readerConnected={status.connected} reading={status.reading} />

        <Stats total={bridge.totalReads} unique={bridge.uniqueEpcs} rps={bridge.readsPerSec} />

        <WarehousePanel entries={bridge.entries} />

        {showUdp && <UdpPanel udp={status.udp} frames={bridge.udpFrames} />}

        <TagTable rows={bridge.rows} onClear={bridge.clear} />
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ Header */
function Header(props: {
  wsConnected: boolean;
  connected: boolean;
  reading: boolean;
  voiceOn: boolean;
  onToggleVoice: () => void;
}) {
  const { wsConnected, connected, reading } = props;
  return (
    <header className="border-b border-white/10 bg-[#0d1220]">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold tracking-tight">UR4 RFID Test Dashboard</span>
          {reading && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
              READING
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Pill ok={wsConnected} okText="Bridge online" badText="Bridge offline" />
          <Pill ok={connected} okText="Reader connected" badText="Reader disconnected" />
          <a
            href="#tv"
            title="Open TV wallboard mode"
            className="text-sm rounded-md px-3 py-1.5 border border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 font-medium"
          >
            📺 TV Mode
          </a>
          <button
            onClick={props.onToggleVoice}
            title={props.voiceOn ? 'Voice announcements ON — click to mute' : 'Voice announcements OFF — click to enable'}
            className={`text-lg rounded-md px-2 py-1 border transition ${
              props.voiceOn
                ? 'bg-indigo-600/30 border-indigo-500/50'
                : 'bg-black/30 border-white/10 opacity-60 hover:opacity-100'
            }`}
          >
            {props.voiceOn ? '🔊' : '🔇'}
          </button>
        </div>
      </div>
    </header>
  );
}

function Pill(props: { ok: boolean; okText: string; badText: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span
        className={`h-2.5 w-2.5 rounded-full ${props.ok ? 'bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/70' : 'bg-rose-500'}`}
      />
      <span className={props.ok ? 'text-emerald-300' : 'text-rose-300'}>{props.ok ? props.okText : props.badText}</span>
    </span>
  );
}

/* --------------------------------------------------------------- Panels */
function Card(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-[#111827] p-4">
      <h2 className="text-xs uppercase tracking-wider text-slate-400 mb-3">{props.title}</h2>
      {props.children}
    </section>
  );
}

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
          <span className="text-slate-400">Reader IP</span>
          <input
            value={props.ip}
            onChange={(e) => props.onIp(e.target.value)}
            disabled={props.connected}
            className="mt-1 w-full rounded-md bg-black/40 border border-white/10 px-3 py-2 font-mono text-sm disabled:opacity-50"
          />
        </label>
        <label className="text-sm">
          <span className="text-slate-400">Port</span>
          <input
            type="number"
            value={props.port}
            onChange={(e) => props.onPort(Number(e.target.value))}
            disabled={props.connected}
            className="mt-1 w-full rounded-md bg-black/40 border border-white/10 px-3 py-2 font-mono text-sm disabled:opacity-50"
          />
        </label>
        {!props.connected ? (
          <button
            onClick={props.onConnect}
            disabled={props.busy}
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 font-medium"
          >
            Connect
          </button>
        ) : (
          <button
            onClick={props.onDisconnect}
            disabled={props.busy}
            className="rounded-md bg-rose-600 hover:bg-rose-500 disabled:opacity-50 px-4 py-2 font-medium"
          >
            Disconnect
          </button>
        )}
        {props.powerControl}
      </div>
    </Card>
  );
}

function PowerControl(props: { connected: boolean }) {
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
      <span className="text-slate-400">
        Read power (dBm){current != null ? <span className="text-emerald-400"> — current {current}</span> : ''}
      </span>
      <div className="flex gap-2 mt-1 items-center">
        <input
          type="range"
          min={1}
          max={30}
          value={value}
          disabled={!props.connected || busy}
          onChange={(e) => setValue(Number(e.target.value))}
          className="flex-1 accent-emerald-500 disabled:opacity-40"
        />
        <span className="w-8 text-right font-mono text-sm tabular-nums">{value}</span>
        <button
          onClick={apply}
          disabled={!props.connected || busy || value === current}
          className="rounded-md bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-1.5 text-sm"
        >
          Set
        </button>
      </div>
      <p className="text-xs text-slate-500 mt-1">Low = short range (fewer stray reads) · 30 = max. Persists on the reader.</p>
    </label>
  );
}

function ModePanel(props: {
  mode: Mode;
  irDuration: number;
  connected: boolean;
  busy: boolean;
  onIrDuration: (v: number) => void;
  onSetMode: (m: Mode) => void;
}) {
  return (
    <Card title="Read Mode">
      <div className="flex rounded-lg bg-black/40 border border-white/10 p-1 mb-3">
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
        <span className="text-slate-400">Burst duration (ms) — read window per IR trigger</span>
        <div className="flex gap-2 mt-1">
          <input
            type="number"
            value={props.irDuration}
            min={50}
            step={50}
            onChange={(e) => props.onIrDuration(Number(e.target.value))}
            className="w-full rounded-md bg-black/40 border border-white/10 px-3 py-2 font-mono text-sm"
          />
          <button
            onClick={() => props.onSetMode(props.mode)}
            disabled={props.busy}
            className="rounded-md bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-2 text-sm"
          >
            Apply
          </button>
        </div>
      </label>
      <p className="text-xs text-slate-500 mt-3">
        {props.mode === 'ir'
          ? 'Bridge watches GPI1 over TCP and starts a read burst when the beam breaks.'
          : props.mode === 'hw'
            ? 'Reader firmware triggers on GPI1 and pushes tag data to the bridge over UDP (work mode 2).'
            : 'You control reading with the Start / Stop buttons below.'}
      </p>
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
      <span className="text-slate-400">{p.label}</span>
      <input
        type="number"
        value={p.value}
        min={p.min}
        step={p.step}
        onChange={(e) => p.onChange(Number(e.target.value))}
        title={p.hint}
        className="mt-0.5 w-full rounded-md bg-black/40 border border-white/10 px-2 py-1.5 font-mono text-sm"
      />
    </label>
  );

  return (
    <div className="mt-4 pt-3 border-t border-white/10">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs uppercase tracking-wider text-slate-400">Portal timing (ms)</span>
        {saved && <span className="text-xs text-emerald-400">saved ✓</span>}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="Dedup" value={dedupMs} min={0} step={500} onChange={setDedupMs} hint="Ignore the same tag for this long after a movement event" />
        <Field label="Quiet" value={quietMs} min={100} step={100} onChange={setQuietMs} hint="Decide direction after this much read-silence" />
        <Field label="Max window" value={maxWindowMs} min={500} step={500} onChange={setMaxWindowMs} hint="Hard cap on one decision window" />
      </div>
      <button
        onClick={apply}
        disabled={busy}
        className="mt-2 w-full rounded-md bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-1.5 text-sm"
      >
        Apply timing
      </button>
      <p className="text-[11px] text-slate-500 mt-1.5">
        Dedup: same tag ignored after an event · Quiet: silence before direction decision · Max window: cap per passage.
      </p>
    </div>
  );
}

function ModeButton(props: { active: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
        props.active ? 'bg-indigo-600 text-white' : 'text-slate-300 hover:bg-white/5'
      } disabled:opacity-50`}
    >
      {props.children}
    </button>
  );
}

function GpiPanel(props: { gpi: GpiState; mode: Mode }) {
  return (
    <Card title="GPI Status (IR sensor)">
      <div className="flex gap-6">
        <GpiLamp label="GPI1" state={props.gpi.gpi1} primary={props.mode === 'ir'} />
        <GpiLamp label="GPI2" state={props.gpi.gpi2} primary={false} />
      </div>
      <div className="mt-3 text-xs text-slate-500 font-mono break-all">
        raw: {props.gpi.raw || '—'}
      </div>
    </Card>
  );
}

function GpiLamp(props: { label: string; state: boolean | null; primary: boolean }) {
  const broken = props.state === true;
  const unknown = props.state === null;
  const color = unknown ? 'bg-slate-600' : broken ? 'bg-red-500 shadow-[0_0_14px] shadow-red-500/70' : 'bg-emerald-500';
  const text = unknown ? 'no data' : broken ? 'BEAM BROKEN' : 'beam clear';
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className={`h-6 w-6 rounded-full ${color} ${broken ? 'animate-pulse' : ''}`} />
      <span className={`text-sm font-medium ${props.primary ? 'text-indigo-300' : 'text-slate-300'}`}>{props.label}</span>
      <span className={`text-xs ${broken ? 'text-red-400' : unknown ? 'text-slate-500' : 'text-emerald-400'}`}>{text}</span>
    </div>
  );
}

/* ---------------------------------------------------------- Read controls */
function ReadControls(props: {
  connected: boolean;
  reading: boolean;
  mode: Mode;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  const disabled = !props.connected || props.busy || props.mode === 'hw';
  if (props.mode === 'hw') {
    return (
      <div className="rounded-xl border border-white/10 bg-[#111827] px-4 py-4 text-sm text-slate-400 text-center">
        HW trigger mode — the reader starts reading by itself when the IR beam breaks. Manual Start / Stop is
        disabled; watch the UDP panel below.
      </div>
    );
  }
  return (
    <div className="flex items-center gap-4">
      <button
        onClick={props.onStart}
        disabled={disabled || props.reading}
        className="flex-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed py-5 text-xl font-semibold"
      >
        ▶ Start Reading
      </button>
      <button
        onClick={props.onStop}
        disabled={disabled || !props.reading}
        className="flex-1 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed py-5 text-xl font-semibold"
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
  const verified =
    !!lastPrint &&
    props.rows.some((r) => r.epc.toUpperCase() === lastPrint.epc.toUpperCase() && r.timestamp >= lastPrint.at);

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
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* transport / target */}
        <div className="flex flex-col gap-3">
          <div className="flex rounded-lg bg-black/40 border border-white/10 p-1">
            <ModeButton
              active={cfg?.transport !== 'tcp'}
              onClick={() => applyCfg({ transport: 'usb' })}
              disabled={busy || !cfg}
            >
              USB (queue)
            </ModeButton>
            <ModeButton
              active={cfg?.transport === 'tcp'}
              onClick={() => applyCfg({ transport: 'tcp' })}
              disabled={busy || !cfg}
            >
              Network :9100
            </ModeButton>
          </div>
          {cfg?.transport === 'tcp' ? (
            <div className="flex gap-2">
              <label className="text-sm flex-1">
                <span className="text-slate-400">Printer IP</span>
                <input
                  value={cfg.host}
                  onChange={(e) => applyCfg({ host: e.target.value })}
                  className="mt-1 w-full rounded-md bg-black/40 border border-white/10 px-3 py-2 font-mono text-sm"
                />
              </label>
              <label className="text-sm w-24">
                <span className="text-slate-400">Port</span>
                <input
                  type="number"
                  value={cfg.port}
                  onChange={(e) => applyCfg({ port: Number(e.target.value) })}
                  className="mt-1 w-full rounded-md bg-black/40 border border-white/10 px-3 py-2 font-mono text-sm"
                />
              </label>
            </div>
          ) : (
            <label className="text-sm">
              <span className="text-slate-400">Windows print queue</span>
              <select
                value={cfg?.printerName ?? ''}
                onChange={(e) => applyCfg({ printerName: e.target.value })}
                disabled={!cfg}
                className="mt-1 w-full rounded-md bg-black/40 border border-white/10 px-3 py-2 text-sm"
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
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={cfg?.barcode ?? true}
              onChange={(e) => applyCfg({ barcode: e.target.checked })}
              disabled={!cfg}
            />
            Print Code-128 barcode of the EPC
          </label>
          <div className="flex gap-2">
            <label className="text-sm flex-1">
              <span className="text-slate-400">Top offset (dots)</span>
              <input
                type="number"
                min={0}
                step={8}
                value={cfg?.topOffsetDots ?? 0}
                onChange={(e) => applyCfg({ topOffsetDots: Number(e.target.value) || 0 })}
                disabled={!cfg}
                className="mt-1 w-full rounded-md bg-black/40 border border-white/10 px-3 py-2 font-mono text-sm"
              />
            </label>
            <label className="text-sm flex-1">
              <span className="text-slate-400">Left offset (dots)</span>
              <input
                type="number"
                min={0}
                step={8}
                value={cfg?.leftOffsetDots ?? 0}
                onChange={(e) => applyCfg({ leftOffsetDots: Number(e.target.value) || 0 })}
                disabled={!cfg}
                className="mt-1 w-full rounded-md bg-black/40 border border-white/10 px-3 py-2 font-mono text-sm"
              />
            </label>
          </div>
          <p className="text-xs text-slate-500">8 dots = 1 mm. Shifts the whole layout down / right.</p>
        </div>

        {/* EPC + print */}
        <div className="flex flex-col gap-3">
          <label className="text-sm">
            <span className="text-slate-400">EPC to encode (hex, blank = auto)</span>
            <input
              value={epcInput}
              onChange={(e) => setEpcInput(e.target.value)}
              placeholder={nextEpc ? `auto: ${nextEpc}` : 'auto'}
              className="mt-1 w-full rounded-md bg-black/40 border border-white/10 px-3 py-2 font-mono text-sm placeholder:text-slate-600"
            />
          </label>
          <label className="text-sm w-28">
            <span className="text-slate-400">Copies</span>
            <input
              type="number"
              min={1}
              max={50}
              value={copies}
              onChange={(e) => setCopies(Number(e.target.value) || 1)}
              className="mt-1 w-full rounded-md bg-black/40 border border-white/10 px-3 py-2 font-mono text-sm"
            />
          </label>
          <button
            onClick={print}
            disabled={busy || !cfg}
            className="rounded-md bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 px-4 py-3 font-semibold"
          >
            🖨 Print & Encode
          </button>
          {error && <p className="text-sm text-rose-400 break-all">{error}</p>}
        </div>

        {/* last print + verify */}
        <div className="flex flex-col gap-3">
          <div className="text-sm">
            <span className="text-slate-400">Last printed EPC</span>
            <div className="mt-1 font-mono text-sm break-all">
              {lastPrint ? (
                <span className={verified ? 'text-emerald-300' : 'text-amber-300'}>{lastPrint.epc}</span>
              ) : (
                <span className="text-slate-600">none yet</span>
              )}
            </div>
          </div>
          {lastPrint && (
            <div
              className={`rounded-md border px-3 py-2 text-sm font-medium ${
                verified
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              }`}
            >
              {verified ? '✓ VERIFIED — EPC read back by the UR4' : 'Not verified yet — read the tag with the UR4'}
            </div>
          )}
          <button
            onClick={readToVerify}
            disabled={!props.readerConnected || props.reading || verifying || !lastPrint}
            className="rounded-md bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 px-4 py-2 text-sm font-medium"
            title={props.readerConnected ? 'Runs a 5s read burst on the UR4' : 'Connect the UR4 reader first'}
          >
            {verifying ? 'Reading… hold the label near the UR4' : 'Read 5s to verify'}
          </button>
          {lastZpl && (
            <details className="text-xs text-slate-400">
              <summary className="cursor-pointer select-none">ZPL sent</summary>
              <pre className="mt-2 rounded-md bg-black/40 border border-white/10 p-2 overflow-x-auto">{lastZpl}</pre>
            </details>
          )}
        </div>
      </div>

      <details className="mt-4 text-sm text-slate-400">
        <summary className="cursor-pointer select-none">Raw ZPL console (tuning / experiments)</summary>
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            value={rawZpl}
            onChange={(e) => setRawZpl(e.target.value)}
            rows={5}
            spellCheck={false}
            className="w-full rounded-md bg-black/40 border border-white/10 px-3 py-2 font-mono text-xs"
          />
          <button
            onClick={sendRaw}
            disabled={busy}
            className="self-start rounded-md bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-4 py-2 text-sm"
          >
            Send raw ZPL
          </button>
        </div>
      </details>
    </Card>
  );
}

/* ------------------------------------------------------------------ Stats */
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
    <div className="rounded-xl border border-white/10 bg-[#111827] p-4 text-center">
      <div className="text-3xl font-bold tabular-nums">{props.value}</div>
      <div className="text-xs uppercase tracking-wider text-slate-400 mt-1">{props.label}</div>
    </div>
  );
}

/* ------------------------------------------------- Warehouse check-ins */
function WarehousePanel(props: { entries: EntryRow[] }) {
  const { entries } = props;
  // latest movement per EPC decides who's inside
  const latestByEpc = new Map<string, EntryRow>();
  for (const e of entries) if (!latestByEpc.has(e.epc)) latestByEpc.set(e.epc, e);
  const insideCount = [...latestByEpc.values()].filter((e) => e.kind === 'entry').length;
  return (
    <section className="rounded-xl border border-indigo-500/30 bg-[#111827] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 bg-indigo-500/10">
        <h2 className="text-sm font-medium text-indigo-200">
          🏭 Warehouse Movements <span className="text-slate-500">(Mock Nexus · out {'{1,3}'}→in {'{2,4}'} = IN, reverse = OUT)</span>
        </h2>
        <div className="text-sm text-indigo-300 font-semibold tabular-nums">{insideCount} inside</div>
      </div>
      <div className="overflow-x-auto max-h-[40vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[#0d1220] text-slate-400">
            <tr>
              <th className="text-left font-medium px-4 py-2 w-32">Time</th>
              <th className="text-left font-medium px-4 py-2 w-28">SKU</th>
              <th className="text-left font-medium px-4 py-2">Item</th>
              <th className="text-left font-medium px-4 py-2 w-28">Pallet</th>
              <th className="text-left font-medium px-4 py-2 w-56">EPC</th>
              <th className="text-left font-medium px-4 py-2 w-24">Status</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                  No check-ins yet — pass a tagged box through the IR beam.
                </td>
              </tr>
            ) : (
              entries.map((e) => (
                <tr key={e.id} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-4 py-1.5 font-mono text-xs text-slate-400">
                    {new Date(e.timestamp).toLocaleTimeString(undefined, { hour12: false })}
                  </td>
                  <td className={`px-4 py-1.5 font-mono text-xs ${e.known ? 'text-indigo-300' : 'text-amber-400'}`}>
                    {e.item.sku}
                  </td>
                  <td className={`px-4 py-1.5 ${e.known ? '' : 'text-amber-400 italic'}`}>{e.item.name}</td>
                  <td className="px-4 py-1.5 text-slate-400">{e.item.pallet ?? '—'}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-slate-500">{e.epc}</td>
                  <td className="px-4 py-1.5">
                    {e.kind === 'entry' ? (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                        IN{e.method === 'toggle' ? '*' : ''}
                      </span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30">
                        OUT{e.method === 'toggle' ? '*' : ''}
                      </span>
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
    <section className="rounded-xl border border-white/10 bg-[#111827] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <h2 className="text-sm font-medium text-slate-300">
          UDP Frames from Reader <span className="text-slate-500">(HW trigger output, last 50)</span>
        </h2>
        <div className="text-xs font-mono text-slate-400">
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
          <thead className="sticky top-0 bg-[#0d1220] text-slate-400">
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
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  No UDP datagrams yet — break the IR beam. If nothing arrives, check reader work mode and dest
                  IP via <span className="font-mono">GET /debug/workmode</span>.
                </td>
              </tr>
            ) : (
              frames.map((f) => (
                <tr key={f.id} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-4 py-1.5 font-mono text-xs text-slate-400">
                    {new Date(f.timestamp).toLocaleTimeString(undefined, { hour12: false })}
                    .{String(new Date(f.timestamp).getMilliseconds()).padStart(3, '0')}
                  </td>
                  <td className="px-4 py-1.5 font-mono text-xs text-slate-400">{f.from}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{f.len}</td>
                  <td className={`px-4 py-1.5 font-mono text-xs ${f.parsed ? 'text-emerald-300' : 'text-slate-600'}`}>
                    {f.epc ?? 'unparsed'}
                  </td>
                  <td className="px-4 py-1.5 font-mono text-xs text-amber-200/80 break-all">{f.raw}</td>
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
    <section className="rounded-xl border border-white/10 bg-[#111827] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <h2 className="text-sm font-medium text-slate-300">
          Live Reads <span className="text-slate-500">(newest first, last 100)</span>
        </h2>
        <button onClick={props.onClear} className="text-sm rounded-md bg-slate-700 hover:bg-slate-600 px-3 py-1.5">
          Clear
        </button>
      </div>
      <div className="overflow-x-auto max-h-[50vh] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[#0d1220] text-slate-400">
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
                <td colSpan={4} className="px-4 py-10 text-center text-slate-500">
                  No reads yet.
                </td>
              </tr>
            ) : (
              props.rows.map((r) => (
                <tr key={r.id} className="border-t border-white/5 hover:bg-white/5">
                  <td className="px-4 py-1.5 font-mono text-xs text-slate-400">
                    {new Date(r.timestamp).toLocaleTimeString(undefined, { hour12: false })}
                    .{String(new Date(r.timestamp).getMilliseconds()).padStart(3, '0')}
                  </td>
                  <td className="px-4 py-1.5 font-mono text-emerald-300">{r.epc}</td>
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
      <div
        key={props.lastTriggerAt}
        className="trigger-flash rounded-2xl bg-indigo-500/90 text-white px-12 py-8 text-5xl font-black tracking-tight shadow-2xl"
      >
        ⚡ TRIGGERED!
      </div>
    </div>
  );
}
