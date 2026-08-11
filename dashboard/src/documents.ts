/**
 * Gate board document model — receiving batches (inbound) and shipments
 * (outbound) with expected vs. received carton counts.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SEAM IS NOW WIRED. Today's board comes from real Nexus documents via
 * the bridge (`GET /board/documents`, see bridge/src/board.js), which proxies
 * the receiving-batch and shipment feeds and caches the last good response so
 * a doorway with no WAN still shows a board.
 *
 * Inbound documents are RECEIVING BATCHES, not POs. Cartons have no foreign
 * key to a purchase order in Nexus, so the batch is the only document a carton
 * can honestly be credited against; the batch's PO refs ride along as metadata.
 *
 * Counting is LOCAL FIRST, then reconciled. A gate passage is credited here the
 * instant the reader sees it, so the doorway never waits on the network. The
 * bridge's outbox delivers the movement in the background, and Nexus now counts
 * an inbound passage into operations_receiving_line just as a handheld scan
 * does (see recordGateMovementCore / creditReceivingBatch).
 *
 * Because both sides now count, the local credit is PROVISIONAL: it is held in
 * `pending` and retires as soon as the server's own figure demonstrably
 * includes it. Holding it any longer would double-count; dropping it any
 * earlier would make a counted carton disappear from the board.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntryRow } from './types';
import { BRIDGE_HTTP } from './api';

export type Direction = 'in' | 'out';

export interface DocLine {
  sku: string;
  name: string;
  expected: number;
  received: number;
  /** Product photo, resolved by Nexus from the linked idea's icon_image_url. */
  photoUrl?: string | null;
  /** Emoji fallback when there's no photo yet — same precedence Nexus itself uses. */
  emoji?: string | null;
  /** Units per carton, when Nexus can derive it — lets the tile show unit qty alongside carton counts. */
  unitsPerCarton?: number | null;
}

/** Total units for a line's received/expected carton counts, or null if unitsPerCarton is unknown. */
export const lineUnits = (line: DocLine): { received: number; expected: number } | null =>
  line.unitsPerCarton ? { received: line.received * line.unitsPerCarton, expected: line.expected * line.unitsPerCarton } : null;

export interface GateDoc {
  /** Stable key — the receiving batch ref or shipment ref. Never displayed. */
  id: string;
  /**
   * What the board shows as the document's name. For inbound this is the PO
   * reference, which is what staff and suppliers recognise; the batch ref it
   * belongs to moves into `meta`. Absent on documents whose id is already the
   * right label (shipments).
   */
  title?: string;
  dir: Direction;
  party: string;
  meta: string;
  /** Days relative to today: -1 = overdue since yesterday, 0 = due today, 1+ = future. */
  due: number;
  lines: DocLine[];
}

export interface GateException {
  id: number;
  tag: string;
  note: string;
  at: string;
}

export interface BoardState {
  /** Documents on today's board (both directions). */
  docs: GateDoc[];
  /** Draft receiving batches not yet on today's board — the manual-add pool. */
  pool: GateDoc[];
  exceptions: GateException[];
  /**
   * `${direction}:${epc}` for every passage already credited today, so one
   * carton counts once per direction. Keyed WITH the direction because a carton
   * received this morning and shipped this afternoon is two real events — an
   * EPC-only key would silently swallow the second.
   */
  counted: string[];
  /**
   * Passages counted here but not yet reflected in Nexus's own numbers.
   *
   * This is the offline-first overlay: the board credits a carton the instant
   * the gate sees it, while the bridge's outbox delivers the movement in the
   * background. Nexus now counts gate passages too, so each entry must RETIRE
   * once Nexus has absorbed it — otherwise the same carton would be counted
   * twice, once in the server figure and once here.
   */
  pending: PendingCredit[];
}

/** One locally-counted passage awaiting confirmation from Nexus. */
export interface PendingCredit {
  epc: string;
  docId: string;
  sku: string;
  /** ms epoch when the gate counted it — compared against the feed's snapshot. */
  at: number;
}

/** Where the current documents came from, for the "stale board" warning. */
export interface FeedState {
  status: 'loading' | 'live' | 'stale' | 'error';
  fetchedAt: string | null;
  error: string | null;
}

