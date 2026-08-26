import { useEffect, useMemo, useRef, useState } from 'react';
import { activeDocs, docTitle, docTotals, pct, sumTotals, type Direction, type DocLine, type FeedState, type GateDoc, type GateBoardApi } from './documents';
import { accent, C, dueChip, Icon, Tile, u } from './boardKit';
import DirectionView from './DirectionView';
import Qr from './Qr';
import type { SoundState } from './useAudioGate';
import { COUNT_SETTLE, useSettled } from './useSettled';
import type { EntryRow } from './types';

/**
 * Landscape warehouse gate board — 1920 × 1080 kiosk.
 *
 * This is signage, not a kiosk: it hangs on a 43" panel with nobody able to
 * drive it, so the gate reader is the only input. The overview is therefore
 * the resting state and every read returns to it, highlighting the product it
 * just credited (see `focus`). The drill-in screens survive for a panel that
 * does happen to have touch, and unwind themselves after IDLE_TIMEOUT_MS:
 *
 *   Overview      — the live receiving reading, split by progress
 *   DirectionView — every item from every PO in one grid
 *   DocumentView  — one document, opened from a tile
 *
 * RECEIVING ONLY. Shipping is out of scope for this gate, so nothing outbound
 * is fetched (bridge1/src/board.js), counted (documents.ts) or drawn here: an
 * outbound passage leaves the board exactly as it was.
 *
 * Layout is a port of warehousePrototypeLayout/, expressed in the fluid unit
 * `--u` (see .gate in index.css): one design pixel. Landscape inverts which
 * axis is precious — width is now plentiful and height is not — so chrome
 * (header, footer, screen headers) is kept low and the wide axis carries the
 * content: the two directions sit beside each other instead of stacked, and
 * the tile grids fill their width rather than being pinned at four columns.
 */

const IDLE_TIMEOUT_MS = 45_000;
/**
 * How long the last pallet stays on the panel after the door goes quiet.
 *
 * The live panel is scoped to the most recent inbound passage, which never used
 * to expire — so a pallet received at 09:10 was still the subject of the board
 * at lunchtime. On a wall panel that reads as the current state of the door, and
 * someone walking up has no way to tell that nothing has arrived for hours.
 *
 * Ten minutes is well past any single pallet being unloaded (the pallet window
 * itself is one minute), so this only ever fires on a genuinely idle door.
 */
const PALLET_IDLE_CLEAR_MS = 10 * 60_000;
/** How long a just-counted product stays highlighted on the board. */
const FOCUS_MS = 9_000;
/**
 * The live figures SETTLE rather than ticking: cartons reach this panel about
 * one every 270ms, so without it the pallet figure counts 1, 2, 3 … up to its
 * total in front of the operator and is only trustworthy once it stops. The
 * timings, and why they are what they are, live with the hook — see
 * COUNT_SETTLE in useSettled.ts.
 */

