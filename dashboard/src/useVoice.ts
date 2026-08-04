import { useEffect, useRef } from 'react';
import type { EntryRow } from './types';

/** Speak each new warehouse entry via the browser's speech synthesis. */
export function useVoice(entries: EntryRow[], enabled: boolean) {
  const lastSpokenId = useRef(-1);

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
      const text = !e.known
        ? `Warning: unknown item ${e.kind === 'exit' ? 'left' : 'entered'} the warehouse`
        : e.kind === 'exit'
          ? `Checked out: ${e.item.name}`
          : `Checked in: ${e.item.name}`;
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      u.pitch = e.known ? 1 : 0.8;
      window.speechSynthesis.speak(u);
    }
  }, [entries, enabled]);
}