/* ------------------------------------------------------------------ feed */

export const emptyBoard = (): BoardState => ({ docs: [], pool: [], exceptions: [], counted: [], pending: [] });

interface FeedResponse {
  ok: boolean;
  stale: boolean;
  source: string;
  error?: string;
  docs: GateDoc[];
  pool: GateDoc[];
  fetchedAt: string | null;
  /** Outbox state at fetch time — how the overlay knows what Nexus has. */
  delivery?: { queueDepth: number; lastPushAt: string | null };
}

/**
 * Today's documents from the bridge. The bridge — not the browser — holds the
 * Nexus device token and the offline cache, so this is a plain unauthenticated
 * call to a service on the same machine.
 */
export async function fetchDocuments(): Promise<FeedResponse> {
  const res = await fetch(`${BRIDGE_HTTP}/board/documents`);
  if (!res.ok) throw new Error(`bridge /board/documents -> HTTP ${res.status}`);
  return res.json();
}

/* -------------------------------------------------------- EPC resolution */

/**
 * Simulator tag block. Real gate reads resolve through the bridge's catalogue
 * (operations_label_tag); this block only exists so the engineering console can
 * fire believable reads for a SKU that has no physical tag to hand.
 *
 * The SKU list is derived from whatever documents are currently loaded rather
 * than from a fixed table, so the simulator follows the live board. `AA00` +
 * a 20-hex counter matches the bridge's own test-label format
 * (bridge/src/printer/zpl.js `testEpc`); each SKU owns 100 counters starting at
 * (index+1)*100, leaving 1–99 free for throwaway test prints.
 */
const EPCS_PER_SKU = 100;

let simSkus: string[] = [];
let simEpcToSku: Record<string, string> = {};

export function simEpc(skuIndex: number, copy: number): string {
  const counter = (skuIndex + 1) * EPCS_PER_SKU + copy;
  return 'AA00' + counter.toString(16).toUpperCase().padStart(20, '0');
}

/** Rebuild the simulator's EPC block whenever the loaded documents change. */
function indexSimSkus(docs: GateDoc[], pool: GateDoc[]) {
  const seen: string[] = [];
  for (const d of [...docs, ...pool]) for (const l of d.lines) if (l.sku && !seen.includes(l.sku)) seen.push(l.sku);
  seen.sort();
  simSkus = seen;
  simEpcToSku = {};
  seen.forEach((sku, i) => {
    for (let c = 0; c < EPCS_PER_SKU; c++) simEpcToSku[simEpc(i, c)] = sku;
  });
}

/** Every simulator EPC for a SKU — the engineering console fires these. */
export function demoEpcsFor(sku: string): string[] {
  const i = simSkus.indexOf(sku);
  if (i < 0) return [];
  return Array.from({ length: EPCS_PER_SKU }, (_, c) => simEpc(i, c));
}

/**
 * Gate read -> SKU. The bridge catalogue wins; the simulator block is only a
 * fallback for tags the catalogue has never seen.
 */
export function resolveSku(entry: EntryRow): string | null {
  if (entry.known && entry.item?.sku) return entry.item.sku;
  return simEpcToSku[entry.epc.toUpperCase()] ?? null;
}

/* ------------------------------------------------------------- selectors */

export const docTotals = (doc: GateDoc) =>
  doc.lines.reduce((a, l) => ({ received: a.received + l.received, expected: a.expected + l.expected }), { received: 0, expected: 0 });

export const sumTotals = (docs: GateDoc[]) =>
  docs.reduce(
    (a, d) => {
      const t = docTotals(d);
      return { received: a.received + t.received, expected: a.expected + t.expected };
    },
    { received: 0, expected: 0 }
  );

export const pct = (received: number, expected: number) => (expected ? Math.round((received / expected) * 100) : 0);

/** The label to print on screen for a document — PO ref inbound, ref otherwise. */
export const docTitle = (doc: GateDoc) => doc.title || doc.id;

/** Today's board for one direction: overdue first, then due today. */
export const activeDocs = (docs: GateDoc[], dir: Direction) =>
  docs.filter((d) => d.dir === dir && d.due <= 0).sort((a, b) => (a.due < 0 ? 0 : 1) - (b.due < 0 ? 0 : 1));

