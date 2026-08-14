import { useEffect, useRef } from 'react';
import type { EntryRow } from './types';
import { BRIDGE_HTTP } from './api';
import { chime, playClip } from './sound';

/**
 * Announcement text per language. Product names are NOT translated — the
 * catalog stores them in English and there is nothing here to translate them
 * with, so the Mandarin voice reads the name verbatim after the Chinese
 * prefix ("已到达：Bunny Socks").
 */
function phrases(e: EntryRow) {
  const exit = e.kind === 'exit';
  if (!e.known) {
    return {
      en: `Warning: unknown item ${exit ? 'left' : 'entered'} the warehouse`,
      zh: `警告：未知物品${exit ? '离开' : '进入'}仓库`,
    };
  }
  return {
    en: exit ? `Checked out: ${e.item.name}` : `Arrived: ${e.item.name}`,
    zh: exit ? `已出库：${e.item.name}` : `已到达：${e.item.name}`,
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
  const res = await fetch(`${BRIDGE_HTTP}/tts?text=${encodeURIComponent(text)}&lang=${lang}`, {
    // Bounded: a hung request must not dam the queue while pallets keep coming.
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`tts ${res.status}`);
  return res.arrayBuffer();
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
 * Announce each new warehouse movement: a tone always, the spoken lines where
 * the browser can manage them.
 *
 * The tone is not a fallback that waits to see whether speech failed — it
 * always plays, because the tone is the part that carries across a warehouse
 * and across languages. Speech, when present, adds the detail on top.
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
export function useVoice(entries: EntryRow[], enabled: boolean) {
  const lastSpokenId = useRef(-1);
  const zhVoice = useZhVoice();
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    if (!enabled) window.speechSynthesis?.cancel();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || entries.length === 0) return;
    const newest = entries[0];
    if (newest.id <= lastSpokenId.current) return;
    const unspoken = entries.filter((e) => e.id > lastSpokenId.current).reverse();
    lastSpokenId.current = newest.id;

    const say = (text: string, lang: 'en' | 'zh', pitch: number) => {
      queue.current = queue.current
        .then(async () => {
          try {
            await playClip(await fetchSpeech(text, lang));
          } catch {
            await speakLocal(text, lang, pitch, zhVoice.current);
          }
        })
        // A failed line must never wedge the queue for every later one.
        .catch(() => {});
    };

    for (const e of unspoken) {
      chime(e.known ? 'ok' : 'alert');
      const { en, zh } = phrases(e);
      const pitch = e.known ? 1 : 0.8;
      say(en, 'en', pitch);
      say(zh, 'zh', pitch);
    }
  }, [entries, enabled]);
}
