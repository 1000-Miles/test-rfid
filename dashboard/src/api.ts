import type { DetectMode, Mode, NexusConfig, PrinterConfig, PrinterStatusInfo, PrintResult, Status } from './types';

// Bridge host: ?bridge=<ip> in the URL targets a genuinely remote bridge (e.g.
// a Raspberry Pi / VM elsewhere on the network).
//
// The default is the PAGE'S OWN hostname, not a hardcoded 'localhost' — the
// bridge always runs on the same physical PC that serves this page, just on a
// different port. Opened as localhost:5173 on the kiosk itself, that resolves
// to localhost:3001, same as before. Opened from a phone via the QR code
// (Qr.tsx) at e.g. 192.168.254.125:5173, 'localhost' would mean the PHONE
// itself and every bridge call would fail — the page's own hostname is
// 192.168.254.125 either way, so it reaches the right machine automatically.
const BRIDGE_HOST = new URLSearchParams(window.location.search).get('bridge') || window.location.hostname;
export const BRIDGE_HTTP = `http://${BRIDGE_HOST}:3001`;
export const BRIDGE_WS = `ws://${BRIDGE_HOST}:3001/ws`;

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
  getPower: async (): Promise<{ ok: boolean; dBm: number | null }> => {
    const res = await fetch(`${BRIDGE_HTTP}/power`);
    return res.json();
  },
  setPower: (dBm: number) => post<{ ok: boolean; dBm: number | null }>('/power', { dBm }),
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