/* --------------------------------------------------------------- storage */

/**
 * How often the kiosk re-pulls documents. 60s is well inside the time it takes
 * anyone to walk a new batch to the door, and it is two cheap reads against
 * Nexus per minute per screen.
 */
const DOC_POLL_MS = 60_000;

// v2: `counted` is now direction-scoped and the overlay moved from a
// docId-keyed credit map to a retiring `pending` list. v1 state is incompatible
// (its credits strand on the old batch id), so the bump discards it rather than
// migrating a half-day of counts.
const STORAGE_KEY = 'gateBoard.v2';
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Last session's board, if it is still today's. Used for instant paint on
 * reload; the live feed replaces it as soon as it answers. Returns an empty
 * board on a new day so yesterday's counts never linger.
 */
function loadBoard(): BoardState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as BoardState & { date: string };
      if (saved.date === today() && Array.isArray(saved.docs)) {
        return {
          docs: saved.docs,
          pool: saved.pool ?? [],
          exceptions: saved.exceptions ?? [],
          counted: saved.counted ?? [],
          pending: saved.pending ?? [],
        };
      }
    }
  } catch {
    /* corrupt or unavailable storage — fall through to an empty board */
  }
  return emptyBoard();
}

export const lineKey = (docId: string, sku: string) => `${docId}::${sku}`;

/**
 * Fold freshly fetched documents into the working board.
 *
 * Nexus counts are the BASELINE and this gate's counts are an OVERLAY, summed
 * on top. A gate passage is never written back into operations_receiving_line,
 * so without the overlay every refresh would wipe the cartons the door has
 * counted today.
 *
 * Summing (rather than taking the higher of the two) is what makes a poll safe
 * to run repeatedly: the local contribution is tracked separately, so the total
 * follows Nexus up AND down. If someone un-receives a carton in Nexus, the
 * board drops by one instead of freezing at the old high-water mark.
 */
function mergeFeed(prev: BoardState, docs: GateDoc[], pool: GateDoc[], feed: FeedResponse): BoardState {
  // Retire the overlay entries Nexus has already absorbed. Three conditions,
  // all required:
  //   1. the outbox has nothing queued        — everything we counted was sent
  //   2. delivery happened after we counted   — this passage specifically was sent
  //   3. the snapshot was taken after delivery — the server figure includes it
  // If ANY is unmet the entry stays, so an undelivered passage keeps showing.
  // Erring toward keeping it means a brief over-count at worst; dropping it
  // early would make a real carton vanish from the board.
  const delivered = feed.delivery && feed.delivery.queueDepth === 0 ? Date.parse(feed.delivery.lastPushAt ?? '') : NaN;
  const snapshot = feed.fetchedAt ? Date.parse(feed.fetchedAt) : NaN;
  const absorbed = (c: PendingCredit) =>
    Number.isFinite(delivered) && Number.isFinite(snapshot) && delivered >= c.at && snapshot >= delivered;

  const pending = prev.pending.filter((c) => !absorbed(c));

  const overlay = new Map<string, number>();
  for (const c of pending) {
    const k = lineKey(c.docId, c.sku);
    overlay.set(k, (overlay.get(k) ?? 0) + 1);
  }

  return {
    ...prev,
    pending,
    pool,
    docs: docs.map((d) => ({
      ...d,
      lines: d.lines.map((l) => ({ ...l, received: l.received + (overlay.get(lineKey(d.id, l.sku)) ?? 0) })),
    })),
  };
}

function saveBoard(state: BoardState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ date: today(), ...state }));
  } catch {
    /* private mode / quota — the board still works, it just won't survive a reload */
  }
}

/* ------------------------------------------------------------- counting */

const hhmm = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export type CountOutcome =
  | { kind: 'counted'; docId: string; dir: Direction; sku: string; name: string }
  | { kind: 'duplicate'; message: string }
  | { kind: 'complete'; message: string }
  | { kind: 'unknown'; tag: string };

/**
 * Credit one gate movement to the best-matching open document line.
 * Pure: returns the next board plus what happened, so the UI can react.
 */