export default function GateBoard(props: { board: GateBoardApi; entries: EntryRow[]; sound: SoundState; onOpenControls: () => void }) {
  const { board } = props;
  const { docs } = board.board;
  // Receiving-only: the board follows the latest INBOUND passage. A pallet
  // leaving the building doesn't blank the panel or relabel it SHIPPING — it
  // simply isn't this board's business, so the last arrival stays up.
  //
  // `!unexpected` and `known` are load-bearing. This panel is built straight
  // from the movement stream and never consults `docs`, so without them ANY
  // inbound read became a line — and because `expected` falls back to the read
  // count below, a product on no receiving batch rendered as a finished line.
  // That is how a deleted batch's product kept appearing here long after the
  // counting path had learned to refuse it: the counting path was never asked.
  //
  // A contested carton also carries no passageId, so it used to become its own
  // `liveBatchId` and REPLACE the panel — one stray tag wiping a real passage
  // off the screen.
  const arrivingEntries = useMemo(
    () => props.entries.filter((entry) => entry.direction === 'in' && !entry.unexpected && entry.known),
    [props.entries]
  );
  /**
   * The panel reads from the SETTLED list, never the live one.
   *
   * Settling here rather than on the rendered figures keeps the one-source-of-
   * truth property the rest of this component depends on: the batch id, the
   * totals, the product tiles, the pallet caption and the focus highlight are
   * all derived from this array, so they move together in a single step instead
   * of the number jumping while the caption still describes the carton before.
   *
   * A list that got SHORTER is never held: that is a receiving reset or a
   * cleared board withdrawing cartons, and a figure that has been taken back
   * must go immediately — holding it would leave the panel showing stock Nexus
   * no longer thinks was received.
   */
  const inboundEntries = useSettled(arrivingEntries, {
    ...COUNT_SETTLE,
    immediate: (next, shown) => next.length < shown.length,
  });
  // Coarse clock, only so the expiry below re-evaluates without a passage. 5s
  // granularity on a 10-minute boundary is invisible and costs one render.
  const [clockTick, setClockTick] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setClockTick(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);
  const latestFault = useMemo(() => props.entries.find((entry) => entry.direction === 'in' && Boolean(entry.unexpected)) ?? null, [props.entries]);
  const faultAt = latestFault ? Date.parse(latestFault.timestamp) : NaN;
  const activeFault = latestFault && Number.isFinite(faultAt) && clockTick - faultAt < 10 * 60_000 ? latestFault : null;

  // The latest inbound passage, unless the door has been quiet long enough that
  // it is history rather than news — see PALLET_IDLE_CLEAR_MS. Expiring the
  // ENTRY rather than filtering liveDocs keeps one source of truth: liveTotals,
  // liveFocus and the pallet caption all fall away with it.
  const latestEntry = useMemo(() => {
    const newest = inboundEntries[0] ?? null;
    if (!newest) return null;
    const at = Date.parse(newest.timestamp ?? '');
    if (Number.isFinite(at) && clockTick - at > PALLET_IDLE_CLEAR_MS) return null;
    return newest;
  }, [inboundEntries, clockTick]);
  const liveBatchId = latestEntry ? String(latestEntry.passageId ?? latestEntry.eventId ?? latestEntry.id) : null;
  const liveEntries = useMemo(
    () => liveBatchId == null ? [] : inboundEntries.filter((entry) => String(entry.passageId ?? entry.eventId ?? entry.id) === liveBatchId),
    [inboundEntries, liveBatchId]
  );
  /**
   * What the live panel shows: the BATCH being filled, at its RUNNING TOTAL —
   * not this passage's reads.
   *
   * It used to synthesise a document out of the current passage alone, so a
   * batch already holding 6 of 8 cartons read "2" when the last two went
   * through, and a product counted in an earlier passage disappeared from the
   * panel altogether. Both are the same misreading: a passage is not a
   * document, and the number the floor needs is how much of the BATCH is done.
   *
   * So the real documents this passage touched are shown WHOLE — every line, at
   * the cumulative received/expected the counting path maintains. The passage
   * becomes context in `meta` instead of the subject.
   */
  const liveDocs = useMemo<GateDoc[]>(() => {
    if (!latestEntry || !liveBatchId) return [];
    const passageNote = `${liveEntries.length} carton${liveEntries.length === 1 ? '' : 's'} read`;

    // THIS PALLET's cartons, counted here — deliberately not the batch's running
    // total. A doorway is asked "how many have gone through", and answering with
    // a fraction invites the reader to work out what is missing, when the rest
    // may simply be on the next pallet. The batch totals still live in Nexus and
    // on the kiosk; they are not this panel's job.
    const counts = new Map<string, { count: number; entry: EntryRow }>();
    for (const entry of liveEntries) {
      const sku = entry.item?.sku || entry.epc;
      const previous = counts.get(sku);
      counts.set(sku, { count: (previous?.count ?? 0) + 1, entry });
    }
    // Artwork and the proper product name come from the document feed when it
    // knows the SKU; the passage alone only carries what the catalogue gave it.
    const fromDocs = new Map<string, DocLine>();
    for (const doc of docs) for (const line of doc.lines) if (!fromDocs.has(line.sku)) fromDocs.set(line.sku, line);
    const lines: DocLine[] = [...counts.entries()].map(([sku, value]) => {
      const known = fromDocs.get(sku);
      return {
        sku,
        name: known?.name || value.entry.item?.name || sku,
        expected: value.count,
        received: value.count,
        countOnly: true,
        photoUrl: known?.photoUrl ?? null,
        emoji: known?.emoji ?? null,
        unitsPerCarton: null,
      };
    });
    return [{ id: liveBatchId, title: latestEntry.palletCode || 'CURRENT PALLET', dir: 'in', party: 'Reading now', meta: passageNote, due: 0, lines }];
  }, [docs, latestEntry, liveBatchId, liveEntries]);
  const liveTotals = useMemo(() => sumTotals(liveDocs), [liveDocs]);
  const liveFocus = latestEntry && liveDocs[0] ? `${liveDocs[0].id}-${latestEntry.item?.sku || latestEntry.epc}` : null;

  const [mode, setMode] = useState<'idle' | 'live'>('idle');
  const [dir, setDir] = useState<Direction>('in');
  /** null = the whole direction; an id = that one document. */
  const [activeId, setActiveId] = useState<string | null>(null);
  /** `${docId}-${sku}` of the product just counted — the tile the board points at. */
  const [focus, setFocus] = useState<string | null>(null);

  const lastTouch = useRef(Date.now());
  const touch = () => (lastTouch.current = Date.now());

  // Nobody can drive this screen — it hangs on a wall — so a gate read is the
  // only navigation there is, and it does two things: it puts the board back
  // on the overview (the full picture is the right resting state for a TV,
  // and there is no tab to get back with), and it marks the product that was
  // just credited so the eye lands on it. StatusBox scrolls it into view.
  useEffect(() => {
    const hit = board.lastCounted;
    if (!hit) return;
    touch();
    setDir(hit.dir);
    setMode('idle');
    setActiveId(null);
    setFocus(hit.sku ? `${hit.docId}-${hit.sku}` : null);
  }, [board.lastCounted]);

  // The highlight is a "that one, just now" cue, not a state — it fades on its
  // own so a board left alone doesn't keep pointing at an hour-old carton.
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => setFocus(null), FOCUS_MS);
    return () => clearTimeout(t);
  }, [focus, board.lastCounted]);

  // A stray tap (the panel may still be a touchscreen) unwinds itself.
  useEffect(() => {
    const t = setInterval(() => {
      if (mode === 'idle') return;
      if (Date.now() - lastTouch.current > IDLE_TIMEOUT_MS) {
        setMode('idle');
        setActiveId(null);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [mode]);

  const inDocs = useMemo(() => activeDocs(docs, 'in'), [docs]);
  const inTotals = useMemo(() => sumTotals(inDocs), [inDocs]);

  /**
   * RESTING STATE — the board shows NO carton figures when nothing is arriving.
   *
   * It used to fall back to today's outstanding batches. That was wrong at a
   * doorway for a reason that only shows up on the floor: an unfinished batch
   * stays outstanding in Nexus indefinitely, so a delivery that was 7/8 two days
   * ago sat on the board as though it were happening now. And the missing carton
   * genuinely may be on a later pallet — a part-received batch is not a problem
   * to display, it is just work not finished yet.
   *
   * So the panel is scoped to the pallet at the door and nothing else. When that
   * expires (PALLET_IDLE_CLEAR_MS) the figures go, because a figure on a wall
   * panel reads as "this is happening now" and after ten minutes it is not.
   *
   * NOT a black screen, which is the other way to get this wrong: on a 43" panel
   * with no keyboard, black reads as "the gate is broken". An explicit waiting
   * state says the same thing honestly — nothing is arriving, and the gate is
   * fine.
   */
  const idle = liveDocs.length === 0;
  const panelDocs = liveDocs;
  const panelTotals = liveTotals;
  const panelFocus = liveFocus;

  const dirDocs = inDocs;
  const activeDoc = activeId ? (dirDocs.find((d) => d.id === activeId) ?? null) : null;

  const open = (nextDir: Direction, id: string | null) => {
    touch();
    setDir(nextDir);
    setActiveId(id);
    setMode('live');
  };

  const goIdle = () => {
    touch();
    setMode('idle');
    setActiveId(null);
  };

  return (
    <div className="gate" style={{ width: u(1920), height: '100%', margin: '0 auto', position: 'relative', overflow: 'hidden', background: C.white, color: C.fg, display: 'flex', flexDirection: 'column', userSelect: 'none' }}>
      <Header
        sound={props.sound}
        onControls={() => {
          touch();
          props.onOpenControls();
        }}
      />

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', padding: `${u(18)} ${u(28)}` }}>
          {idle ? <WaitingForPallet feed={board.feed} poCount={inDocs.length} /> : (
            <DirectionSection dir="in" docs={panelDocs} totals={panelTotals} focus={panelFocus} onOpen={() => {}} />
          )}
        </div>

        {board.dupMsg && <DupToast message={board.dupMsg} />}
        {activeFault && <NoReceivingCard entry={activeFault} />}
      </div>

    </div>
  );
}

function NoReceivingCard({ entry }: { entry: EntryRow }) {
  return (
    <div role="status" aria-label={`${entry.item?.name || entry.item?.sku || entry.epc}: no receiving batch`} style={{ position: 'absolute', left: u(42), top: u(38), zIndex: 40, width: u(270), overflow: 'hidden', borderRadius: u(15), border: `${u(3)} solid ${C.redEdge}`, background: C.white, boxShadow: '0 10px 26px rgba(127,29,29,.22)' }}>
      <div style={{ position: 'relative', height: u(165), display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.surface, color: C.off }}>
        <Icon.Box size={72} />
        <div style={{ position: 'absolute', left: u(10), right: u(10), top: '50%', transform: 'translateY(-50%)', minHeight: u(52), display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.redDk, color: C.white, padding: `${u(8)} ${u(12)}`, fontSize: u(20), fontWeight: 950, letterSpacing: '.09em', textAlign: 'center' }}>NO RECEIVING</div>
      </div>
      <div style={{ padding: `${u(13)} ${u(15)} ${u(15)}` }}>
        <div style={{ fontSize: u(18), fontWeight: 800, color: C.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.item?.name || 'Product not on batch'}</div>
        <div style={{ marginTop: u(5), fontSize: u(14), fontWeight: 700, color: C.redDk }}>{entry.item?.sku || entry.epc}</div>
        <div style={{ marginTop: u(8), fontSize: u(13), fontWeight: 600, lineHeight: 1.3, color: C.muted }}>Not credited · not added to pallet</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- header */

function Header(props: {
  sound: SoundState;
  onControls: () => void;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const dateLabel = `${days[now.getDay()]} · ${String(now.getDate()).padStart(2, '0')} ${mon[now.getMonth()]} ${now.getFullYear()}`;

  // Portrait had to stack identity+clock over status+gear: at 1080 wide the
  // fixed-width children summed to the whole content width before the READING
  // pill or exceptions badge were even counted. Landscape removes that
  // pressure — 1920 wide leaves ~500u of slack with every chip showing — so
  // the header goes back to a single row and gives the height back to the
  // content, which is what's now in short supply. Reading order left to right:
  // who this gate is, what it's doing, then when and the way in to settings.
  return (
    <div style={{ flex: `0 0 ${u(152)}`, display: 'flex', alignItems: 'stretch', gap: u(24), padding: `${u(14)} ${u(28)}`, background: C.white, borderBottom: `1px solid ${C.border}`, position: 'relative', zIndex: 20 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: u(5), flex: '0 0 auto' }}>
        <Qr size={106} />
        <div style={{ fontSize: u(10), fontWeight: 800, letterSpacing: '0.12em', color: C.faint }}>SCAN · LIVE VIEW</div>
      </div>

      {/* A thin divider ties the QR to the info row as one composed unit
          instead of two blocks separated by a gap. */}
      <div style={{ flex: '0 0 auto', width: 1, background: C.border, alignSelf: 'stretch' }} />

      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: u(18) }}>
        <div style={{ flex: 1, minWidth: u(20) }} />

        <SoundChip state={props.sound} />

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: u(4), flex: '0 0 auto' }}>
          <div style={{ fontSize: u(36), fontWeight: 700, letterSpacing: u(-0.5), fontVariantNumeric: 'tabular-nums', lineHeight: 1, whiteSpace: 'nowrap' }}>{clock}</div>
          <div style={{ fontSize: u(16), fontWeight: 600, letterSpacing: '0.08em', color: C.muted, whiteSpace: 'nowrap' }}>{dateLabel}</div>
        </div>

        <div onClick={props.onControls} title="Engineering console" style={{ width: u(56), height: u(56), borderRadius: u(14), background: C.surface, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.muted, cursor: 'pointer', flex: '0 0 auto' }}>
          <Icon.Gear size={26} />
        </div>
      </div>
    </div>
  );
}

/**
 * Why the board is silent, when it is.
 *
 * Only ever shown when something is wrong — a working board says nothing about
 * its sound, because there is nothing to do about it. The two failures are very
 * different and must not look alike: one is fixed by pressing any button, the
 * other cannot be fixed on this device at all, and a supervisor standing in
 * front of a mute TV has no other way to tell them apart.
 */
function SoundChip(props: { state: SoundState }) {
  if (props.state === 'ready') return null;

  const waiting = props.state === 'needs-gesture';
  const look = waiting
    ? { bg: C.amberBg, edge: C.amberEdge, fg: C.amberDk, label: 'SOUND OFF', detail: 'press any button on the remote' }
    : { bg: C.redBg, edge: C.redEdge, fg: C.redDk, label: 'NO SOUND', detail: 'this browser cannot play audio' };

  return (
    <div
      title={waiting ? 'Browsers block audio until the page is touched once. Any key, tap or remote button will do.' : 'This browser has no Web Audio, so the gate chime cannot be played on this device at all.'}
      style={{ display: 'flex', alignItems: 'center', gap: u(10), padding: `${u(12)} ${u(22)}`, borderRadius: u(26), background: look.bg, border: `1px solid ${look.edge}`, flex: '0 0 auto' }}
    >
      <div style={{ fontSize: u(18), lineHeight: 1 }}>🔇</div>
      <div style={{ fontSize: u(15), fontWeight: 800, letterSpacing: '0.12em', color: look.fg, whiteSpace: 'nowrap' }}>{look.label}</div>
      <div style={{ fontSize: u(15), fontWeight: 600, color: C.muted, whiteSpace: 'nowrap' }}>{look.detail}</div>
    </div>
  );
}

/**
 * Document-feed state, and the manual refresh.
 *
 * Always visible: the board polls every minute, so the useful thing to show is
 * WHEN the documents were last true — a kiosk that silently displays a
 * three-hour-old board is worse than one that admits it. Amber and red only
 * appear when the feed is cached or down. Tapping re-pulls immediately, for
 * when someone has just created a batch and doesn't want to wait out the poll.
 */
/**
 * The resting state: nothing has arrived for PALLET_IDLE_CLEAR_MS.
 *
 * Deliberately carries NO carton figures. The whole point is that a number on a
 * wall panel reads as current, so an idle door must not show one — the previous
 * pallet's counts are history and a part-received batch may simply be waiting on
 * a later pallet.
 *
 * It does say how many POs are open, because "the gate is idle" and "there is
 * nothing to receive today" are different facts and the floor needs both. And it
 * carries the feed state: an idle board and a board that cannot reach Nexus look
 * identical otherwise, which is how a broken link goes unnoticed for a shift.
 */
function WaitingForPallet(props: { feed: FeedState; poCount: number }) {
  const broken = props.feed.status === 'error' || props.feed.status === 'stale';
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: u(28) }}>
      <div style={{ width: u(120), height: u(120), borderRadius: '50%', border: `${u(3)} solid ${C.border}`, display: 'grid', placeItems: 'center' }}>
        <Icon.Box size={58} />
      </div>
      <div style={{ fontSize: u(52), fontWeight: 800, letterSpacing: u(-1), color: C.muted, textAlign: 'center' }}>
        READY FOR THE NEXT PALLET
      </div>
      <div style={{ fontSize: u(24), fontWeight: 600, color: C.faint, textAlign: 'center', maxWidth: u(1100) }}>
        {broken
          ? 'Receiving documents are not reaching this board — check the link to Nexus.'
          : props.poCount === 0
            ? 'No receiving batches open at this door.'
            : `${props.poCount} receiving ${props.poCount === 1 ? 'batch' : 'batches'} open · counts appear as cartons pass`}
      </div>
    </div>
  );
}

