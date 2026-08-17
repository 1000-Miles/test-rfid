import { useEffect, useRef } from 'react';
import type { EntryRow, GpiState } from './types';
import { BRIDGE_HTTP } from './api';
import { chime, playClip } from './sound';

/** One spoken line: a product's carton total, a pallet, or an unknown-item warning. */
export interface VoiceLine {
  exit: boolean;
  known: boolean;
  /** true = a pallet, announced by name with no carton count. */
  pallet: boolean;
  name: string;
  count: number;
}

/**
 * Group a buffered passage into announcement lines — one line per product,
 * not one per carton. Pallets are never counted in cartons: each announces
 * by name. Unknown items collapse into one warning per direction.
 */
export function tally(buffer: EntryRow[]): VoiceLine[] {
  const lines = new Map<string, VoiceLine>();
  for (const e of buffer) {
    const exit = e.kind === 'exit';
    const pallet = e.item?.kind === 'pallet';
    const key = !e.known ? `unknown:${exit}` : pallet ? `pallet:${exit}:${e.item.name}:${e.epc}` : `sku:${exit}:${e.item.name}`;
    const line = lines.get(key);
    if (line) line.count += 1;
    else lines.set(key, { exit, known: e.known, pallet, name: e.known ? e.item.name : '', count: 1 });
  }
  return [...lines.values()];
}

/**
 * Announcement text per language. Product names are NOT translated — the
 * catalog stores them in English and there is nothing here to translate them
 * with, so the Mandarin voice reads the name verbatim after the Chinese
 * prefix ("已到达：Bunny Socks").
 */
export function phrases(line: VoiceLine) {
  const { exit } = line;
  if (!line.known) {
    const many = line.count > 1;
    return {
      en: `Warning: ${many ? `${line.count} unknown items` : 'unknown item'} ${exit ? 'left' : 'entered'} the warehouse`,
      zh: `警告：${many ? `${line.count}件未知物品` : '未知物品'}${exit ? '离开' : '进入'}仓库`,
    };
  }
  if (line.pallet) {
    return {
      en: exit ? `Checked out: ${line.name}` : `Arrived: ${line.name}`,
      zh: exit ? `已出库：${line.name}` : `已到达：${line.name}`,
    };
  }
  const cartons = `${line.count} ${line.count === 1 ? 'carton' : 'cartons'} of ${line.name}`;
  return {
    en: exit ? `Checked out: ${cartons}` : `Arrived: ${cartons}`,
    zh: exit ? `已出库：${line.count}箱 ${line.name}` : `已到达：${line.count}箱 ${line.name}`,
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

/** How long both beams must stay clear before the buffered passage is spoken.
 * A pallet breaks and re-makes the beams between cartons; firing on the first
 * clear edge would fragment one run into several readouts. */
const SETTLE_MS = 800;

/** Hard flush even if the beams never read clear — a reader with no GPIO or a
 * wiring fault must not silently disable all speech. */
const FALLBACK_FLUSH_MS = 12_000;

/**
 * Announce warehouse movements: a chime per movement (immediate confirmation a
 * tag was caught), then ONE spoken line per product once the passage is over —
 * both beams clear for SETTLE_MS, or FALLBACK_FLUSH_MS after the first
 * buffered movement, whichever comes first.
 *
 * Speech has two paths, tried in order per line:
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

  // The passage buffer. Refs, not state — the flusher polls them.
  const buffer = useRef<EntryRow[]>([]);
  const firstBufferedAt = useRef(0);
  const lastActivityAt = useRef(0); // last movement OR beam-broken sighting
  const gpiRef = useRef(gpi);
  gpiRef.current = gpi;

  useEffect(() => {
    if (!enabled) window.speechSynthesis?.cancel();
  }, [enabled]);

  // A broken beam means the passage is still in progress — hold the flush.
  useEffect(() => {
    if (gpi.gpi1 === true || gpi.gpi2 === true) lastActivityAt.current = Date.now();
  }, [gpi]);

  // Chime per movement, buffer the rest for the grouped readout.
  useEffect(() => {
    if (!enabled || entries.length === 0) return;
    const newest = entries[0];
    if (newest.id <= lastSeenId.current) return;
    const fresh = entries.filter((e) => e.id > lastSeenId.current).reverse();
    lastSeenId.current = newest.id;

    for (const e of fresh) chime(e.known ? 'ok' : 'alert');
    if (buffer.current.length === 0) firstBufferedAt.current = Date.now();
    buffer.current.push(...fresh);
    lastActivityAt.current = Date.now();
  }, [entries, enabled]);

  // The flusher: speak the buffered passage once the doorway is quiet.
  useEffect(() => {
    if (!enabled) return;

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

    const t = setInterval(() => {
      if (buffer.current.length === 0) return;
      const now = Date.now();
      const g = gpiRef.current;
      const bothClear = g.gpi1 !== true && g.gpi2 !== true; // null (no GPIO) reads as clear
      const settled = bothClear && now - lastActivityAt.current >= SETTLE_MS;
      const overdue = now - firstBufferedAt.current >= FALLBACK_FLUSH_MS;
      if (!settled && !overdue) return;

      const lines = tally(buffer.current);
      buffer.current = [];
      for (const line of lines) {
        const { en, zh } = phrases(line);
        const pitch = line.known ? 1 : 0.8;
        say(en, 'en', pitch);
        say(zh, 'zh', pitch);
      }
    }, 200);
    return () => clearInterval(t);
  }, [enabled]);
}
