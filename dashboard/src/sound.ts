/**
 * Alert tones, synthesized in the browser.
 *
 * Speech is the nice-to-have; THIS is the part that has to work. The gate's
 * display is a smart TV running TVBro, which is built on Android WebView — and
 * WebView ships no speech synthesis at all, so `speechSynthesis.speak()` there
 * is silence with no error. Web Audio it does have.
 *
 * A tone is also the better alert on its own merits here: it carries across a
 * noisy warehouse, it is recognised faster than a sentence, and it means the
 * same thing to English- and Mandarin-speaking staff. The spoken line still
 * plays on top wherever speech works, for the detail.
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
/**
 * Decode and play one audio clip (the bridge's TTS MP3s) through the same
 * AudioContext the chimes use — so the one remote-button unlock covers speech
 * too. Resolves when playback finishes, which is what lets the caller queue
 * English-then-Mandarin without timers. Rejects if this browser has no Web
 * Audio or the data does not decode.
 */
export async function playClip(data: ArrayBuffer): Promise<void> {
  const a = audio();
  if (!a) throw new Error('no Web Audio');
  if (a.state === 'suspended') void a.resume(); // best effort; may be refused
  // Callback form, not the promise form: old WebView/Chromium builds (the TV)
  // implement only the original callback signature.
  const buf = await new Promise<AudioBuffer>((resolve, reject) => {
    a.decodeAudioData(data, resolve, (e) => reject(e || new Error('decodeAudioData failed')));
  });
  await new Promise<void>((resolve) => {
    const src = a.createBufferSource();
    src.buffer = buf;
    src.connect(a.destination);
    src.onended = () => resolve();
    src.start();
  });
}

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
