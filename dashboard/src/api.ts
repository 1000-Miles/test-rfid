import type { DetectMode, Mode, NexusConfig, PrinterConfig, PrinterStatusInfo, PrintResult, Status } from './types';

// Bridge target: ?bridge=<host[:port]> in the URL picks which bridge this page
// talks to. The host half targets a genuinely remote bridge (e.g. a Raspberry
// Pi / VM elsewhere on the network); the port half picks between the two gate
// bridges on one machine (gate 1 on 3001, gate 2 on 3002 — see CLAUDE.md).
// `?bridge=:3002` is valid shorthand for "this same machine, gate 2".
//
// The default host is the PAGE'S OWN hostname, not a hardcoded 'localhost' —
// the bridge always runs on the same physical PC that serves this page, just
// on a different port. Opened as localhost:5173 on the kiosk itself, that
// resolves to localhost:3001, same as before. Opened from a phone via the QR
// code (Qr.tsx) at e.g. 192.168.254.125:5173, 'localhost' would mean the PHONE
// itself and every bridge call would fail — the page's own hostname is
// 192.168.254.125 either way, so it reaches the right machine automatically.
const bridgeParam = new URLSearchParams(window.location.search).get('bridge') || '';
const [paramHost, paramPort] = bridgeParam.split(':');
const BRIDGE_HOST = paramHost || window.location.hostname;
export const BRIDGE_PORT = Number(paramPort) || 3001;
export const BRIDGE_HTTP = `http://${BRIDGE_HOST}:${BRIDGE_PORT}`;
export const BRIDGE_WS = `ws://${BRIDGE_HOST}:${BRIDGE_PORT}/ws`;

async function post<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BRIDGE_HTTP}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

