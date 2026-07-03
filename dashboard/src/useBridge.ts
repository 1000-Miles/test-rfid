import { useCallback, useEffect, useRef, useState } from 'react';
import { BRIDGE_WS } from './api';
import type { GpiState, Status, TagRow, WsMsg } from './types';

const MAX_ROWS = 100;

export interface BridgeState {
  wsConnected: boolean;
  status: Status;
  rows: TagRow[];
  gpi: GpiState;
  totalReads: number;
  uniqueEpcs: number;
  readsPerSec: number;
  lastTriggerAt: number; // ms epoch of last IR trigger (0 = none)
  clear: () => void;
}

const initialStatus: Status = {
  connected: false,
  reading: false,
  mode: 'manual',
  irDurationMs: 500,
  irMinGapMs: 200,
  gpi: { gpi1: null, gpi2: null, raw: '' },
};

export function useBridge(): BridgeState {
  const [wsConnected, setWsConnected] = useState(false);
  const [status, setStatus] = useState<Status>(initialStatus);
  const [rows, setRows] = useState<TagRow[]>([]);
  const [gpi, setGpi] = useState<GpiState>({ gpi1: null, gpi2: null, raw: '' });
  const [totalReads, setTotalReads] = useState(0);
  const [uniqueEpcs, setUniqueEpcs] = useState(0);
  const [readsPerSec, setReadsPerSec] = useState(0);
  const [lastTriggerAt, setLastTriggerAt] = useState(0);

  const idRef = useRef(0);
  const seenRef = useRef<Set<string>>(new Set());
  const recentReadTimes = useRef<number[]>([]);

  const clear = useCallback(() => {
    setRows([]);
    setTotalReads(0);
    setUniqueEpcs(0);
    setReadsPerSec(0);
    seenRef.current = new Set();
    recentReadTimes.current = [];
  }, []);

  // reads/sec: count reads within the last 1000ms, refreshed twice a second
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - 1000;
      recentReadTimes.current = recentReadTimes.current.filter((x) => x >= cutoff);
      setReadsPerSec(recentReadTimes.current.length);
    }, 500);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      ws = new WebSocket(BRIDGE_WS);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (ev) => {
        let msg: WsMsg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'tag': {
            const row: TagRow = {
              id: idRef.current++,
              epc: msg.epc,
              antenna: msg.antenna,
              rssi: msg.rssi,
              timestamp: msg.timestamp,
            };
            setRows((prev) => [row, ...prev].slice(0, MAX_ROWS));
            setTotalReads((n) => n + 1);
            recentReadTimes.current.push(Date.now());
            if (!seenRef.current.has(msg.epc)) {
              seenRef.current.add(msg.epc);
              setUniqueEpcs(seenRef.current.size);
            }
            break;
          }
          case 'gpi':
            setGpi({ gpi1: msg.gpi1, gpi2: msg.gpi2, raw: msg.raw });
            break;
          case 'trigger':
            setLastTriggerAt(Date.now());
            break;
          case 'status':
            setStatus({
              connected: msg.connected,
              reading: msg.reading,
              mode: msg.mode,
              irDurationMs: msg.irDurationMs,
              irMinGapMs: msg.irMinGapMs,
              gpi: msg.gpi,
            });
            if (msg.gpi) setGpi(msg.gpi);
            break;
          default:
            break;
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return {
    wsConnected,
    status,
    rows,
    gpi,
    totalReads,
    uniqueEpcs,
    readsPerSec,
    lastTriggerAt,
    clear,
  };
}
