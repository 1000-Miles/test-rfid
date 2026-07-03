import type { Mode, Status } from './types';

export const BRIDGE_HTTP = 'http://localhost:3001';
export const BRIDGE_WS = 'ws://localhost:3001/ws';

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
  setMode: (cfg: { mode?: Mode; irDurationMs?: number; irMinGapMs?: number }) => post('/mode', cfg),
  status: async (): Promise<Status & { defaults?: { ip: string; port: number } }> => {
    const res = await fetch(`${BRIDGE_HTTP}/status`);
    return res.json();
  },
};
