import { useEffect, useState } from 'react';
import { api } from './api';
import { useBridge } from './useBridge';
import type { GpiState, Mode, TagRow } from './types';

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

  return (
    <div className="min-h-full flex flex-col">
      <TriggerFlash lastTriggerAt={bridge.lastTriggerAt} />

      <Header wsConnected={bridge.wsConnected} connected={status.connected} reading={status.reading} />

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

        <Stats total={bridge.totalReads} unique={bridge.uniqueEpcs} rps={bridge.readsPerSec} />

        <TagTable rows={bridge.rows} onClear={bridge.clear} />
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ Header */
function Header(props: { wsConnected: boolean; connected: boolean; reading: boolean }) {
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
      </div>
    </Card>
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
          IR-triggered
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
          ? 'Reader auto-reads when the GPI1 beam breaks, for the burst duration above.'
          : 'You control reading with the Start / Stop buttons below.'}
      </p>
    </Card>
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
  const disabled = !props.connected || props.busy;
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