function FeedChip(props: { feed: FeedState; onRefresh: () => void }) {
  const { status, fetchedAt } = props.feed;
  // hour12:false to match the header's own 24h clock, and to avoid a trailing
  // " PM" that made this chip wrap under a squeeze.
  const stamp = fetchedAt ? new Date(fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : null;

  const look =
    status === 'error'
      ? { label: 'DOCS UNAVAILABLE', detail: 'tap to retry', bg: C.redBg, edge: C.redEdge, fg: C.redDk }
      : status === 'stale'
        ? { label: 'CACHED DOCS', detail: stamp ? `as of ${stamp}` : 'tap to retry', bg: C.amberBg, edge: C.amberEdge, fg: C.amberDk }
        : status === 'loading'
          ? { label: 'UPDATING', detail: '', bg: C.surface, edge: C.border, fg: C.muted }
          : { label: 'DOCS', detail: stamp ? `updated ${stamp}` : '', bg: C.surface, edge: C.border, fg: C.muted };

  return (
    <div
      onClick={props.onRefresh}
      title="Reload today's receiving documents from Nexus"
      style={{ display: 'flex', alignItems: 'center', gap: u(12), padding: `${u(12)} ${u(22)}`, borderRadius: u(26), background: look.bg, border: `1px solid ${look.edge}`, cursor: 'pointer' }}
    >
      <div style={{ fontSize: u(15), fontWeight: 800, letterSpacing: '0.12em', color: look.fg }}>{look.label}</div>
      {look.detail && <div style={{ fontSize: u(15), fontWeight: 600, color: C.muted }}>{look.detail}</div>}
    </div>
  );
}

/* -------------------------------------------------------------- overview */

type BoardItem = { line: DocLine; doc: GateDoc };

/**
 * The three states a SKU line can be in at the gate, in the order work moves
 * through them: nothing counted yet, some cartons counted, all counted.
 *
 * This is the same three-way split the tile borders have always drawn (grey /
 * accent / green) — the overview now sorts by it instead of only colouring by
 * it, so "what's still coming" is a place on the screen you can point at
 * rather than something you work out by scanning every tile's badge.
 */
const BUCKETS = [
  { key: 'todo', label: { in: 'GOODS EXPECTED TO RECEIVE', out: 'TO LOAD' }, empty: { in: 'Nothing left to receive', out: 'Nothing left to load' } },
  { key: 'part', label: { in: 'PARTIALLY RECEIVED', out: 'PARTIALLY LOADED' }, empty: { in: 'Nothing part-counted', out: 'Nothing part-counted' } },
  { key: 'done', label: { in: 'FULLY RECEIVED', out: 'FULLY LOADED' }, empty: { in: 'Nothing complete yet', out: 'Nothing complete yet' } },
] as const;

const bucketOf = (line: DocLine): (typeof BUCKETS)[number]['key'] =>
  line.received >= line.expected ? 'done' : line.received > 0 ? 'part' : 'todo';

/**
 * Receiving — a slim totals strip over the status boxes.
 *
 * The big progress ring is gone: split three ways, a 140u ring cost more height
 * than the boxes could spare, and the same fact reads fine as a bar. `dir` is
 * still a prop because the tiles take their accent from it, but only 'in' is
 * ever passed — there is no shipping side of this board.
 */
function DirectionSection(props: { dir: Direction; docs: GateDoc[]; totals: { received: number; expected: number }; focus: string | null; onOpen: (id: string) => void }) {
  const a = accent(props.dir);
  const p = pct(props.totals.received, props.totals.expected);
  // Every line on this panel is a live count, so the header must not imply a
  // target either — a bare number and a bar disagreeing looks like a fault.
  const countOnly = props.docs.length > 0 && props.docs.every((d) => d.lines.every((l) => l.countOnly));
  const noun = 'POs';
  const late = props.docs.filter((d) => d.due < 0).length;
  const dueToday = props.docs.filter((d) => d.due === 0).length;
  const docLabel = [`${dueToday} ${noun} due today`, ...(late ? [`${late} overdue`] : [])].join(' · ');
  // What staff actually recognise at a glance is the PRODUCT crossing the
  // door, not the paperwork it rides on — so the board shows one tile per SKU
  // line (photo, name, progress) rather than one row per PO. The owning batch
  // still travels with each tile as its label strip.
  const items: BoardItem[] = props.docs.flatMap((doc) => doc.lines.map((line) => ({ line, doc })));

  const tone = {
    todo: { fill: C.off, text: C.muted, soft: C.surface, edge: C.border },
    part: { fill: a.fill, text: a.text, soft: a.soft, edge: a.edge },
    done: { fill: C.green, text: C.greenDk, soft: C.greenBg, edge: '#a7e3bd' },
  };

  // With no work at all the section collapses to its totals strip rather than
  // holding the screen for empty boxes. Deliberately keyed on has-work /
  // has-no-work, not on the counts, so the layout doesn't reshuffle under a
  // forklift driver every time a carton moves between buckets.
  const empty = items.length === 0;
  // The TV is for live progress, not the future backlog: unstarted products
  // remain represented in the total above, while the canvas focuses on cartons
  // actively arriving or already received.
  // A live count has no part/full distinction to draw — every line is simply a
  // carton that has gone through. Splitting it across two columns asked the
  // reader to compare against a target this panel deliberately does not show,
  // and left one column empty for most of a pallet.
  const visibleBuckets = countOnly
    ? ([{ key: 'part', label: { in: 'CURRENTLY RECEIVING', out: 'CURRENTLY LOADING' }, empty: { in: 'Nothing yet', out: 'Nothing yet' } }] as const)
    : BUCKETS.filter((bucket) => bucket.key !== 'todo');

  return (
    <div style={{ flex: empty ? '0 0 auto' : 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: u(10) }}>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: u(18) }}>
        <div style={{ fontSize: u(15), fontWeight: 800, letterSpacing: '0.18em', color: a.text, flex: '0 0 auto' }}>
          {countOnly ? '· READING NOW' : '· EXPECTED ARRIVAL'}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: u(10), flex: '0 0 auto' }}>
          <div
            style={{
              // Much larger when it is the ONLY number on the panel: this is
              // read from across a warehouse, and with the fraction, bar and
              // percent gone there is room for it to carry the header alone.
              fontSize: u(countOnly ? 140 : 46),
              fontWeight: 800,
              lineHeight: 1,
              letterSpacing: u(countOnly ? -7 : -2),
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {props.totals.received}
          </div>
          {!countOnly && <div style={{ fontSize: u(26), fontWeight: 700, color: C.faint, fontVariantNumeric: 'tabular-nums' }}>/ {props.totals.expected}</div>}
          <div style={{ fontSize: u(countOnly ? 22 : 13), fontWeight: 700, letterSpacing: '0.14em', color: C.faint }}>CARTONS</div>
        </div>
        {!countOnly && (
          <>
            <div style={{ flex: '0 0 auto', width: u(260), height: u(12), borderRadius: u(8), background: C.track, overflow: 'hidden' }}>
              <div style={{ height: '100%', borderRadius: u(8), width: `${p}%`, background: p >= 100 ? C.green : a.fill, transition: 'width .3s ease' }} />
            </div>
            <div style={{ fontSize: u(19), fontWeight: 800, color: a.text, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{p}%</div>
          </>
        )}
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: u(17), fontWeight: 600, color: C.muted, flex: '0 0 auto' }}>{docLabel}</div>
      </div>

      {empty ? (
        <div style={{ flex: '0 0 auto', padding: `${u(16)} ${u(18)}`, borderRadius: u(16), border: `1px dashed ${C.border}`, background: C.surface, fontSize: u(17), fontWeight: 600, color: C.faint }}>
          Nothing inbound on today’s board.
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: u(14) }}>
          {visibleBuckets.map((b) => (
            <StatusBox
              key={b.key}
              label={b.label[props.dir]}
              empty={b.empty[props.dir]}
              tone={tone[b.key]}
              dir={props.dir}
              items={countOnly ? items : items.filter(({ line }) => bucketOf(line) === b.key)}
              focus={props.focus}
              onOpen={props.onOpen}
              roomy
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One of the three status columns: a tinted title bar and a grid of tiles. */
function StatusBox(props: {
  label: string;
  empty: string;
  tone: { fill: string; text: string; soft: string; edge: string };
  dir: Direction;
  items: BoardItem[];
  focus: string | null;
  onOpen: (id: string) => void;
  roomy?: boolean;
}) {
  const cartons = props.items.reduce((n, { line }) => n + line.expected, 0);

  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.white, borderRadius: u(16), border: `1px solid ${props.tone.edge}`, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', overflow: 'hidden' }}>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: u(props.roomy ? 13 : 10), padding: `${u(props.roomy ? 13 : 9)} ${u(props.roomy ? 18 : 14)}`, background: props.tone.soft, borderBottom: `1px solid ${props.tone.edge}` }}>
        <div style={{ width: u(props.roomy ? 12 : 10), height: u(props.roomy ? 12 : 10), borderRadius: u(3), background: props.tone.fill, flex: '0 0 auto' }} />
        <div style={{ fontSize: u(props.roomy ? 24 : 15), fontWeight: 800, letterSpacing: '0.12em', color: props.tone.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{props.label}</div>
        <div style={{ flex: 1 }} />
        {props.items.length > 0 && (
          <div style={{ fontSize: u(props.roomy ? 19 : 13), fontWeight: 700, color: C.muted, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{cartons} ctn</div>
        )}
        <div style={{ minWidth: u(props.roomy ? 34 : 28), padding: `${u(props.roomy ? 4 : 2)} ${u(props.roomy ? 10 : 8)}`, borderRadius: u(20), background: props.items.length ? props.tone.fill : C.border, color: props.items.length ? C.white : C.faint, fontSize: u(props.roomy ? 20 : 16), fontWeight: 800, textAlign: 'center', fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>
          {props.items.length}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: u(props.roomy ? 16 : 12) }}>
        {props.items.length === 0 ? (
          <div style={{ fontSize: u(16), fontWeight: 600, color: C.faint, padding: `${u(10)} ${u(2)}` }}>{props.empty}</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${u(props.roomy ? 212 : 134)}, 1fr))`, gap: u(props.roomy ? 14 : 8) }}>
            {props.items.map(({ line, doc }) => (
              <Tile key={`${doc.id}-${line.sku}`} line={line} dir={props.dir} compact={!props.roomy} large={props.roomy} focused={props.focus === `${doc.id}-${line.sku}`} doc={{ label: docTitle(doc), due: doc.due }} onClick={() => props.onOpen(doc.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------- one document */

function DocumentView(props: { dir: Direction; doc: GateDoc; focus: string | null; onBack: () => void; onAll: () => void }) {
  const a = accent(props.dir);
  const { doc } = props;
  const t = docTotals(doc);
  const done = t.received >= t.expected && t.expected > 0;
  const due = dueChip(doc.due);
  const complete = doc.lines.filter((l) => l.received >= l.expected).length;

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: C.white }}>
      {/* Every u of header here is a u the tile grid doesn't get, and 1080 of
          height only has room for two rows of tiles below it — so the chrome
          is deliberately tighter than portrait's, and the identity, the count
          and the per-SKU bar all share one band across the wide axis. */}
      <div style={{ flex: '0 0 auto', padding: `${u(18)} ${u(28)} ${u(14)} ${u(28)}`, background: C.white, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: u(20) }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: u(8) }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: u(14) }}>
              <div onClick={props.onBack} style={{ display: 'flex', alignItems: 'center', gap: u(10), height: u(50), padding: `0 ${u(22)}`, borderRadius: u(26), background: C.surface, border: `1px solid ${C.border}`, fontSize: u(18), fontWeight: 700, color: C.muted, cursor: 'pointer' }}>
                ‹ Overview
              </div>
              <div onClick={props.onAll} style={{ padding: `${u(8)} ${u(18)}`, borderRadius: u(26), fontSize: u(15), fontWeight: 800, letterSpacing: '0.16em', background: a.soft, color: a.text, cursor: 'pointer' }}>
                ALL RECEIVING
              </div>
              <div style={{ padding: `${u(8)} ${u(18)}`, borderRadius: u(26), fontSize: u(15), fontWeight: 800, letterSpacing: '0.12em', background: due.bg, color: due.fg, border: `1px solid ${due.edge}` }}>{due.label}</div>
              <div style={{ fontSize: u(16), fontWeight: 600, letterSpacing: '0.08em', color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.meta}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: u(20), minWidth: 0 }}>
              <div style={{ fontSize: u(52), fontWeight: 800, lineHeight: 1, letterSpacing: u(-1.5), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{docTitle(doc)}</div>
              <div style={{ fontSize: u(22), fontWeight: 600, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{doc.party}</div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: u(10), flex: '0 0 auto' }}>
            <div style={{ fontSize: u(104), fontWeight: 800, lineHeight: 0.8, letterSpacing: u(-5), fontVariantNumeric: 'tabular-nums', color: done ? C.green : a.text }}>{t.received}</div>
            <div style={{ fontSize: u(44), fontWeight: 700, color: C.faint, fontVariantNumeric: 'tabular-nums' }}>/ {t.expected}</div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: u(16), marginTop: u(14) }}>
          <div style={{ flex: 1, display: 'flex', gap: u(6), alignItems: 'center' }}>
            {doc.lines.map((l) => (
              <div key={l.sku} style={{ height: u(18), borderRadius: u(12), background: C.track, overflow: 'hidden', flex: l.expected }}>
                <div style={{ height: '100%', borderRadius: u(12), width: `${pct(l.received, l.expected)}%`, background: l.received >= l.expected ? C.green : a.fill, transition: 'width .3s ease' }} />
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: u(10), fontSize: u(16), fontWeight: 600, color: C.faint, flex: '0 0 auto' }}>
            <div style={{ width: u(12), height: u(12), borderRadius: u(4), background: done ? C.green : a.fill }} />
            <div style={{ whiteSpace: 'nowrap' }}>
              {complete} of {doc.lines.length} SKUs complete
            </div>
          </div>
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `${u(20)} ${u(28)} ${u(24)} ${u(28)}` }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${u(212)}, 1fr))`, gap: u(14) }}>
          {doc.lines.map((line) => (
            <Tile key={line.sku} line={line} dir={props.dir} focused={props.focus === `${doc.id}-${line.sku}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- overlays */

/**
 * Centred and capped rather than edge-to-edge: this is a small correction, and
 * a 1900u-wide bar carrying six words of text would read as an alarm. The
 * unknown-tag banner below IS an alarm, and keeps the full width.
 */
function DupToast(props: { message: string }) {
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: u(24), zIndex: 40, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
      <div className="gate-toast" style={{ maxWidth: u(900), padding: `${u(18)} ${u(28)}`, borderRadius: u(16), background: C.amberBg, border: `2px solid ${C.amberEdge}`, display: 'flex', alignItems: 'center', gap: u(20), boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}>
        <div style={{ fontSize: u(15), fontWeight: 800, letterSpacing: '0.16em', color: C.amberDk, whiteSpace: 'nowrap' }}>ALREADY COUNTED</div>
        <div style={{ fontSize: u(20), fontWeight: 600, color: '#7c4a08' }}>{props.message}</div>
      </div>
    </div>
  );
}

function OverlayHeader(props: { eyebrow: string; eyebrowColor: string; title: string; onOverview: () => void; onClose: () => void }) {
  return (
    <div style={{ flex: `0 0 ${u(104)}`, display: 'flex', alignItems: 'center', gap: u(24), padding: `0 ${u(28)}`, borderBottom: `1px solid ${C.border}`, background: C.white }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: u(20) }}>
        <div style={{ fontSize: u(15), fontWeight: 800, letterSpacing: '0.18em', color: props.eyebrowColor, flex: '0 0 auto' }}>{props.eyebrow}</div>
        <div style={{ fontSize: u(34), fontWeight: 700, letterSpacing: u(-0.5), whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{props.title}</div>
      </div>
      <div onClick={props.onOverview} style={{ height: u(68), padding: `0 ${u(28)}`, borderRadius: u(16), background: C.surface, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', fontSize: u(21), fontWeight: 700, color: C.muted, cursor: 'pointer', flex: '0 0 auto' }}>
        ‹ Overview
      </div>
      <div onClick={props.onClose} style={{ width: u(68), height: u(68), borderRadius: u(16), background: C.surface, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: u(38), fontWeight: 300, color: C.muted, cursor: 'pointer', flex: '0 0 auto' }}>
        ×
      </div>
    </div>
  );
}

function ExceptionsScreen(props: { rows: { id: number; tag: string; note: string; at: string }[]; onClear: () => void; onClose: () => void; onOverview: () => void }) {
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 75, background: C.white, display: 'flex', flexDirection: 'column' }}>
      <OverlayHeader eyebrow="EXCEPTIONS" eyebrowColor={C.redDk} title={`${props.rows.length} unmatched tags today`} onOverview={props.onOverview} onClose={props.onClose} />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: `${u(20)} ${u(28)}` }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${u(600)}, 1fr))`, gap: u(14) }}>
          {props.rows.map((e) => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: u(24), padding: `${u(20)} ${u(26)}`, borderRadius: u(16), background: C.redBg, border: `1px solid ${C.redEdge}` }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: u(8), minWidth: 0 }}>
                <div style={{ fontSize: u(24), fontWeight: 700, fontFamily: "'Courier New', monospace", letterSpacing: '0.04em', color: C.redDk, wordBreak: 'break-all' }}>{e.tag}</div>
                <div style={{ fontSize: u(18), fontWeight: 600, color: C.muted }}>{e.note}</div>
              </div>
              <div style={{ fontSize: u(23), fontWeight: 700, color: C.faint, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>{e.at}</div>
            </div>
          ))}
        </div>
      </div>
      <div style={{ flex: '0 0 auto', padding: `${u(18)} ${u(28)} ${u(24)} ${u(28)}` }}>
        <div onClick={props.onClear} style={{ height: u(84), borderRadius: u(16), background: C.white, border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: u(26), fontWeight: 700, color: C.muted, cursor: 'pointer' }}>
          Clear List
        </div>
      </div>
    </div>
  );
}
