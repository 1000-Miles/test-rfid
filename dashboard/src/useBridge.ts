import { useCallback, useEffect, useRef, useState } from 'react';
import { BRIDGE_WS } from './api';
import type { EntryRow, GpiState, Status, TagRow, UdpFrameRow, WsMsg } from './types';

const MAX_ROWS = 100;
const MAX_UDP_ROWS = 50;

/**
 * How often buffered telemetry (raw tag reads, UDP frames) is pushed into React
 * state. Reads arrive per antenna per tag — a pallet of cartons through the
 * gate is hundreds a second — and rendering each one individually is what makes
 * the wallboard fall behind: the TV spends the whole passage re-rendering a
 * table it does not even display, and the entry/exit updates that DO matter
 * queue up behind that work.
 *
 * Buffering bounds it at 4 renders/sec no matter how fast the reader goes. The
 * engineering console still receives every row, just in batches.
 *
 * Movements (entry/exit) are deliberately NOT buffered — they are rare, they
 * are the point of the board, and they must appear the instant they arrive.
 */
const TELEMETRY_FLUSH_MS = 250;

const sameGpi = (a: GpiState, b: GpiState) => a.gpi1 === b.gpi1 && a.gpi2 === b.gpi2 && a.raw === b.raw;

/**
 * Reconnect if the socket has been silent this long.
 *
 * `onclose` is not enough on its own. A WiFi drop, an access-point roam, or a
 * TV waking from sleep leaves the connection HALF-OPEN: the page stops
 * receiving, but no close and no error ever fire, so the reconnect logic never
 * runs. The board then sits there looking connected while movements pile up
 * unseen — the state where the only fix is reloading the page by hand.
 *
 * The bridge beats every 5s (WS_HEARTBEAT_MS) on top of ~5 GPI polls a second,
 * so on a healthy link something arrives constantly. Three missed beats is
 * therefore a dead link, not a quiet one.
 */
const WS_STALE_MS = 15_000;
const WS_WATCHDOG_MS = 3000;

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

  // Telemetry lands here first and is drained on a timer — see TELEMETRY_FLUSH_MS.
  const pendingTags = useRef<TagRow[]>([]);
  const pendingUdp = useRef<UdpFrameRow[]>([]);
  const pendingReads = useRef(0);
  const uniqueDirty = useRef(false);

  const clear = useCallback(() => {
    setRows([]);
    setUdpFrames([]);
    setEntries([]);
    setTotalReads(0);
    setUniqueEpcs(0);
    setReadsPerSec(0);
    seenRef.current = new Set();
    recentReadTimes.current = [];
    pendingTags.current = [];
    pendingUdp.current = [];
    pendingReads.current = 0;
    uniqueDirty.current = false;
  }, []);

  // Drain the telemetry buffers. Each branch is guarded so an idle gate does no
  // state work at all — an unconditional setState here would reintroduce the
  // very re-render storm the buffering exists to stop.
  useEffect(() => {
    const t = setInterval(() => {
      if (pendingTags.current.length) {
        const batch = pendingTags.current;
        pendingTags.current = [];
        // Buffer is oldest-first; the table is newest-first.
        batch.reverse();
        setRows((prev) => [...batch, ...prev].slice(0, MAX_ROWS));
      }
      if (pendingUdp.current.length) {
        const batch = pendingUdp.current;
        pendingUdp.current = [];
        batch.reverse();
        setUdpFrames((prev) => [...batch, ...prev].slice(0, MAX_UDP_ROWS));
      }
      if (pendingReads.current) {
        const n = pendingReads.current;
        pendingReads.current = 0;
        setTotalReads((x) => x + n);
      }
      if (uniqueDirty.current) {
        uniqueDirty.current = false;
        setUniqueEpcs(seenRef.current.size);
      }
    }, TELEMETRY_FLUSH_MS);
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
    let lastMsgAt = Date.now();

    const connect = () => {
      lastMsgAt = Date.now();
      ws = new WebSocket(BRIDGE_WS);
      ws.onopen = () => {
        lastMsgAt = Date.now();
        setWsConnected(true);
      };
      ws.onclose = () => {
        setWsConnected(false);
        if (!closed) retry = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws?.close();
      ws.onmessage = (ev) => {
        // Before parsing: ANY traffic proves the link is alive, even a message
        // this client does not understand.
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
            pendingTags.current.push(row);
            // Cap the buffer too: a reader left running while the page is in a
            // background tab can outpace the flush indefinitely.
            if (pendingTags.current.length > MAX_ROWS) pendingTags.current = pendingTags.current.slice(-MAX_ROWS);
            pendingReads.current += 1;
            recentReadTimes.current.push(Date.now());
            if (!seenRef.current.has(msg.epc)) {
              seenRef.current.add(msg.epc);
              uniqueDirty.current = true;
            }
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
            pendingUdp.current.push(row);
            if (pendingUdp.current.length > MAX_UDP_ROWS) pendingUdp.current = pendingUdp.current.slice(-MAX_UDP_ROWS);
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
              unexpected: msg.unexpected ?? null,
              basis: msg.basis ?? null,
              timestamp: msg.timestamp,
            };
            setEntries((prev) => [row, ...prev].slice(0, 100));
            break;
          }
          case 'gpi': {
            // The bridge polls the beams several times a second and reports
            // every poll, changed or not. Returning the SAME object when
            // nothing moved lets React bail out of the render entirely —
            // otherwise an idle gate repaints the whole board ~5x a second for
            // values that are identical each time.
            const next = { gpi1: msg.gpi1, gpi2: msg.gpi2, raw: msg.raw };
            setGpi((prev) => (sameGpi(prev, next) ? prev : next));
            break;
          }
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
            if (msg.gpi) setGpi((prev) => (sameGpi(prev, msg.gpi) ? prev : msg.gpi));
            break;
          default:
            break;
        }
      };
    };

    connect();

    // Watchdog. close() drives the existing onclose -> retry path rather than
    // opening a second socket, so there is only ever one reconnect mechanism.
    const watchdog = setInterval(() => {
      if (closed || !ws) return;
      if (Date.now() - lastMsgAt < WS_STALE_MS) return;
      if (ws.readyState === WebSocket.CONNECTING) return; // give the handshake its chance
      setWsConnected(false);
      ws.close();
    }, WS_WATCHDOG_MS);

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
