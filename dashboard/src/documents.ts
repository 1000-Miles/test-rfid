/**
 * Gate board document model — POs (inbound) and shipments (outbound) with
 * expected vs. received carton counts.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS THE SEAM. The bridge has no notion of purchase orders or
 * shipments — it only reports EPC movements (see bridge/src/nexus.js). Until
 * a real document feed exists, today's board is seeded locally by
 * `seedBoard()` below and kept in localStorage for the working day.
 *
 * To plug in real data later, replace exactly two things:
 *   1. `seedBoard()`  — fetch today's open POs / shipments from Nexus.
 *   2. `resolveSku()` — map a gate read to a catalogue SKU.
 * Everything else (counting, dedup, exceptions, the UI) stays as-is.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EntryRow } from './types';

export type Direction = 'in' | 'out';

export interface DocLine {
  sku: string;
  name: string;
  expected: number;
  received: number;
  /** Optional product photo. Real feeds can supply one; the tile falls back to an icon. */
  photoUrl?: string;
}

export interface GateDoc {
  id: string;
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
  /** Open POs not yet on today's board — the manual-add pool. */
  pool: GateDoc[];
  exceptions: GateException[];
  /** EPCs already credited today, so one physical carton counts once. */
  counted: string[];
}

/* ------------------------------------------------------------------ seed */

const L = (sku: string, name: string, expected: number): DocLine => ({ sku, name, expected, received: 0 });

export function seedBoard(): BoardState {
  const docs: GateDoc[] = [
    {
      id: 'PO-24802', dir: 'in', party: 'Shantou Lianhe Plastics', meta: 'ETA 16:00', due: -1,
      lines: [L('PC-2288', 'Temp Tattoo Sheet 50', 18), L('PC-2290', 'Sticker Roll 500', 14), L('PC-2240', 'Pop-It Fidget Tray', 20)],
    },
    {
      id: 'PO-24817', dir: 'in', party: 'Ningbo Sunrise Crafts', meta: 'ETA 09:30', due: 0,
      lines: [
        L('BS-1042', 'Sticker Dress-Up Book', 24), L('BS-1077', 'Glitter Gel Pen Set 24', 18),
        L('PC-2201', 'LED Slime Jar 6pk', 12), L('BS-1188', 'Nail Art Studio Kit', 16),
        L('PC-2240', 'Pop-It Fidget Tray', 30), L('BS-1310', 'Scratch Art Kit A4', 20),
      ],
    },
    {
      id: 'PO-24823', dir: 'in', party: 'Yiwu Bright Toys', meta: 'ETA 11:00', due: 0,
      lines: [
        L('PR-3301', 'Mini Claw Machine', 10), L('PR-3318', 'Bubble Wand Sword', 24),
        L('LD-4402', 'Plush Kitten 20cm', 18), L('LD-4419', 'Unicorn Water Bottle 500ml', 22),
        L('PR-3350', 'Wooden Puzzle Cube', 14),
      ],
    },
    {
      id: 'PO-24831', dir: 'in', party: 'Guangzhou Paperworks', meta: 'ETA 14:15', due: 0,
      lines: [
        L('BS-1401', 'Foil Balloon Set 12', 26), L('BS-1425', 'Party Loot Bag 20pk', 30),
        L('PC-2288', 'Temp Tattoo Sheet 50', 12), L('PC-2290', 'Sticker Roll 500', 16),
      ],
    },
    {
      id: 'SH-9036', dir: 'out', party: 'Costco Depot 118', meta: 'Pickup 08:00', due: -1,
      lines: [L('BS-1425', 'Party Loot Bag 20pk', 24), L('PC-2288', 'Temp Tattoo Sheet 50', 16)],
    },
    {
      id: 'SH-9042', dir: 'out', party: 'Amazon FBA — ONT8', meta: 'Pickup 15:00', due: 0,
      lines: [
        L('BS-1042', 'Sticker Dress-Up Book', 20), L('LD-4402', 'Plush Kitten 20cm', 16),
        L('PC-2240', 'Pop-It Fidget Tray', 24), L('BS-1188', 'Nail Art Studio Kit', 12),
        L('PR-3318', 'Bubble Wand Sword', 18),
      ],
    },
    {
      id: 'SH-9047', dir: 'out', party: 'Walmart DC 6094', meta: 'Pickup 16:30', due: 0,
      lines: [
        L('BS-1401', 'Foil Balloon Set 12', 22), L('PC-2201', 'LED Slime Jar 6pk', 14),
        L('BS-1310', 'Scratch Art Kit A4', 18), L('LD-4419', 'Unicorn Water Bottle 500ml', 20),
      ],
    },
    {
      id: 'SH-9051', dir: 'out', party: 'BSCOOL DTC Pallet', meta: 'Pickup 17:45', due: 0,
      lines: [L('BS-1077', 'Glitter Gel Pen Set 24', 12), L('PC-2290', 'Sticker Roll 500', 10), L('PR-3350', 'Wooden Puzzle Cube', 8)],
    },
  ];

  const pool: GateDoc[] = [
    {
      id: 'PO-24844', dir: 'in', party: 'Yiwu Bright Toys', meta: 'Ordered 21 Jul · 4 lines · 68 cartons', due: 0,
      lines: [L('PR-3301', 'Mini Claw Machine', 18), L('PR-3318', 'Bubble Wand Sword', 20), L('LD-4402', 'Plush Kitten 20cm', 16), L('PR-3350', 'Wooden Puzzle Cube', 14)],
    },
    {
      id: 'PO-24839', dir: 'in', party: 'Shantou Lianhe Plastics', meta: 'Ordered 18 Jul · 3 lines · 54 cartons', due: 0,
      lines: [L('PC-2240', 'Pop-It Fidget Tray', 24), L('PC-2201', 'LED Slime Jar 6pk', 18), L('PC-2288', 'Temp Tattoo Sheet 50', 12)],
    },
    {
      id: 'PO-24836', dir: 'in', party: 'Ningbo Sunrise Crafts', meta: 'Ordered 16 Jul · 3 lines · 60 cartons', due: 0,
      lines: [L('BS-1042', 'Sticker Dress-Up Book', 26), L('BS-1310', 'Scratch Art Kit A4', 20), L('BS-1188', 'Nail Art Studio Kit', 14)],
    },
    {
      id: 'PO-24828', dir: 'in', party: 'Guangzhou Paperworks', meta: 'Ordered 12 Jul · 2 lines · 44 cartons', due: 0,
      lines: [L('BS-1425', 'Party Loot Bag 20pk', 28), L('PC-2290', 'Sticker Roll 500', 16)],
    },
    {
      id: 'PO-24815', dir: 'in', party: 'Shantou Lianhe Plastics', meta: 'Ordered 07 Jul · 2 lines · 36 cartons', due: 0,
      lines: [L('LD-4419', 'Unicorn Water Bottle 500ml', 22), L('BS-1401', 'Foil Balloon Set 12', 14)],
    },
  ];

  return { docs, pool, exceptions: [], counted: [] };
}