export function applyMovement(state: BoardState, entry: EntryRow): { state: BoardState; outcome: CountOutcome } {
  const epc = entry.epc.toUpperCase();
  const dir: Direction = entry.direction;
  // Direction is part of the key: the same carton legitimately passes IN in the
  // morning and OUT in the afternoon, and an EPC-only key would drop the second
  // as a duplicate.
  const countedKey = `${dir}:${epc}`;

  if (state.counted.includes(countedKey)) {
    const sku = resolveSku(entry);
    const what = dir === 'in' ? 'received' : 'shipped';
    return { state, outcome: { kind: 'duplicate', message: sku ? `${sku} · already ${what} today` : `${epc} · already ${what} today` } };
  }

  const sku = resolveSku(entry);
  if (!sku) {
    const exception: GateException = { id: Date.now() + Math.floor(Math.random() * 1000), tag: epc, note: 'No matching PO or shipment on today’s board', at: hhmm() };
    return { state: { ...state, exceptions: [exception, ...state.exceptions].slice(0, 100) }, outcome: { kind: 'unknown', tag: epc } };
  }

  // Overdue documents get filled first, then due-today, in board order.
  const candidates = activeDocs(state.docs, dir);
  const target = candidates.find((d) => d.lines.some((l) => l.sku === sku && l.received < l.expected));

  if (!target) {
    const onBoard = candidates.some((d) => d.lines.some((l) => l.sku === sku));
    if (onBoard) {
      return { state: { ...state, counted: [...state.counted, countedKey] }, outcome: { kind: 'complete', message: `${sku} · every open line already complete` } };
    }
    const exception: GateException = { id: Date.now() + Math.floor(Math.random() * 1000), tag: `${epc} · ${sku}`, note: `${sku} is not expected ${dir === 'in' ? 'inbound' : 'outbound'} today`, at: hhmm() };
    return { state: { ...state, exceptions: [exception, ...state.exceptions].slice(0, 100) }, outcome: { kind: 'unknown', tag: `${epc} · ${sku}` } };
  }

  let creditedName = sku;
  const docs = state.docs.map((d) => {
    if (d.id !== target.id) return d;
    let done = false;
    return {
      ...d,
      lines: d.lines.map((l) => {
        if (done || l.sku !== sku || l.received >= l.expected) return l;
        done = true;
        creditedName = l.name;
        return { ...l, received: l.received + 1 };
      }),
    };
  });

  return {
    state: {
      ...state,
      docs,
      counted: [...state.counted, countedKey],
      // Records the increment as PROVISIONAL. It keeps the board correct across
      // refreshes while the outbox is still delivering, and retires itself once
      // Nexus's own figure includes this passage (see mergeFeed).
      pending: [...state.pending, { epc, docId: target.id, sku, at: Date.now() }],
    },
    outcome: { kind: 'counted', docId: target.id, dir, sku, name: creditedName },
  };
}

/* ------------------------------------------------------------------ hook */

export interface GateBoardApi {
  board: BoardState;
  /** Latest counted movement — the board follows this into the live view. */
  lastCounted: { docId: string; dir: Direction; seq: number } | null;
  /** Unknown tag banner text, cleared automatically. */
  flashTag: string | null;
  /** "Already counted" toast text, cleared automatically. */
  dupMsg: string | null;
  addFromPool: (docId: string) => void;
  clearExceptions: () => void;
  /** Re-pull today's documents, keeping passages Nexus has not yet absorbed. */
  refresh: () => void;
  /** Drop local counts and exceptions, then re-pull the documents. */
  resetDay: () => void;
  /** Whether the shown documents are live, cached, or failed to load. */
  feed: FeedState;
}

