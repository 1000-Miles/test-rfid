/**
 * Gate board document model — receiving batches (inbound) with expected vs.
 * received carton counts.
 *
 * RECEIVING ONLY. Shipping is out of scope for this gate: the bridge does not
 * fetch shipments (see bridge/src/board.js), nothing outbound is rendered, and
 * an outbound passage is not counted here. `Direction` survives because the
 * bridge still STAMPS a direction on every passage — the board simply only
 * deals with the inbound half. Every filter that enforces that is marked
 * "receiving-only".
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE SEAM IS NOW WIRED. Today's board comes from real Nexus documents via
 * the bridge (`GET /board/documents`, see bridge/src/board.js), which proxies
 * the receiving-batch feed and caches the last good response so a doorway with
 * no WAN still shows a board.
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
import type { EntryRow, MovementFault } from './types';
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
  /** Stable key — the receiving batch ref. Never displayed. */
  id: string;
  /**
   * What the board shows as the document's name — the PO reference, which is
   * what staff and suppliers recognise; the batch ref it belongs to moves into
   * `meta`. Absent when the id is already the right label.
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
  /** Documents on today's board — inbound only; see the receiving-only note above. */
  docs: GateDoc[];
  /** Draft receiving batches not yet on today's board — the manual-add pool. */
  pool: GateDoc[];
  exceptions: GateException[];
  /**
   * `in:${epc}` for every passage already credited today, so one carton counts
   * once. The direction stays in the key even though only 'in' is ever written:
   * it is the stored shape of the v2 board, and dropping it would strand the
   * counts of any kiosk that reloads mid-shift.
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
  const feed: FeedResponse = await res.json();
  // Receiving-only: the bridge already asks Nexus for batches alone, and this is
  // the belt to that braces. One choke point means no view downstream has to
  // remember the rule — including a kiosk still talking to an older bridge, or
  // one serving a disk cache written when shipments were still fetched.
  return {
    ...feed,
    docs: (feed.docs ?? []).filter((d) => d.dir === 'in'),
    pool: (feed.pool ?? []).filter((d) => d.dir === 'in'),
  };
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

/**
 * Documents a passage may be credited against — WIDER than activeDocs.
 *
 * activeDocs answers "what belongs on today's screen". This answers "does this
 * carton have a home", which is not the same question: goods turn up early, and
 * a delivery that arrives ahead of its date is still that delivery. Refusing it
 * because of the calendar filed a real, expected carton as an exception and
 * left the batch looking short — the paperwork was right and the board argued
 * with it.
 *
 * Order is `due` ascending, so overdue still fills before due-today, and
 * due-today before anything scheduled later. Only the fallback changed, not the
 * priority.
 */
export const receivableDocs = (docs: GateDoc[], dir: Direction) => docs.filter((d) => d.dir === dir).sort((a, b) => a.due - b.due);

/* --------------------------------------------------------------- storage */

/**
 * How often the kiosk re-pulls documents.
 *
 * This is also the board's recovery time for anything the LOCAL count does not
 * credit — most obviously a repeat scan, which is suppressed here as a
 * duplicate but still counted by Nexus (see applyMovement). At 60s that
 * divergence read as "the board is broken, then fixes itself a minute later";
 * at 5s it closes almost immediately.
 *
 * The bridge caches board responses (BoardFeed.maxAgeMs) and MUST be kept below
 * this interval, or the extra polls just re-serve the same cached payload and
 * buy nothing. The two values are a pair — change one, change the other.
 */
const DOC_POLL_MS = 5_000;

/**
 * Longest a movement is held waiting for the first document fetch.
 *
 * The hold exists for one narrow case — see the cold-start branch in
 * useGateBoard — but it must never become a way to lose movements outright. If
 * the fetch hangs rather than failing, this releases what is held and lets it
 * fall through to the normal (exception) path, which is exactly what would have
 * happened without the hold.
 */
const COLD_START_HOLD_MAX_MS = 10_000;

/** Ceiling on held movements, so a stalled fetch can't grow the buffer forever. */
const MAX_DEFERRED = 200;

