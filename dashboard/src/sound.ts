/**
 * Alert tones, synthesized in the browser. The board's only sound.
 *
 * There used to be a spoken readout on top of this — synthesised on the bridge
 * and fetched as an MP3, because the gate's display is a smart TV running
 * TVBro (Android WebView), which ships no speech engine and so made
 * `speechSynthesis.speak()` silence with no error. That whole path is gone: the
 * tone was always the part that did the work, and speech had been switched off
 * in the board for long enough to prove the tone was enough on its own.
 *
 * A tone is the better alert on its merits here anyway: it carries across a
 * noisy warehouse, it is recognised faster than a sentence, and it means the
 * same thing to English- and Mandarin-speaking staff — no announcement wording
 * to translate and nothing that has to reach a synth service to be heard.
 *
 * No audio files: an oscillator needs no asset to fetch, no format negotiation,
 * and no decode — one less thing to fail on an unattended panel.
 */

let ctx: AudioContext | null = null;

/** The AudioContext, created lazily. Null if this browser has no Web Audio. */
function audio(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

export const audioSupported = () =>
  typeof window !== 'undefined' && Boolean(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext);

/**
 * Create and resume the context from inside a user gesture.
 *
 * A context created before any interaction starts 'suspended', and resuming it
 * later — when a tag is actually read — is refused. It has to happen in the
 * gesture's own call stack, which is why useAudioGate calls this and not the
 * first movement.
 */
export function unlockAudio() {
  const a = audio();
  if (a && a.state === 'suspended') void a.resume();
}

/** One note. `t` is an offset in seconds from now. */
function tone(a: AudioContext, freq: number, start: number, dur: number, gain: number, type: OscillatorType) {
  const osc = a.createOscillator();
  const vol = a.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(vol);
  vol.connect(a.destination);

  const t0 = a.currentTime + start;
  // Ramped, not switched: a square wave started at full gain clicks, and on a
  // TV speaker the click is louder than the note.
  vol.gain.setValueAtTime(0.0001, t0);
  vol.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  vol.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/**
 * `alert` — an unknown tag: two urgent descending square-wave notes, the sound
 * of something being wrong, deliberately unlike the rest of the board.
 * `ok` — a normal counted carton: one short soft blip, easy to hear a hundred
 * times a shift without wearing anyone down.
 */
export function chime(kind: 'ok' | 'alert') {
  const a = audio();
  if (!a) return;
  if (a.state === 'suspended') void a.resume(); // best effort; may be refused

  if (kind === 'alert') {
    tone(a, 880, 0, 0.18, 0.28, 'square');
    tone(a, 620, 0.2, 0.28, 0.28, 'square');
  } else {
    tone(a, 1120, 0, 0.09, 0.13, 'sine');
  }
}