/** Drives today's board off the bridge's entry/exit stream. */
export function useGateBoard(entries: EntryRow[]): GateBoardApi {
  const [board, setBoard] = useState<BoardState>(loadBoard);
  const [lastCounted, setLastCounted] = useState<GateBoardApi['lastCounted']>(null);
  const [flashTag, setFlashTag] = useState<string | null>(null);
  const [dupMsg, setDupMsg] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedState>({ status: 'loading', fetchedAt: null, error: null });

  // Highest EntryRow.id already folded into the board — ids increase monotonically.
  const appliedTo = useRef(-1);
  const seq = useRef(0);
  // Mirror of `board`, so a burst of movements folds in without waiting for re-render.
  const current = useRef(board);
  // Guards against overlapping fetches when the bridge is slower than the poll.
  const inFlight = useRef(false);
  const commit = useCallback((next: BoardState) => {
    current.current = next;
    setBoard(next);
  }, []);

  useEffect(() => saveBoard(board), [board]);

  useEffect(() => {
    const fresh = entries.filter((e) => e.id > appliedTo.current);
    if (fresh.length === 0) return;
    appliedTo.current = Math.max(...fresh.map((e) => e.id));

    // entries arrive newest-first; replay them in the order they happened
    let next = current.current;
    const outcomes: CountOutcome[] = [];
    for (const entry of [...fresh].reverse()) {
      const result = applyMovement(next, entry);
      next = result.state;
      outcomes.push(result.outcome);
    }
    commit(next);

    for (const outcome of outcomes) {
      if (outcome.kind === 'counted') setLastCounted({ docId: outcome.docId, dir: outcome.dir, seq: ++seq.current });
      else if (outcome.kind === 'unknown') setFlashTag(outcome.tag);
      else setDupMsg(outcome.message);
    }
  }, [entries, commit]);

  useEffect(() => {
    if (!flashTag) return;
    const t = setTimeout(() => setFlashTag(null), 2600);
    return () => clearTimeout(t);
  }, [flashTag]);

  useEffect(() => {
    if (!dupMsg) return;
    const t = setTimeout(() => setDupMsg(null), 2400);
    return () => clearTimeout(t);
  }, [dupMsg]);

  const addFromPool = useCallback(
    (docId: string) => {
      const prev = current.current;
      const doc = prev.pool.find((p) => p.id === docId);
      if (!doc) return;
      commit({
        ...prev,
        docs: [...prev.docs, { ...doc, due: 0, meta: `Added manually · ${hhmm()}` }],
        pool: prev.pool.filter((p) => p.id !== docId),
      });
      setLastCounted({ docId, dir: 'in', seq: ++seq.current });
    },
    [commit]
  );

  const clearExceptions = useCallback(() => commit({ ...current.current, exceptions: [] }), [commit]);

  /**
   * Pull today's documents.
   *   keepCredits: false — also drop this gate's local counts ("reset day").
   *   silent: true       — a background poll; don't flip the chip to LOADING,
   *                        so an unattended kiosk isn't visibly flickering
   *                        every minute.
   */
  const load = useCallback(
    async ({ keepCredits = true, silent = false } = {}) => {
      if (inFlight.current) return; // never let polls stack up behind a slow bridge
      inFlight.current = true;
      if (!silent) setFeed((f) => ({ ...f, status: 'loading' }));
      try {
        const res = await fetchDocuments();
        indexSimSkus(res.docs, res.pool);
        const base = keepCredits ? current.current : { ...current.current, counted: [], exceptions: [], pending: [] };
        commit(mergeFeed(base, res.docs, res.pool, res));
        setFeed({
          status: res.ok ? (res.stale ? 'stale' : 'live') : 'error',
          fetchedAt: res.fetchedAt,
          error: res.error ?? null,
        });
      } catch (err) {
        // The bridge itself is unreachable — keep showing the last board rather
        // than blanking a screen someone is working against.
        setFeed({ status: 'error', fetchedAt: null, error: err instanceof Error ? err.message : 'load failed' });
      } finally {
        inFlight.current = false;
      }
    },
    [commit]
  );

  // A document created in Nexus mid-shift has to reach a kiosk nobody is
  // touching, so the board polls instead of waiting for a reload. Polling is
  // safe because unabsorbed passages live in `pending` and re-apply every merge.
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.hidden) return; // a background tab is nobody's dashboard
      void load({ silent: true });
    }, DOC_POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const refresh = useCallback(() => void load(), [load]);

  const resetDay = useCallback(() => {
    setLastCounted(null);
    setFlashTag(null);
    setDupMsg(null);
    void load({ keepCredits: false });
  }, [load]);

  return { board, lastCounted, flashTag, dupMsg, addFromPool, clearExceptions, refresh, resetDay, feed };
}
