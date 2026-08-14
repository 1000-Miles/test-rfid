'use strict';

/**
 * Server-side text-to-speech for the gate board.
 *
 * The wallboard TV's browser (Edge for Android, TVBro, anything WebView-based)
 * ships no OS speech engine, so `speechSynthesis.speak()` there is silence with
 * no error. The fix is to move the synthesis to this PC: the board asks
 * GET /tts?text=...&lang=en|zh and gets back an MP3, which any browser can
 * play. Synthesis uses Microsoft's Edge Read-Aloud service (the same neural
 * voices desktop Edge uses for "Read aloud") via msedge-tts — free, but ONLINE:
 * no internet means a synth failure, which the route reports as an error so the
 * board can fall back to whatever local speech it has.
 *
 * Every phrase is cached on disk forever. Product names repeat constantly, so
 * after the first day of traffic almost every announcement is a cache hit —
 * instant, and immune to the internet being down.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const VOICES = {
  en: process.env.TTS_VOICE_EN || 'en-US-JennyNeural',
  zh: process.env.TTS_VOICE_ZH || 'zh-CN-XiaoxiaoNeural',
};

const CACHE_DIR = path.join(__dirname, '..', 'data', 'tts-cache');

// Announcements are one short sentence; anything longer is a mistake upstream
// and would just burn synth time on the unattended path.
const MAX_TEXT_LEN = 300;

/** In-flight synth promises, keyed like the disk cache, so a burst of pallets
 * announcing the same product synthesises once instead of N times. */
const inFlight = new Map();

function cacheKey(voice, text) {
  return crypto.createHash('sha1').update(`${voice}\n${text}`).digest('hex');
}

/** The SSML template interpolates the text into XML, so escape it. */
function escapeXml(s) {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

async function synthesize(voice, text) {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(escapeXml(text));
    const chunks = [];
    for await (const chunk of audioStream) chunks.push(chunk);
    const buf = Buffer.concat(chunks);
    // The service occasionally closes the stream early with nothing in it;
    // an empty MP3 must not be cached or the phrase is silent forever.
    if (buf.length < 200) throw new Error(`synth returned ${buf.length} bytes`);
    return buf;
  } finally {
    tts.close();
  }
}

/**
 * MP3 for (text, lang), from disk cache or freshly synthesised.
 * Throws when offline / the service misbehaves — callers decide how to degrade.
 */
async function speech(text, lang) {
  const voice = VOICES[lang] || VOICES.en;
  const key = cacheKey(voice, text);
  const file = path.join(CACHE_DIR, `${key}.mp3`);

  try {
    return await fs.promises.readFile(file);
  } catch {
    // cache miss — fall through to synth
  }

  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    const buf = await synthesize(voice, text);
    await fs.promises.mkdir(CACHE_DIR, { recursive: true });
    // Write via a temp name then rename: a crash mid-write must not leave a
    // truncated MP3 that would then be served from cache forever.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
    return buf;
  })();
  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}

/** Express handler for GET /tts?text=...&lang=en|zh */
async function handleTtsRequest(req, res, log) {
  const text = String(req.query.text || '').trim();
  const lang = req.query.lang === 'zh' ? 'zh' : 'en';
  if (!text) return res.status(400).json({ ok: false, error: 'text query param required' });
  if (text.length > MAX_TEXT_LEN) return res.status(400).json({ ok: false, error: `text too long (max ${MAX_TEXT_LEN})` });

  try {
    const buf = await speech(text, lang);
    res.set({
      'Content-Type': 'audio/mpeg',
      // Immutable by construction: same text+voice is always the same file, so
      // let the board's browser cache it and skip the round-trip entirely.
      'Cache-Control': 'public, max-age=604800, immutable',
    });
    res.send(buf);
  } catch (err) {
    log?.(`[tts] synth failed for "${text.slice(0, 60)}": ${err.message}`, 'warn');
    res.status(502).json({ ok: false, error: err.message });
  }
}

module.exports = { handleTtsRequest, speech, VOICES };
