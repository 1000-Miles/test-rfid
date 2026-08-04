import type { Mode, PrinterConfig, PrinterStatusInfo, PrintResult, Status } from './types';

// Bridge host: ?bridge=<ip> in the URL targets a remote bridge (e.g. the
// Raspberry Pi / VM), default is the local one.
const BRIDGE_HOST = new URLSearchParams(window.location.search).get('bridge') || 'localhost';
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
  getPower: async (): Promise<{ ok: boolean; dBm: number | null }> => {
    const res = await fetch(`${BRIDGE_HTTP}/power`);
    return res.json();
  },
  setPower: (dBm: number) => post<{ ok: boolean; dBm: number | null }>('/power', { dBm }),
  nexusSummary: async (): Promise<{ dedupMs: number; quietMs: number; maxWindowMs: number }> => {
    const res = await fetch(`${BRIDGE_HTTP}/nexus/summary`);
    return res.json();
  },
  setNexusConfig: (cfg: { dedupMs?: number; quietMs?: number; maxWindowMs?: number }) => post('/nexus/config', cfg),
  /** Simulate a full IR passage — emits the same trigger + direction-stamped reads a real one does. */
  mockPassage: (body: { epc?: string; direction?: 'in' | 'out' }) =>
    post<{ ok: boolean; epc: string; direction: string }>('/debug/mock-passage', body),
};
