import { useEffect, useRef } from 'react';
import type { EntryRow, GpiState, MovementFault } from './types';
import { BRIDGE_HTTP } from './api';
import { playClip } from './sound';

/**
 * How long both beams must stay clear before the tally is read out. A pallet
 * passing the gate breaks and re-makes the beams several times as the gaps
 * between cartons go through, so announcing on the first clear edge would cut
 * the run into fragments and read each one separately.
 */
const GATE_CLEAR_SETTLE_MS = 800;

/**
 * Speak anyway after this long, even if the gate never reports clear.
 *
 * Without it the board goes permanently mute on two real configurations: a
 * desktop reader with no GPIO (gpi is null forever), and a gate whose beams
 * are stuck reading broken — a wiring fault that would otherwise be silent,
 * because "nothing announced" looks identical to "nothing passed".
 */
const FLUSH_FALLBACK_MS = 12000;

/**
 * Whether the board speaks at all.
 *
 * OFF — every case, routine and warning alike. On a gate that runs all day the
 * readout is constant talking, and a board that talks constantly is one people
 * stop listening to; the chime and the screen already carry the information.
 *
 * Everything below is kept intact and simply not reached: tally() still groups
 * a passage into per-product totals, phrases() still holds the English and
 * Mandarin wording, and the per-case suppression guards in the flush still
 * apply. Setting this true restores the whole thing as it was.
 */
const SPEECH_ENABLED = false;

/** One line of the announcement: a product, and how many of it went through. */
interface Tally {
  kind: 'entry' | 'exit';
  known: boolean;
  isPallet: boolean;
  name: string;
  count: number;
  /** Set when the bridge found this passage contradicted Nexus's own records. */
  fault: MovementFault | null;
}

/**
 * Collapse a passage into one line per product.
 *
 * Cartons of the same product are summed rather than listed, which is the
 * whole point: twenty cartons off one pallet is "twenty cartons of X", not
 * twenty separate announcements the board is still working through long after
 * the forklift has gone.
 *
 * Grouping keeps first-seen order so the readout matches the order things
 * actually crossed, and splits on direction — a load being unloaded while
 * another is dispatched must not merge into one count.
 */
function tally(entries: EntryRow[]): Tally[] {
  const out: Tally[] = [];
  const index = new Map<string, Tally>();
  for (const e of entries) {
    const isPallet = e.item?.kind === 'pallet';
    const name = e.known ? e.item.name : '';
    // Contested passages group SEPARATELY from clean ones, by fault. Folding
    // them together would average a warning into a confirmation: three cartons
    // through the door, one of which is on no open batch, must not be read as
    // "three cartons arrived".
    const fault = e.unexpected || null;
    const key = `${e.kind}|${fault ?? '-'}|${e.known ? (isPallet ? 'p' : 'c') + ':' + name : 'unknown'}`;
    const hit = index.get(key);
    if (hit) {
      hit.count += 1;
      continue;
    }
    const row: Tally = { kind: e.kind, known: e.known, isPallet, name, count: 1, fault };
    index.set(key, row);
    out.push(row);
  }
  return out;
}

/**
 * Announcement text per language. Product names are NOT translated — the
 * catalog stores them in English and there is nothing here to translate them
 * with, so the Mandarin voice reads the name verbatim after the Chinese
 * prefix ("已到达：Bunny Socks 12 箱").
 */
function phrases(t: Tally) {
  const exit = t.kind === 'exit';
  if (!t.known) {
    return {
      en: `Warning: ${t.count} unknown ${t.count === 1 ? 'item' : 'items'} ${exit ? 'left' : 'entered'} the warehouse`,
      zh: `警告：${t.count} 件未知物品${exit ? '离开' : '进入'}仓库`,
    };
  }
  // A contested exit is announced as what it is. Saying "checked out" here was
  // the part that made the whole thing look like it had gone through: the board
  // was already refusing to credit these cartons, but the only thing anyone at
  // the door could hear was a confirmation.
  if (t.fault) {
    const cartons = `${t.count} ${t.count === 1 ? 'carton' : 'cartons'} of ${t.name}`;
    if (t.fault === 'no-open-batch') {
      return {
        en: `Warning: ${cartons} arrived with no open receiving batch`,
        zh: `警告：${t.name} ${t.count} 箱到达，但没有对应的收货批次`,
      };
    }
    if (t.fault === 'already-shipped') {
      return {
        en: `Warning: ${cartons} left the warehouse but is already shipped`,
        zh: `警告：${t.name} ${t.count} 箱离库，但已标记为已出货`,
      };
    }
    return {
      en: `Warning: ${cartons} left the warehouse but was never received in`,
      zh: `警告：${t.name} ${t.count} 箱离库，但从未入库`,
    };
  }
  const enVerb = exit ? 'Checked out' : 'Arrived';
  const zhVerb = exit ? '已出库' : '已到达';
  if (t.isPallet) {
    // A pallet is one physical thing with a name, not a quantity of stock, so
    // it is never counted in cartons.
    return {
      en: t.count === 1 ? `${enVerb}: ${t.name}` : `${enVerb}: ${t.count} pallets, ${t.name}`,
      zh: t.count === 1 ? `${zhVerb}：${t.name}` : `${zhVerb}：${t.name} ${t.count} 板`,
    };
  }
  return {
    en: `${enVerb}: ${t.count} ${t.count === 1 ? 'carton' : 'cartons'} of ${t.name}`,
    zh: `${zhVerb}：${t.name} ${t.count} 箱`,
  };
}

