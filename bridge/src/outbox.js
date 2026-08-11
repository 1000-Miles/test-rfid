'use strict';

/**
 * Outbox — durable, offline-first delivery of gate movement events to Nexus.
 *
 * The warehouse PC loses its WAN link; a passage that happened must not be lost
 * because of it. So durability comes from the APPEND, not from the sender:
 * every event is written to data/movement-log.jsonl and fsynced BEFORE any
 * network attempt. If the pump below is buggy or wedged, nothing is lost — the
 * journal has every event and `replay()` can re-send it.
 *
 * Why re-sending is always safe: POST /api/movement dedupes on PHYSICAL passage
 * time (it writes the bridge's `timestamp` into created_at and probes ±10s
 * around it), so an event replayed hours later still collapses onto the row it
 * already wrote. That single property is what makes at-least-once delivery the
 * right choice here — a duplicate POST is free, a lost passage is not.
 *
 * Ordering is a correctness constraint, not a preference: carton/pallet status
 * is last-write-wins with no timestamp guard, so draining an `out` after an
 * `in` for the same tag would leave a carton marked shipped while it is
 * physically inside. The pump therefore sends STRICTLY one at a time, in seq
 * order, and must never be parallelised for throughput.
 *
 * State:
 *   data/movement-log.jsonl    append-only journal, {seq, at, event} per line
 *   data/movement-cursor.json  last seq successfully delivered
 *   data/movement-dead.jsonl   events Nexus permanently rejected (400)
 *
 * A lost/corrupt cursor is recoverable (replay from the top, dedupe absorbs
 * it); a corrupt journal is not. That asymmetry is why the journal is only ever
 * appended to, and why rotation refuses to archive undelivered events.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_PATH = path.join(DATA_DIR, 'movement-log.jsonl');
const LOG_ARCHIVE = `${LOG_PATH}.1`;
const CURSOR_PATH = path.join(DATA_DIR, 'movement-cursor.json');
const DEAD_PATH = path.join(DATA_DIR, 'movement-dead.jsonl');

// Past this size the journal rotates to movement-log.jsonl.1 (one archive
// kept) — same policy as the printer's print-log. Rotation is skipped while
// undelivered events are still in the file so an archive can never hold one.
const MAX_LOG_BYTES = 4 * 1024 * 1024;

class Outbox extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.url = opts.url || '';
    this.apiKey = opts.apiKey || '';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.drainPerSec = opts.drainPerSec ?? 5;
    this.log = opts.log || (() => {});

    this.pending = []; // [{ seq, at, event }] — undelivered, oldest first
    this.cursor = 0; // last seq delivered (or dead-lettered)
    this.nextSeq = 1;
    this.deadCount = 0;
    this.lastPushAt = null;
    this.lastError = null;
    this.sentCount = 0;

    this._backoff = this.baseBackoffMs;
    this._pumping = false;
    this._stopped = false;
    this._fd = null;
    this._timer = null;

    this._restore();
  }

  /** Rebuild pending state from the journal + cursor after a restart. */
  _restore() {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch { /* already there */ }

    try {
      this.cursor = JSON.parse(fs.readFileSync(CURSOR_PATH, 'utf8')).seq || 0;
    } catch {
      this.cursor = 0; // missing/corrupt cursor => replay from the top, dedupe absorbs it
    }

    // The archive is read first so a rotation that happened mid-backlog still
    // yields the events in seq order.
    let maxSeq = 0;
    for (const file of [LOG_ARCHIVE, LOG_PATH]) {
      for (const entry of readJsonl(file)) {
        if (!Number.isFinite(entry.seq)) continue;
        if (entry.seq > maxSeq) maxSeq = entry.seq;
        if (entry.seq > this.cursor) this.pending.push(entry);
      }
    }
    this.pending.sort((a, b) => a.seq - b.seq);
    this.nextSeq = maxSeq + 1;

    this.deadCount = readJsonl(DEAD_PATH).length;

    if (this.pending.length) {
      this.log(`outbox restored: ${this.pending.length} undelivered event(s) from seq ${this.pending[0].seq}`, 'warn');
    }
  }

  /**
   * Durably record a movement event, then wake the pump. Returns the assigned
   * seq. Throws only if the journal itself cannot be written — the caller
   * should treat that as fatal for this event, since nothing else is durable.
   */
  enqueue(event) {
    const entry = { seq: this.nextSeq++, at: new Date().toISOString(), event };
    this._rotateIfNeeded();
    if (this._fd == null) this._fd = fs.openSync(LOG_PATH, 'a');
    fs.writeSync(this._fd, JSON.stringify(entry) + '\n');
    fs.fsyncSync(this._fd); // durable BEFORE the network is touched — the whole point
    this.pending.push(entry);
    this._pump();
    return entry.seq;
  }

  /**
   * Rotate once the journal is large AND fully delivered. Refusing to rotate
   * with pending events keeps "the archive is history, the log is live" true,
   * so a long outage grows the file rather than risking an undelivered event
   * being archived out from under the pump.
   */
  _rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(LOG_PATH).size;
    } catch {
      return; // no journal yet
    }
    if (size < MAX_LOG_BYTES || this.pending.length > 0) return;
    try {
      if (this._fd != null) {
        fs.closeSync(this._fd);
        this._fd = null;
      }
      fs.renameSync(LOG_PATH, LOG_ARCHIVE);
      this.log(`movement journal rotated at ${(size / 1024 / 1024).toFixed(1)}MB`);
    } catch (err) {
      this.log(`movement journal rotate failed: ${err.message}`, 'warn');
    }
  }

  _writeCursor() {
    try {
      fs.writeFileSync(CURSOR_PATH, JSON.stringify({ seq: this.cursor }) + '\n');
    } catch (err) {
      // Non-fatal: a stale cursor only costs redundant (deduped) POSTs later.
      this.log(`movement cursor write failed: ${err.message}`, 'warn');
    }
  }

  _deadLetter(entry, reason) {
    try {
      fs.appendFileSync(DEAD_PATH, JSON.stringify({ ...entry, reason, deadAt: new Date().toISOString() }) + '\n');
    } catch (err) {
      this.log(`dead-letter write failed: ${err.message}`, 'error');
    }
    this.deadCount += 1;
    this.log(`movement seq ${entry.seq} (${entry.event?.epc}) rejected permanently: ${reason}`, 'error');
  }

  /**
   * Deliver one event. Classification is the heart of the retry policy:
   *   400            -> terminal. The only response meaning "never acceptable".
   *   401 / 403 / 503 -> retryable. A misconfigured key is a human fix, and the
   *                      events stay perfectly valid while it is wrong.
   *   429 / 5xx / network / timeout -> retryable.
   */
  async _send(entry) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(entry.event),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.ok) return { ok: true };
      const body = await res.text().catch(() => '');
      const detail = `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`;
      if (res.status === 400) return { ok: false, terminal: true, error: detail };
      return { ok: false, terminal: false, error: detail };
    } catch (err) {
      const why = err.name === 'TimeoutError' ? `timeout after ${this.timeoutMs}ms` : err.message;
      return { ok: false, terminal: false, error: why };
    }
  }

  /**
   * Drain the queue head-first. Retries the SAME head with capped backoff until
   * it succeeds or is dead-lettered — never skipping ahead, because order is a
   * correctness constraint (see the file header).
   */
  async _pump() {
    if (this._pumping || this._stopped || !this.url) return;
    this._pumping = true;
    try {
      while (this.pending.length && !this._stopped) {
        const entry = this.pending[0];
        const result = await this._send(entry);

        if (result.ok) {
          this.pending.shift();
          this.cursor = entry.seq;
          this._writeCursor();
          this.sentCount += 1;
          this.lastPushAt = new Date().toISOString();
          this.lastError = null;
          this._backoff = this.baseBackoffMs;
          this.emit('sent', entry);
          // Throttle the drain so a reconnect after a long outage doesn't
          // flood Nexus. Nothing here is time-critical once it is already late.
          if (this.pending.length) await sleep(1000 / this.drainPerSec);
          continue;
        }

        if (result.terminal) {
          this.pending.shift();
          this._deadLetter(entry, result.error);
          this.cursor = entry.seq;
          this._writeCursor();
          continue;
        }

        this.lastError = result.error;
        this.log(`movement push failed (seq ${entry.seq}), retrying in ${this._backoff}ms: ${result.error}`, 'warn');
        await sleep(this._backoff);
        this._backoff = Math.min(this.maxBackoffMs, this._backoff * 2);
      }
    } finally {
      this._pumping = false;
    }
  }

  /** Periodic wake, so a queue stalled on backoff or a late-set URL recovers. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._pump(), 15_000);
    if (this._timer.unref) this._timer.unref();
    this._pump();
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._fd != null) {
      try { fs.closeSync(this._fd); } catch { /* closing on shutdown */ }
      this._fd = null;
    }
  }

  /**
   * Re-send delivered history. Safe by construction: Nexus dedupes on physical
   * passage time, so re-pushing everything yields zero duplicate rows. This is
   * the recovery path for a pump bug — "run replay", not "reconstruct data".
   */
  replay({ fromSeq, fromTimestamp } = {}) {
    const wanted = [];
    for (const file of [LOG_ARCHIVE, LOG_PATH]) {
      for (const entry of readJsonl(file)) {
        if (!Number.isFinite(entry.seq)) continue;
        if (fromSeq != null && entry.seq < fromSeq) continue;
        if (fromTimestamp != null && entry.at < fromTimestamp) continue;
        if (entry.seq > this.cursor) continue; // already queued — don't double-queue
        wanted.push(entry);
      }
    }
    wanted.sort((a, b) => a.seq - b.seq);
    // Re-queued ahead of nothing: pending is empty-or-newer, and these carry
    // lower seqs, so keeping the array sorted preserves send order.
    this.pending.push(...wanted);
    this.pending.sort((a, b) => a.seq - b.seq);
    this._pump();
    return wanted.length;
  }

  status() {
    return {
      configured: Boolean(this.url),
      url: this.url || null,
      queueDepth: this.pending.length,
      oldestPendingAt: this.pending[0]?.at ?? null,
      cursor: this.cursor,
      sent: this.sentCount,
      deadLetters: this.deadCount,
      lastPushAt: this.lastPushAt,
      lastError: this.lastError,
    };
  }
}

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A torn final line from a hard kill mid-append: skip it rather than
      // refusing to boot. Everything before it is intact.
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Outbox };
