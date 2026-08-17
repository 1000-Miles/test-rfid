import { useCallback, useEffect, useRef, useState } from 'react';
import { BRIDGE_WS } from './api';
import type { EntryRow, GpiState, Status, TagRow, UdpFrameRow, WsMsg } from './types';

const MAX_ROWS = 100;
const MAX_UDP_ROWS = 50;

export interface BridgeState {
  wsConnected: boolean;
  status: Status;
  rows: TagRow[];
  udpFrames: UdpFrameRow[];
  entries: EntryRow[];
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
  const [udpFrames, setUdpFrames] = useState<UdpFrameRow[]>([]);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [gpi, setGpi] = useState<GpiState>({ gpi1: null, gpi2: null, raw: '' });
  const [totalReads, setTotalReads] = useState(0);
  const [uniqueEpcs, setUniqueEpcs] = useState(0);
  const [readsPerSec, setReadsPerSec] = useState(0);
  const [lastTriggerAt, setLastTriggerAt] = useState(0);

  const idRef = useRef(0);
  const seenRef = useRef<Set<string>>(new Set());
  const recentReadTimes = useRef<number[]>([]);
  // Raw tag reads buffered between flushes — the wallboard displays none of
  // them individually, so rendering per read is pure waste on the TV.
  const pendingRows = useRef<TagRow[]>([]);
  const pendingReadCount = useRef(0);

  const clear = useCallback(() => {
    setRows([]);
    setUdpFrames([]);
    setEntries([]);
    setTotalReads(0);
    setUniqueEpcs(0);
    setReadsPerSec(0);
    seenRef.current = new Set();
    recentReadTimes.current = [];
    pendingRows.current = [];
    pendingReadCount.current = 0;
  }, []);

  // Flush buffered tag reads every 250ms — caps the board at 4 renders/sec
  // from raw reads regardless of reader speed. Movements are NOT buffered.
  useEffect(() => {
    const t = setInterval(() => {
      if (pendingReadCount.current === 0) return;
      const fresh = pendingRows.current;
      const count = pendingReadCount.current;
      pendingRows.current = [];
      pendingReadCount.current = 0;
      if (fresh.length) setRows((prev) => [...fresh, ...prev].slice(0, MAX_ROWS));
      setTotalReads((n) => n + count);
      setUniqueEpcs(seenRef.current.size);
    }, 250);
    return () => clearInterval(t);
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
    // Silence watchdog. onclose never fires on a half-open connection, and the
    // bridge sends an application-level {type:'ping'} every 5s — so 15s with no
    // message of any kind means the socket is dead. Reconnect goes through
    // close() so there is only ever ONE reconnect path.
    let lastMsgAt = Date.now();

    const connect = () => {
      lastMsgAt = Date.now();
      ws = new WebSocket(BRIDGE_WS);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => {
        setWsConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (ev) => {
        lastMsgAt = Date.now();
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
            // Buffered — flushed by the 250ms interval, not rendered per read.
            pendingRows.current.unshift(row);
            pendingReadCount.current += 1;
            recentReadTimes.current.push(Date.now());
            seenRef.current.add(msg.epc);
            break;
          }
          case 'udp': {
            const row: UdpFrameRow = {
              id: idRef.current++,
              raw: msg.raw,
              len: msg.len,
              from: msg.from,
              parsed: msg.parsed,
              epc: msg.epc,
              timestamp: msg.timestamp,
            };
            setUdpFrames((prev) => [row, ...prev].slice(0, MAX_UDP_ROWS));
            break;
          }
          case 'entry':
          case 'exit': {
            const row: EntryRow = {
              id: idRef.current++,
              kind: msg.type,
              direction: msg.direction,
              method: msg.method,
              epc: msg.epc,
              known: msg.known,
              item: msg.item,
              location: msg.location,
              rssi: msg.rssi,
              antenna: msg.antenna,
              antennas: msg.antennas ?? [],
              reads: msg.reads ?? 0,
              timestamp: msg.timestamp,
            };
            setEntries((prev) => [row, ...prev].slice(0, 100));
            break;
          }
          case 'gpi': {
            // The bridge reports every beam poll (~5/s), changed or not.
            // Returning the same reference when nothing changed lets React
            // bail out of the re-render entirely.
            const { gpi1, gpi2, raw } = msg;
            setGpi((prev) => (prev.gpi1 === gpi1 && prev.gpi2 === gpi2 && prev.raw === raw ? prev : { gpi1, gpi2, raw }));
            break;
          }
          case 'ping':
            break; // keepalive — lastMsgAt already updated above
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
              udp: msg.udp,
            });
            if (msg.gpi) setGpi(msg.gpi);
            break;
          default:
            break;
        }
      };
    };

    connect();
    const watchdog = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMsgAt > 15_000) {
        ws.close(); // onclose schedules the reconnect
      }
    }, 5_000);
    return () => {
      closed = true;
      clearInterval(watchdog);
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return {
    wsConnected,
    status,
    rows,
    udpFrames,
    entries,
    gpi,
    totalReads,
    uniqueEpcs,
    readsPerSec,
    lastTriggerAt,
    clear,
  };
}