export const api = {
  connect: (ip: string, port: number) => post('/connect', { ip, port }),
  disconnect: () => post('/disconnect'),
  start: () => post('/inventory/start'),
  stop: () => post('/inventory/stop'),
  setMode: (cfg: { mode?: Mode; irDurationMs?: number; irMinGapMs?: number; udpPort?: number; destIp?: string }) =>
    post('/mode', cfg),
  status: async (): Promise<Status & { defaults?: { ip: string; port: number } }> => {
    const res = await fetch(`${BRIDGE_HTTP}/status`);
    return res.json();
  },
  printerStatus: async (): Promise<PrinterStatusInfo> => {
    const res = await fetch(`${BRIDGE_HTTP}/printer/status`);
    return res.json();
  },
  printerQueues: async (): Promise<{ ok: boolean; queues?: string[]; error?: string }> => {
    const res = await fetch(`${BRIDGE_HTTP}/printer/queues`);
    return res.json();
  },
  printerConfig: (cfg: Partial<PrinterConfig>): Promise<{ ok: boolean; config?: PrinterConfig; error?: string }> =>
    post('/printer/config', cfg),
  printerPrint: (body: { epc?: string; title?: string; copies?: number }): Promise<PrintResult> =>
    post('/printer/print', body),
  printerRaw: (zpl: string): Promise<{ ok: boolean; error?: string }> => post('/printer/raw', { zpl }),
  /** Make the pallet printer print its OWN config label (TSPL SELFTEST) — the
   *  only way to read its printhead dpi, since USB RAW is one-way. */
  palletSelfTest: (): Promise<{ ok: boolean; queue?: string; error?: string }> => post('/printer/pallet-selftest'),
  /** One sample pallet tag on the current pallet config (or the overrides given). */
  palletTestTag: (body: {
    palletCode?: string;
    widthMm?: number;
    heightMm?: number;
    leftOffsetMm?: number;
    dpi?: number;
  }): Promise<{ ok: boolean; palletCode?: string; target?: string; error?: string }> => post('/printer/pallet-test-tag', body),
  getPower: async (): Promise<{
    ok: boolean;
    dBm: number | null;
    /** Read back from the reader, per port — present when the firmware answers. */
    perAntenna?: Record<number, { read: number; write: number }> | null;
    /** What this bridge process last wrote per port; wins over the read-back. */
    applied?: Record<number, number>;
  }> => {
    const res = await fetch(`${BRIDGE_HTTP}/power`);
    return res.json();
  },
  setPower: (dBm: number) => post<{ ok: boolean; dBm: number | null }>('/power', { dBm }),
  /** Which antenna ports the reader has enabled. */
  antennas: async (): Promise<{ ok: boolean; enabled: number[] }> => {
    const res = await fetch(`${BRIDGE_HTTP}/antennas`);
    return res.json();
  },
  /** Enable a set of ports. The reader rejects this mid-inventory, so the
   *  bridge pauses and resumes around it. */
  setAntennas: (ports: number[]) => post<{ ok: boolean; enabled: number[]; rc: number }>('/antennas', { ports }),
  /**
   * The READER's own buzzer — the hardware chirp on every tag read, not the
   * board's voice announcements. Persists in the reader, so this is a one-time
   * press.
   */
  getBeep: async (): Promise<{ ok: boolean; on: boolean | null; error?: string }> => {
    const res = await fetch(`${BRIDGE_HTTP}/beep`);
    return res.json();
  },
  setBeep: (on: boolean) => post<{ ok: boolean; on: boolean | null; error?: string }>('/beep', { on }),
  /**
   * Software read-zone floor. Reads weaker than `minRssi` (negative dBm) are
   * dropped in the bridge — no tag event, no board row, no movement, no
   * database row. `null` keeps every read.
   *
   * Not the same knob as power: power changes the physical field (and weakens
   * the read you want), this leaves the field alone and discards what comes
   * back too faint.
   */
  setReadFilter: (minRssi: number | null) =>
    post<{ ok: boolean; minRssi: number | null; weakDropped: number; error?: string }>('/read-filter', { minRssi }),
  /** Power per antenna, e.g. { 3: 20, 4: 26 }. The ports at a gate are not
   *  equivalent — one covers the doorway, another reaches down the aisle — so a
   *  single global dBm is the wrong knob for tuning a read zone. */
  setAntennaPower: (perAntenna: Record<number, number>) =>
    post<{ ok: boolean; rc: number; applied: Record<number, number> }>('/power', { perAntenna }),
  nexusSummary: async (): Promise<NexusConfig> => {
    const res = await fetch(`${BRIDGE_HTTP}/nexus/summary`);
    return res.json();
  },
  setNexusConfig: (cfg: {
    dedupMs?: number;
    quietMs?: number;
    maxWindowMs?: number;
    detectMode?: DetectMode;
    toggleDedupMs?: number;
    absenceMs?: number;
    minRssi?: number | null;
    toggleMinReads?: number;
    toggleFastCount?: boolean;
    /**
     * How long a pallet stays open for, in ms. With no beams this is the only
     * thing separating one pallet from the next: anything read inside the window
     * joins the same pallet code and the same printed label. Takes effect on the
     * NEXT pallet, never the one already open.
     */
    palletWindowMs?: number;
  }): Promise<NexusConfig & { ok: boolean }> => post('/nexus/config', cfg),
  /** The bridge PC's real LAN IPv4 — what a phone on the same network can reach (never localhost). */
  network: async (): Promise<{ ok: boolean; ip: string | null }> => {
    const res = await fetch(`${BRIDGE_HTTP}/network`);
    return res.json();
  },
  /** Simulate a full IR passage — emits the same trigger + direction-stamped reads a real one does. */
  mockPassage: (body: { epc?: string; direction?: 'in' | 'out' }) =>
    post<{ ok: boolean; epc: string; direction: string }>('/debug/mock-passage', body),
  /** Simulate a NO-IR visit — direction-less reads; only moves anything while detectMode is 'toggle'. */
  mockVisit: (body: { epc?: string; rssi?: number; reads?: number }) =>
    post<{ ok: boolean; epc: string; reads: number; detectMode: DetectMode }>('/debug/mock-visit', body),
};