// v2: `counted` is now direction-scoped and the overlay moved from a
// docId-keyed credit map to a retiring `pending` list. v1 state is incompatible
// (its credits strand on the old batch id), so the bump discards it rather than
// migrating a half-day of counts.
// v3: `counted` entries are now PASSAGE-scoped (`in:EPC:passageId`), so a v2
// board's day-scoped `in:EPC` keys would go on blocking every re-read of a
// carton counted earlier today. They cannot be migrated — the passage they
// belonged to is not recorded — so the bump discards them, which is also the
// repair for any kiosk still holding a stale v2 board right now.
const STORAGE_KEY = 'gateBoard.v3';
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
          // Receiving-only: yesterday's build may have stored outbound docs.
          docs: saved.docs.filter((d) => d.dir === 'in'),
          pool: (saved.pool ?? []).filter((d) => d.dir === 'in'),
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
  const drained = feed.delivery?.queueDepth === 0;
  const delivered = drained ? Date.parse(feed.delivery?.lastPushAt ?? '') : NaN;
  const snapshot = feed.fetchedAt ? Date.parse(feed.fetchedAt) : NaN;
  //
  // Two ways an entry can retire, and the second one is why this had to change.
  //
  //  1. PROVEN — the outbox is empty, it pushed after we counted, and the
  //     server snapshot was taken after that push. Airtight when available.
  //
  //  2. DRAINED — the outbox is empty and the snapshot is newer than the credit.
  //     `lastPushAt` is a PER-PROCESS counter: it is null again after every
  //     bridge restart, even though the cursor proves the events went. So proof
  //     (1) becomes permanently unavailable to any credit taken before a
  //     restart, the entry strands, and the board adds it to Nexus's own figure
  //     FOREVER — one real carton showing as two, which is exactly what this
  //     produced. An empty queue at a moment after we counted means nothing we
  //     counted is still waiting.
  //
  const absorbed = (c: PendingCredit) => {
    if (!Number.isFinite(snapshot)) return false;
    if (Number.isFinite(delivered) && delivered >= c.at && snapshot >= delivered) return true;
    return drained && snapshot > c.at;
  };

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

/** What the board writes in the exceptions list for each fault the bridge stamps. */
const FAULT_NOTE: Record<MovementFault, string> = {
  'no-open-batch': 'Entered the warehouse with no open receiving batch',
  'not-received': 'Left the warehouse but was never received in',
  'already-shipped': 'Left the warehouse but is already marked shipped',
};

export type CountOutcome =
  | { kind: 'counted'; docId: string; dir: Direction; sku: string; name: string }
  /** A contested passage: filed as an exception, credited to nothing. */
  | { kind: 'fault'; tag: string; fault: MovementFault; message: string }
  | { kind: 'duplicate'; message: string }
  | { kind: 'complete'; message: string }
  | { kind: 'unknown'; tag: string }
  /**
   * A tag that resolves to nothing at all. Not filed, not flashed, not counted
   * — the board behaves as though it never passed. Distinct from 'unknown',
   * which is a REAL product that simply is not on an open batch, and still
   * deserves to be surfaced.
   */
  | { kind: 'ignored'; tag: string };

/**
 * Credit one gate movement to the best-matching open receiving batch line.
 * Pure: returns the next board plus what happened, so the UI can react.
 *
 * INBOUND ONLY — the caller filters outbound passages out (see useGateBoard).
 * An outbound entry reaching here would be credited against nothing and filed
 * as an exception, which is exactly the shipping noise a receiving-only board
 * must not show.
 */