/**
 * Find an installed Mandarin voice (speechSynthesis fallback path only).
 *
 * Setting utterance.lang alone is NOT enough: Chrome/Edge on Windows keep the
 * default (English) voice and read the characters as gibberish or skip them
 * entirely, so the voice object itself has to be assigned. getVoices() is also
 * empty until the engine finishes loading, hence the voiceschanged listener.
 */
function useZhVoice() {
  const voice = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const pick = () => {
      const all = window.speechSynthesis.getVoices();
      voice.current =
        all.find((v) => v.lang === 'zh-CN') ||
        all.find((v) => v.lang.replace('_', '-').startsWith('zh')) ||
        null;
    };
    pick();
    window.speechSynthesis.addEventListener('voiceschanged', pick);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', pick);
  }, []);

  return voice;
}

/** Fetch one announcement MP3 from the bridge. Throws on any failure. */
async function fetchSpeech(text: string, lang: 'en' | 'zh'): Promise<ArrayBuffer> {
  // Bounded: a hung request must not dam the queue while pallets keep coming.
  // Manual AbortController, NOT AbortSignal.timeout(): the TV's browser is an
  // old Chromium build where AbortSignal.timeout does not exist, and the
  // resulting TypeError used to be swallowed as "TTS unavailable" — silence.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`${BRIDGE_HTTP}/tts?text=${encodeURIComponent(text)}&lang=${lang}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    return await res.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Report a speech failure to the bridge's log. The wallboard TV has no
 * devtools, so an error that only lands in its console is an error nobody
 * ever sees — this is the only way to find out WHY the board went quiet.
 * Fire-and-forget; diagnostics must never become their own failure.
 */
function reportSpeechError(stage: string, err: unknown) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  fetch(`${BRIDGE_HTTP}/client-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'voice', stage, message, ua: navigator.userAgent }),
  }).catch(() => {});
}

/** Speak via the browser's own engine; resolves when the utterance ends.
 * On engines with no voices this resolves in silence — undetectable, which is
 * exactly why the bridge path is tried first. */
function speakLocal(text: string, lang: 'en' | 'zh', pitch: number, zhVoice: SpeechSynthesisVoice | null): Promise<void> {
  if (!('speechSynthesis' in window)) return Promise.resolve();
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05;
    u.pitch = pitch;
    u.lang = lang === 'zh' ? 'zh-CN' : 'en-US';
    if (lang === 'zh' && zhVoice) u.voice = zhVoice;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.speak(u);
  });
}

/**
 * Announce warehouse movements: a tone per movement, and once the gate is
 * clear, a spoken total per product.
 *
 * Movements are NOT read out one by one. They buffer while the beams are
 * broken and are announced as a tally the moment both beams go clear — the
 * point at which nothing is in the doorway and the passage is therefore
 * finished. A pallet of twenty cartons becomes one line, "twenty cartons of
 * X", instead of twenty announcements the board is still reciting minutes
 * later. See GATE_CLEAR_SETTLE_MS and FLUSH_FALLBACK_MS for the timing, and
 * tally() for the grouping.
 *
 * The tone is not a fallback that waits to see whether speech failed — it
 * always plays, per movement, because the tone is the part that carries across
 * a warehouse and across languages, and it is the operator's only immediate
 * confirmation that a tag was caught. Speech adds the totals afterwards.
 *
 * Speech itself has two paths, tried in order per line:
 *   1. Bridge TTS (GET /tts): synthesised on the bridge PC, played as an MP3
 *      through Web Audio. Works on the wallboard TV, whose browser (Edge for
 *      Android / WebView) has no speech engine of its own.
 *   2. window.speechSynthesis: the old local path, kept as the fallback for
 *      when the bridge can't synthesise (no internet, bridge restarting) on
 *      browsers that do have an engine.
 *
 * Lines are chained on a single promise queue so announcements never talk over
 * each other — the browser's own speech queue used to provide that ordering,
 * but fetched MP3s have no such queue, so it lives here now.
 */
export function useVoice(entries: EntryRow[], enabled: boolean, gpi: GpiState) {
  const lastSeenId = useRef(-1);
  const zhVoice = useZhVoice();
  const queue = useRef<Promise<void>>(Promise.resolve());
  /** Movements seen but not yet announced — flushed when the gate goes clear. */
  const pending = useRef<EntryRow[]>([]);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = () => {
    if (settleTimer.current) clearTimeout(settleTimer.current);
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    settleTimer.current = null;
    fallbackTimer.current = null;
  };

  // Speak the buffered passage as one tally, then start a fresh one. Held in a
  // ref so the timers and the beam watcher all call the same live copy rather
  // than a version captured on some earlier render.
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    clearTimers();
    const batch = pending.current;
    // Drained even when muted, so the buffer cannot grow without bound.
    pending.current = [];
    if (!batch.length) return;
    if (!SPEECH_ENABLED) return;

    const say = (text: string, lang: 'en' | 'zh', pitch: number) => {
      queue.current = queue.current
        .then(async () => {
          try {
            await playClip(await fetchSpeech(text, lang));
          } catch (err) {
            reportSpeechError('bridge-tts', err);
            await speakLocal(text, lang, pitch, zhVoice.current);
          }
        })
        // A failed line must never wedge the queue for every later one.
        .catch(() => {});
    };

    for (const t of tally(batch)) {
      // Unregistered tags are not announced, in either direction. Every pallet
      // wrapper, returnable crate and staff badge that drifts through the
      // doorway is an unknown tag, so speaking them turned the alarm voice into
      // background noise — and a voice that cries wolf all day is worse than
      // silence, because the genuine warnings (a contested exit) stop landing.
      //
      // They are NOT ignored: the board still shows the UNKNOWN TAG banner and
      // logs the exception. This suppresses the speech only. Delete this guard
      // to bring it back — phrases() still has the wording.
      if (!t.known) continue;

      // Same reasoning for "left but was never received in". A carton only has
      // a warehouse record once someone received it in, so anything that left
      // without ever being booked in trips this — which on a site still filling
      // in its inbound history is most of them. It stays a board exception; it
      // just no longer says so out loud.
      //
      // 'already-shipped' is deliberately still spoken: that one means Nexus
      // thinks the carton is gone already, which is a genuine contradiction
      // rather than a gap in the records.
      if (t.fault === 'not-received') continue;

      const { en, zh } = phrases(t);
      const pitch = t.known && !t.fault ? 1 : 0.8;
      say(en, 'en', pitch);
      say(zh, 'zh', pitch);
    }
  };

  useEffect(() => {
    if (enabled) return;
    // Switching voice off drops whatever was waiting: on the next switch-on it
    // would be stale, and reading out a passage from an hour ago is worse than
    // saying nothing.
    window.speechSynthesis?.cancel();
    clearTimers();
    pending.current = [];
  }, [enabled]);

  useEffect(() => clearTimers, []);

  // Collect the passage. Audio for the movement itself is the board's job now
  // (App.tsx onOutcome); this hook only buffers for the spoken readout.
  useEffect(() => {
    if (!enabled || entries.length === 0) return;
    const newest = entries[0];
    if (newest.id <= lastSeenId.current) return;
    const fresh = entries.filter((e) => e.id > lastSeenId.current).reverse();
    lastSeenId.current = newest.id;

    // The chime is NOT fired here any more. This hook only sees the raw passage,
    // so the best it could do was chime on `known` — which is "the bridge has a
    // catalogue row", not "this belongs to a document today". That made every
    // stray tag beep. It now fires from the board's own verdict; see the
    // onOutcome handler in App.tsx.
    pending.current.push(...fresh);

    // Re-arm on every movement: the fallback measures silence at the gate, not
    // time since the run started, so a long unload is never cut in half.
    if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    fallbackTimer.current = setTimeout(() => flush.current(), FLUSH_FALLBACK_MS);
  }, [entries, enabled]);

  // Announce. Both beams unbroken means nothing is in the doorway — that is the
  // moment the passage is over and the totals are final.
  useEffect(() => {
    if (!enabled || pending.current.length === 0) return;
    const clear = gpi.gpi1 === false && gpi.gpi2 === false;
    if (!clear) {
      // Something is back in the beams — this passage is still running.
      if (settleTimer.current) clearTimeout(settleTimer.current);
      settleTimer.current = null;
      return;
    }
    if (settleTimer.current) return; // already counting down on this clear edge
    settleTimer.current = setTimeout(() => flush.current(), GATE_CLEAR_SETTLE_MS);
  }, [gpi, entries, enabled]);
}
