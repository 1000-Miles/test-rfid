import { useEffect, useState } from 'react';
import { audioSupported, unlockAudio } from './sound';

/**
 * Whether this browser will actually let the board make a noise.
 *
 * Browsers refuse to play audio on a page nobody has interacted with, and the
 * refusal is silent — speak() returns normally and nothing comes out. On a
 * desk that never shows, because opening the console to switch voice on is
 * itself the interaction. On a wall-mounted TV it is the whole problem: the
 * page is opened by typing a URL, which does not count, so the board stays
 * mute forever with no indication why.
 *
 * Two things follow, and this hook does both:
 *
 *   - ANY input unlocks it, not a click on one small target. A TV remote emits
 *     keydown for its arrows and OK button, so pressing anything at all is
 *     enough — which matters because the plain <div> controls on this board
 *     cannot be focused with a D-pad, making the gear literally unreachable.
 *   - The state is reported, so the board can say "press any button" instead
 *     of failing silently.
 *
 * The priming utterance is spoken INSIDE the gesture handler and at zero
 * volume: some engines only lift the block when the first speak() happens in
 * the gesture's own call stack, so waiting for the next real movement is too
 * late.
 */
export type SoundState =
  /** Audio is unlocked; alerts will be heard. */
  | 'ready'
  /** Supported, but waiting for any key press or tap on this page. */
  | 'needs-gesture'
  /** This browser can make no sound at all — neither tones nor speech. */
  | 'unsupported';

export function useAudioGate(enabled: boolean): SoundState {
  const [gestured, setGestured] = useState(false);
  // Tones are the alert that matters, so Web Audio alone counts as supported:
  // TVBro (Android WebView) has no speech synthesis but does have Web Audio,
  // and on that device a board that beeps is the working outcome.
  const supported = typeof window !== 'undefined' && (audioSupported() || 'speechSynthesis' in window);

  useEffect(() => {
    if (!supported || !enabled || gestured) return;

    const unlock = () => {
      unlockAudio();
      try {
        if ('speechSynthesis' in window) {
          const prime = new SpeechSynthesisUtterance(' ');
          prime.volume = 0;
          window.speechSynthesis.speak(prime);
        }
      } catch {
        // Priming is best-effort — the gesture still counts either way.
      }
      setGestured(true);
    };

    // pointerdown/keydown cover mouse, touch and remote; passive so a TV
    // browser's scroll handling is never held up by this.
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, unlock, { once: true, passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, unlock));
  }, [supported, enabled, gestured]);

  if (!supported) return 'unsupported';
  return gestured ? 'ready' : 'needs-gesture';
}
