import { useEffect, useState } from 'react';
import { audioSupported, unlockAudio } from './sound';

/**
 * Whether this browser will actually let the board make a noise.
 *
 * Browsers refuse to play audio on a page nobody has interacted with, and the
 * refusal is silent — the tone is scheduled, returns normally, and nothing
 * comes out. On a
 * desk that never shows, because opening the console to switch sound on is
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
 *     of failing silently. That report is not optional decoration: the whole
 *     mechanism is invisible without it, and a board rendered without the chip
 *     is a board that stays mute with nothing on screen to explain why.
 *
 * unlockAudio() is called INSIDE the gesture handler, not on the next movement:
 * a suspended AudioContext will only resume from within the gesture's own call
 * stack, so resuming when a tag is finally read is already too late.
 */
export type SoundState =
  /** Audio is unlocked; alerts will be heard. */
  | 'ready'
  /** Supported, but waiting for any key press or tap on this page. */
  | 'needs-gesture'
  /** This browser has no Web Audio, so it can make no sound at all. */
  | 'unsupported';

export function useAudioGate(enabled: boolean): SoundState {
  const [gestured, setGestured] = useState(false);
  // Web Audio is the whole test now. The tone IS the alert — there is no longer
  // a speech path to fall back to — so a browser without Web Audio can make no
  // sound at all and must say so rather than sit on 'needs-gesture' forever,
  // telling the operator to press something that will not help.
  const supported = typeof window !== 'undefined' && audioSupported();

  useEffect(() => {
    if (!supported || !enabled || gestured) return;

    const unlock = () => {
      unlockAudio();
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