export function applyMovement(state: BoardState, entry: EntryRow): { state: BoardState; outcome: CountOutcome } {
  const epc = entry.epc.toUpperCase();
  const dir: Direction = entry.direction;
  // The direction stays in the key for the stored board's sake (see
  // BoardState.counted); on a receiving-only gate it is always 'in'.
  // Scoped to the PASSAGE, not the day.
  //
  // This used to be `${dir}:${epc}` — one credit per carton per day — which made
  // a legitimate re-arrival impossible: a carton received, then un-received in
  // Nexus, then walked back through could never be counted again until midnight,
  // and every read came back "already received today" while the pallet and the
  // print showed it perfectly. The bridge ALREADY guarantees one event per tag
  // per physical passage (`_lastEventPassage`), so all this guard has to catch
  // is a replay of the same passage — banning the EPC for the rest of the day
  // was never what made it safe.
  //
  // Movements with no passage id keep the day-scoped key: they have no other
  // dedupe behind them, so the coarse guard is the only one they get.
  const countedKey = entry.passageId != null ? `${dir}:${epc}:${entry.passageId}` : `${dir}:${epc}`;

  const file = (tag: string, note: string): BoardState => ({
    ...state,
    exceptions: [{ id: Date.now() + Math.floor(Math.random() * 1000), tag, note, at: hhmm() }, ...state.exceptions].slice(0, 100),
  });

  // CONTESTED PASSAGE, checked before anything else.
  //
  // The bridge has already asked Nexus whether any live receiving batch is
  // waiting for this product, and been told no. That verdict outranks this
  // board because this board can be OUT OF DATE in a way the bridge is not:
  // `docs` is persisted to localStorage for the whole day, so a batch deleted
  // or archived in Nexus at noon is still sitting in a kiosk's stored board at
  // four — and a carton would be credited against a document that no longer
  // exists. The bridge re-reads the live feed every few seconds; it wins.
  //
  // Checked ahead of the duplicate guard for the same reason as ever: `counted`
  // exists to stop double-crediting, and letting it swallow a fault would mean
  // the second carton through the door went unremarked.
  const fault = entry.unexpected;
  if (fault) {
    const sku = resolveSku(entry);
    const tag = sku ? `${epc} · ${sku}` : epc;
    return { state: file(tag, FAULT_NOTE[fault]), outcome: { kind: 'fault', tag, fault, message: FAULT_NOTE[fault] } };
  }

  if (state.counted.includes(countedKey)) {
    const sku = resolveSku(entry);
    return { state, outcome: { kind: 'duplicate', message: sku ? `${sku} · already received today` : `${epc} · already received today` } };
  }

  const sku = resolveSku(entry);
  if (!sku) {
    // An EPC the catalogue cannot name. At a doorway this is mostly traffic
    // rather than stock — pallet wrap, returnable crates, a badge in someone's
    // pocket — so the board ignores it completely instead of raising a banner
    // and an exception nobody will reconcile. `state` is returned untouched.
    return { state, outcome: { kind: 'ignored', tag: epc } };
  }

  // Overdue first, then due-today, then future — see receivableDocs.
  const candidates = receivableDocs(state.docs, dir);
  const target = candidates.find((d) => d.lines.some((l) => l.sku === sku && l.received < l.expected));

  if (!target) {
    const onBoard = candidates.some((d) => d.lines.some((l) => l.sku === sku));
    if (onBoard) {
      return { state: { ...state, counted: [...state.counted, countedKey] }, outcome: { kind: 'complete', message: `${sku} · every open line already complete` } };
    }
    // No open document at all now means exactly that — not merely "not today".
    const tag = `${epc} · ${sku}`;
    return {
      state: file(tag, `${sku} is not on any open receiving batch`),
      outcome: { kind: 'unknown', tag },
    };
  }

  let creditedName = sku;
  const docs = state.docs.map((d) => {
    if (d.id !== target.id) return d;
    let done = false;
    return {
      ...d,
      // Receiving against a future-dated document promotes it to today. The
      // board only renders due <= 0, so without this the carton would be
      // counted onto a document the operator cannot see — a number moving
      // somewhere off screen, which is worse than not counting it.
      due: d.due > 0 ? 0 : d.due,
      meta: d.due > 0 ? `Received early · ${hhmm()}` : d.meta,
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
  /**
   * Latest counted movement — the board follows this to the product that was
   * just credited. `sku` is null only for a manual board addition, which has a
   * document but no particular line to point at.
   */
  lastCounted: { docId: string; sku: string | null; name: string | null; dir: Direction; seq: number } | null;
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
/**
 * @param onOutcome Fired for every movement the board resolves, with what it
 *   decided. The audio lives at the call site rather than here because only
 *   this hook knows whether a passage was actually credited to a document —
 *   `known` (the bridge catalogue) is a different question, and chiming on it
 *   meant every stray tag in the building made a noise.
 */
/**
 * @param receivingResetAt Bridge timestamp of the last receiving reset in Nexus
 *   (see BridgeState.receivingResetAt). When it CHANGES, this board drops the
 *   credits it is holding — see the effect below.
 */
export function useGateBoard(
  entries: EntryRow[],
  onOutcome?: (outcome: CountOutcome) => void,
  receivingResetAt?: string | null
): GateBoardApi {
  const [board, setBoard] = useState<BoardState>(loadBoard);
  const [lastCounted, setLastCounted] = useState<GateBoardApi['lastCounted']>(null);
  const [dupMsg, setDupMsg] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedState>({ status: 'loading', fetchedAt: null, error: null });

  // Highest EntryRow.id already folded into the board — ids increase monotonically.
  const appliedTo = useRef(-1);
  const seq = useRef(0);
  // Mirror of `board`, so a burst of movements folds in without waiting for re-render.
  const current = useRef(board);
  // Guards against overlapping fetches when the bridge is slower than the poll.
  const inFlight = useRef(false);
  // Movements that crossed the gate before the first document fetch answered,
  // plus whether that fetch has finished (either way).
  const deferred = useRef<EntryRow[]>([]);
  const firstLoadSettled = useRef(false);
  const commit = useCallback((next: BoardState) => {
    current.current = next;
    setBoard(next);
  }, []);

  useEffect(() => saveBoard(board), [board]);

  /** Surface what a batch of movements did — the toast, the flash, the follow. */
  // Held in a ref so `announce` keeps its empty dep list — a caller passing an
  // inline arrow must not rebuild the whole movement pipeline on every render.
  const onOutcomeRef = useRef(onOutcome);
  onOutcomeRef.current = onOutcome;

  const announce = useCallback((outcomes: CountOutcome[]) => {
    for (const outcome of outcomes) {
      onOutcomeRef.current?.(outcome);
      if (outcome.kind === 'counted') setLastCounted({ docId: outcome.docId, sku: outcome.sku, name: outcome.name, dir: outcome.dir, seq: ++seq.current });
      else if (outcome.kind === 'duplicate' || outcome.kind === 'complete') setDupMsg(outcome.message);
      // 'ignored', 'unknown' and 'fault' show NOTHING on this board, on purpose.
      //
      // This board is the list of work someone is standing there doing, and the
      // only thing that belongs on it is a carton that lands on a document. The
      // three silent cases are all "not that", and all common: unnameable tags
      // are doorway traffic (pallet wrap, returnable crates, a badge in a
      // pocket), and a product on no open batch is stock nobody here booked.
      // Each used to throw a full-screen red flash, which made the board cry
      // wolf all day over things no operator at the door can act on.
      //
      // They are not lost. Every one is journaled by the bridge and delivered to
      // Nexus, filed into `exceptions` here, logged by the bridge, and a
      // contested passage is still stamped on the TV wallboard — see TvBoard.
    }
  }, []);

  /** Fold a batch of movements into the board, in the order they happened. */
  const fold = useCallback(
    (ordered: EntryRow[]) => {
      if (!ordered.length) return;
      let next = current.current;
      const outcomes: CountOutcome[] = [];
      for (const entry of ordered) {
        const result = applyMovement(next, entry);
        next = result.state;
        outcomes.push(result.outcome);
      }
      commit(next);
      announce(outcomes);
    },
    [commit, announce]
  );

  /** Release anything held during the cold start. Safe to call more than once. */
  const releaseDeferred = useCallback(() => {
    const held = deferred.current;
    deferred.current = [];
    fold(held);
  }, [fold]);

  useEffect(() => {
    const fresh = entries.filter((e) => e.id > appliedTo.current);
    if (fresh.length === 0) return;
    // The high-water mark advances over outbound passages too, so skipping one
    // is final rather than a movement that gets reconsidered on every render.
    appliedTo.current = Math.max(...fresh.map((e) => e.id));
    // entries arrive newest-first; replay them in the order they happened.
    // Receiving-only: an outbound passage is still stamped, journalled and
    // pushed to Nexus by the bridge — the board just takes no part in it.
    const ordered = [...fresh].reverse().filter((e) => e.direction === 'in');
    if (ordered.length === 0) return;

    // COLD START. With no documents yet there is no line to credit, so a
    // movement here would be filed as "not expected today" and stay that way —
    // applyMovement has no memory, and this entry id is never revisited. Hold it
    // until the cards exist instead.
    //
    // Only when the board is genuinely empty: a reload restores docs from
    // localStorage, and delaying those movements would add latency to the
    // common path to fix a case that cannot occur there.
    if (!firstLoadSettled.current && current.current.docs.length === 0) {
      deferred.current.push(...ordered);
      if (deferred.current.length > MAX_DEFERRED) deferred.current = deferred.current.slice(-MAX_DEFERRED);
      return;
    }

    fold(ordered);
  }, [entries, fold]);

  // Backstop: release on a timer if the first fetch neither resolves nor
  // rejects. Holding forever would turn a hung request into lost movements,
  // which is worse than the misfiling this whole mechanism exists to prevent.
  useEffect(() => {
    const t = setTimeout(() => {
      if (firstLoadSettled.current) return;
      firstLoadSettled.current = true;
      releaseDeferred();
    }, COLD_START_HOLD_MAX_MS);
    return () => clearTimeout(t);
  }, [releaseDeferred]);

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
      setLastCounted({ docId, sku: null, name: null, dir: 'in', seq: ++seq.current });
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
      // Clear FIRST, before the network. "Reset day" is the button someone
      // presses precisely when things are wrong — which is exactly when the
      // bridge may also be unreachable — and this used to live after the fetch,
      // inside the try, so a failed request left every count in place and the
      // button silently did nothing.
      if (!keepCredits) commit({ ...current.current, counted: [], exceptions: [], pending: [] });
      try {
        const res = await fetchDocuments();
        indexSimSkus(res.docs, res.pool);
        commit(mergeFeed(current.current, res.docs, res.pool, res));
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
        // Whatever the outcome, the cold start is over: on success the cards are
        // now in place and the held movements land on them; on failure they take
        // the same exception path they would have taken anyway. Held movements
        // are never silently dropped.
        if (!firstLoadSettled.current) {
          firstLoadSettled.current = true;
          releaseDeferred();
        }
      }
    },
    [commit, releaseDeferred]
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

  // Nexus reset the receiving, so this board's counts are about cartons Nexus
  // no longer considers received. Drop them and re-pull.
  //
  // The document poll cannot discover this on its own: it sees `received` fall
  // to 0 and simply re-applies the local overlay on top, so the board keeps
  // showing counts for a batch that was emptied — and every carton walked back
  // through answers "already received today". The bridge is the only party that
  // notices the withdrawal, which is why this arrives as a signal rather than a
  // number.
  //
  // Skips the first run: a null-to-value change on mount is just the socket
  // reporting the last reset, not a new one.
  const seenReset = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const previous = seenReset.current;
    seenReset.current = receivingResetAt ?? null;
    if (previous === undefined || !receivingResetAt || previous === receivingResetAt) return;
    void load({ keepCredits: false });
  }, [receivingResetAt, load]);

  const refresh = useCallback(() => void load(), [load]);

  const resetDay = useCallback(() => {
    setLastCounted(null);
    setDupMsg(null);
    void load({ keepCredits: false });
  }, [load]);

  return { board, lastCounted, dupMsg, addFromPool, clearExceptions, refresh, resetDay, feed };
}
