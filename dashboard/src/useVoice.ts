import { useEffect, useRef } from 'react';
import type { EntryRow } from './types';

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
 * Find an installed Mandarin voice.
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
      if (!voice.current && all.length) {
        // Loud on purpose: without a zh voice the Chinese half is silently
        // dropped, which looks identical to "the speaker is off".
        console.warn('[voice] no Mandarin voice installed — Chinese announcements will not play. Install the Chinese (Simplified) language pack in Windows Settings > Time & language > Language.');
      }
    };
    pick();
    window.speechSynthesis.addEventListener('voiceschanged', pick);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', pick);
  }, []);

  return voice;
}

/** Speak each new warehouse entry — English first, then Mandarin. */
export function useVoice(entries: EntryRow[], enabled: boolean) {
  const lastSpokenId = useRef(-1);
  const zhVoice = useZhVoice();

  useEffect(() => {
    if (!enabled) window.speechSynthesis?.cancel();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || entries.length === 0 || !('speechSynthesis' in window)) return;
    const newest = entries[0];
    if (newest.id <= lastSpokenId.current) return;
    const unspoken = entries.filter((e) => e.id > lastSpokenId.current).reverse();
    lastSpokenId.current = newest.id;
    for (const e of unspoken) {
      const { en, zh } = phrases(e);
      const pitch = e.known ? 1 : 0.8;

      const eng = new SpeechSynthesisUtterance(en);
      eng.rate = 1.05;
      eng.pitch = pitch;
      eng.lang = 'en-US';
      window.speechSynthesis.speak(eng);

      // speak() queues, so this plays after the English one finishes — no
      // timers needed to sequence them.
      const man = new SpeechSynthesisUtterance(zh);
      man.rate = 1.05;
      man.pitch = pitch;
      man.lang = 'zh-CN';
      if (zhVoice.current) man.voice = zhVoice.current;
      window.speechSynthesis.speak(man);
    }
  }, [entries, enabled]);
}