/* -------------------------------------------------------- EPC resolution */

/**
 * Demo EPC block per SKU, matching bridge/data/catalog.json.
 *
 * The bridge encodes test labels as `AA00` + a 20-hex-digit counter
 * (bridge/src/printer/zpl.js `testEpc`). Each SKU owns 100 counters starting
 * at (index+1)*100, so EPCs 1–99 stay free for throwaway test prints.
 */
const EPCS_PER_SKU = 100;

export function catalogSkus(): { sku: string; name: string }[] {
  const seen = new Map<string, string>();
  const board = seedBoard();
  for (const d of [...board.docs, ...board.pool]) for (const l of d.lines) if (!seen.has(l.sku)) seen.set(l.sku, l.name);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([sku, name]) => ({ sku, name }));
}

export function demoEpc(skuIndex: number, copy: number): string {
  const counter = (skuIndex + 1) * EPCS_PER_SKU + copy;
  return 'AA00' + counter.toString(16).toUpperCase().padStart(20, '0');
}

/** EPC -> SKU for the demo tag block. Empty for any EPC outside it. */
export const DEMO_EPC_SKU: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  catalogSkus().forEach(({ sku }, i) => {
    for (let c = 0; c < EPCS_PER_SKU; c++) map[demoEpc(i, c)] = sku;
  });
  return map;
})();

/** All demo EPCs for a SKU — used by the gate simulator to fire realistic reads. */
export function demoEpcsFor(sku: string): string[] {
  const i = catalogSkus().findIndex((s) => s.sku === sku);
  if (i < 0) return [];
  return Array.from({ length: EPCS_PER_SKU }, (_, c) => demoEpc(i, c));
}

/**
 * Gate read -> SKU. The bridge catalogue wins; the demo block is the
 * fallback so the board still works before a real catalogue is loaded.
 */
export function resolveSku(entry: EntryRow): string | null {
  if (entry.known && entry.item?.sku) return entry.item.sku;
  return DEMO_EPC_SKU[entry.epc.toUpperCase()] ?? null;
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

/** Today's board for one direction: overdue first, then due today. */
export const activeDocs = (docs: GateDoc[], dir: Direction) =>
  docs.filter((d) => d.dir === dir && d.due <= 0).sort((a, b) => (a.due < 0 ? 0 : 1) - (b.due < 0 ? 0 : 1));

/* --------------------------------------------------------------- storage */

const STORAGE_KEY = 'gateBoard.v1';
const today = () => new Date().toISOString().slice(0, 10);

function loadBoard(): BoardState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as BoardState & { date: string };
      // A new day starts from a clean board.
      if (saved.date === today() && Array.isArray(saved.docs)) {
        return { docs: saved.docs, pool: saved.pool ?? [], exceptions: saved.exceptions ?? [], counted: saved.counted ?? [] };
      }
    }
  } catch {
    /* corrupt or unavailable storage — fall through to a fresh board */
  }
  return seedBoard();
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

  if (state.counted.includes(epc)) {
    const sku = resolveSku(entry);
    return { state, outcome: { kind: 'duplicate', message: sku ? `${sku} · already counted today` : `${epc} · already counted today` } };
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
      return { state: { ...state, counted: [...state.counted, epc] }, outcome: { kind: 'complete', message: `${sku} · every open line already complete` } };
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
    state: { ...state, docs, counted: [...state.counted, epc] },
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
  resetDay: () => void;
}

/** Drives today's board off the bridge's entry/exit stream. */
export function useGateBoard(entries: EntryRow[]): GateBoardApi {
  const [board, setBoard] = useState<BoardState>(loadBoard);
  const [lastCounted, setLastCounted] = useState<GateBoardApi['lastCounted']>(null);
  const [flashTag, setFlashTag] = useState<string | null>(null);
  const [dupMsg, setDupMsg] = useState<string | null>(null);

  // Highest EntryRow.id already folded into the board — ids increase monotonically.
  const appliedTo = useRef(-1);
  const seq = useRef(0);
  // Mirror of `board`, so a burst of movements folds in without waiting for re-render.
  const current = useRef(board);
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

  const resetDay = useCallback(() => {
    commit(seedBoard());
    setLastCounted(null);
    setFlashTag(null);
    setDupMsg(null);
  }, [commit]);

  return { board, lastCounted, flashTag, dupMsg, addFromPool, clearExceptions, resetDay };
}
