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
const { writeFileAtomic } = require('./atomic-write');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');

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
    // Permanent identity of THIS gate. Together with the journal seq it forms
    // the immutable event id (`gateId:seq`) stamped on every movement before it
    // is journaled — the stable idempotency key that replaces time-window
    // dedupe once Nexus learns to store it. Never regenerated on restart or
    // replay: the id lives inside the journaled event itself.
    this.gateId = opts.gateId || 'gate-1';
    // dataDir is injectable so tests can run against a scratch directory
    // instead of the live journal.
    this.dataDir = opts.dataDir || DEFAULT_DATA_DIR;
    this._logPath = path.join(this.dataDir, 'movement-log.jsonl');
    this._archivePath = `${this._logPath}.1`;
    this._cursorPath = path.join(this.dataDir, 'movement-cursor.json');
    this._deadPath = path.join(this.dataDir, 'movement-dead.jsonl');
    this._quarantinePath = `${this._logPath}.quarantine`;

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
    this._tornRecovered = 0;
    this._journalCorrupt = false;
    this._enqueueFailures = 0;
    this._lastEnqueueError = null;

    this._restore();
  }

  /**
   * Repair a torn journal tail before anything reads it.
   *
   * Skipping a malformed final line at read time (readJsonl) is not enough:
   * the file is opened in APPEND mode, so the next enqueue would glue its
   * record onto the torn fragment — one crash mid-write would then cost two
   * events, the fragment AND the healthy record welded to it. So at boot:
   *
   *   - tail damage (everything after the last valid record is garbage, or a
   *     valid final record is missing its newline): quarantine the bytes to
   *     movement-log.jsonl.quarantine, truncate to the last complete record,
   *     fsync, and carry on — self-healing, counted in status.
   *   - INTERIOR damage (garbage with valid records after it): do NOT touch
   *     the file and do NOT deliver. A silent skip would advance the cursor
   *     past a record that physically happened; that needs a human. Enqueue
   *     still journals (durability first), only the pump is paused.
   *
   * Record lines are JSON.stringify output, which never contains raw
   * newlines, so splitting on '\n' is a faithful record boundary.
   */
  _repairJournal() {
    let buf;
    try {
      buf = fs.readFileSync(this._logPath);
    } catch {
      return; // no journal yet
    }
    if (buf.length === 0) return;
    const text = buf.toString('utf8');
    const parts = text.split('\n');
    const endsWithNewline = text.endsWith('\n');

    let lastValid = -1;
    let firstInvalid = -1;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '') continue; // blank padding is harmless
      let ok = true;
      try {
        JSON.parse(parts[i]);
      } catch {
        ok = false;
      }
      if (ok) lastValid = i;
      else if (firstInvalid === -1) firstInvalid = i;
    }

    if (firstInvalid === -1) {
      // Every record parses — but a valid final record with no trailing
      // newline is still a landmine (the next append glues onto it).
      if (!endsWithNewline && lastValid !== -1) {
        fs.appendFileSync(this._logPath, '\n');
        this._fsyncFile(this._logPath);
        this._tornRecovered += 1;
        this.log('journal repair: terminated an unterminated final record', 'warn');
      }
      return;
    }

    if (firstInvalid > lastValid) {
      // Torn tail: everything after the last valid record is fragment.
      let goodEnd = 0;
      for (let i = 0; i <= lastValid; i++) goodEnd += Buffer.byteLength(parts[i], 'utf8') + 1; // +1 = the newline
      const fragment = buf.slice(goodEnd);
      try {
        fs.appendFileSync(
          this._quarantinePath,
          `# quarantined ${new Date().toISOString()} (${fragment.length} bytes)\n` + fragment.toString('utf8') + '\n'
        );
      } catch (err) {
        this.log(`journal repair: quarantine write failed (${err.message}) — truncating anyway, fragment is in this log line: ${fragment.toString('utf8').slice(0, 300)}`, 'error');
      }
      fs.truncateSync(this._logPath, goodEnd);
      this._fsyncFile(this._logPath);
      this._tornRecovered += 1;
      this.log(`journal repair: torn tail (${fragment.length} bytes) quarantined to ${path.basename(this._quarantinePath)}, journal truncated to last complete record`, 'warn');
      return;
    }

    // Interior corruption: a bad record with good records AFTER it.
    this._journalCorrupt = true;
    this.log(
      `JOURNAL CORRUPT: record ~#${firstInvalid + 1} is unreadable with valid records after it. ` +
        'Delivery is PAUSED (enqueue still journals). Inspect movement-log.jsonl, remove or fix the bad line, and restart the bridge.',
      'error'
    );
  }

  /** fsync a file by path (used after truncate/append repairs). */
  _fsyncFile(p) {
    try {
      const fd = fs.openSync(p, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* repair still landed; fsync is belt-and-braces */ }
  }

  /** Rebuild pending state from the journal + cursor after a restart. */
  _restore() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch { /* already there */ }

    this._repairJournal();

    try {
      this.cursor = JSON.parse(fs.readFileSync(this._cursorPath, 'utf8')).seq || 0;
    } catch {
      this.cursor = 0; // missing/corrupt cursor => replay from the top, dedupe absorbs it
    }

    // The archive is read first so a rotation that happened mid-backlog still
    // yields the events in seq order.
    let maxSeq = 0;
    for (const file of [this._archivePath, this._logPath]) {
      for (const entry of readJsonl(file)) {
        if (!Number.isFinite(entry.seq)) continue;
        if (entry.seq > maxSeq) maxSeq = entry.seq;
        if (entry.seq > this.cursor) this.pending.push(entry);
      }
    }
    this.pending.sort((a, b) => a.seq - b.seq);
    this.nextSeq = maxSeq + 1;

    this.deadCount = readJsonl(this._deadPath).length;

    if (this.pending.length) {
      this.log(`outbox restored: ${this.pending.length} undelivered event(s) from seq ${this.pending[0].seq}`, 'warn');
    }
  }

  /**
   * Durably record a movement event, then wake the pump. Returns
   * { seq, eventId }. Throws only if the journal itself cannot be written —
   * the caller must treat that as "this event is NOT accepted" (no broadcast,
   * no counting), since nothing else is durable; the failure is also counted
   * in status() so a dying disk is visible, not a one-line log.
   */
  enqueue(event) {
    const seq = this.nextSeq;
    // Immutable identity, stamped BEFORE journaling so it survives restart and
    // replay byte-for-byte. Entries journaled by older bridge versions have no
    // eventId and are sent as-is — Nexus's time-window dedupe still covers them.
    if (event && typeof event === 'object' && !event.eventId) {
      event.gateId = this.gateId;
      event.seq = seq;
      event.eventId = `${this.gateId}:${seq}`;
    }
    const entry = { seq, at: new Date().toISOString(), event };
    try {
      this._rotateIfNeeded();
      if (this._fd == null) this._fd = fs.openSync(this._logPath, 'a');
      fs.writeSync(this._fd, JSON.stringify(entry) + '\n');
      fs.fsyncSync(this._fd); // durable BEFORE the network is touched — the whole point
    } catch (err) {
      this._enqueueFailures += 1;
      this._lastEnqueueError = err.message;
      throw err;
    }
    this.nextSeq = seq + 1;
    this.pending.push(entry);
    this._pump();
    return { seq, eventId: event?.eventId ?? null };
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
      size = fs.statSync(this._logPath).size;
    } catch {
      return; // no journal yet
    }
    if (size < MAX_LOG_BYTES || this.pending.length > 0) return;
    try {
      if (this._fd != null) {
        fs.closeSync(this._fd);
        this._fd = null;
      }
      fs.renameSync(this._logPath, this._archivePath);
      this.log(`movement journal rotated at ${(size / 1024 / 1024).toFixed(1)}MB`);
    } catch (err) {
      this.log(`movement journal rotate failed: ${err.message}`, 'warn');
    }
  }

  _writeCursor() {
    try {
      // Atomic: a plain write truncates first, so a kill mid-write would leave
      // an empty cursor and force a full (deduped, but slow) replay next boot.
      writeFileAtomic(this._cursorPath, JSON.stringify({ seq: this.cursor }) + '\n');
    } catch (err) {
      // Non-fatal: a stale cursor only costs redundant (deduped) POSTs later.
      this.log(`movement cursor write failed: ${err.message}`, 'warn');
    }
  }

  _deadLetter(entry, reason) {
    try {
      fs.appendFileSync(this._deadPath, JSON.stringify({ ...entry, reason, deadAt: new Date().toISOString() }) + '\n');
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
      const body = await res.text().catch(() => '');
      if (res.ok) {
        let reply;
        try {
          reply = JSON.parse(body);
        } catch {
          return { ok: false, terminal: false, error: `HTTP ${res.status}: invalid JSON acknowledgement` };
        }
        // Do not advance on "accepted/pending": the dashboard's provisional
        // overlay retires only when this strictly ordered queue reaches zero,
        // so every removed head must have completed its Nexus business effects.
        const acceptedStates = new Set(['applied', 'already_applied']);
        if (reply?.ok !== true || !acceptedStates.has(reply?.state)) {
          return {
            ok: false,
            terminal: false,
            error: `HTTP ${res.status}: invalid acknowledgement${body ? `: ${body.slice(0, 200)}` : ''}`,
          };
        }
        const expectedId = entry.event?.eventId;
        if (expectedId && reply.eventId !== expectedId) {
          return {
            ok: false,
            terminal: false,
            error: `HTTP ${res.status}: acknowledgement eventId mismatch (expected ${expectedId}, got ${reply.eventId ?? 'missing'})`,
          };
        }
        return { ok: true, state: reply.state };
      }
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
    // Interior journal corruption pauses delivery entirely: draining around an
    // unreadable record would advance the cursor past a passage that physically
    // happened. A human fixes the file, then restarts. (_repairJournal logged
    // the loud instruction at boot.)
    if (this._journalCorrupt) return;
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
   * Every journaled movement entry, archive first, in seq order. Read-only —
   * exists so the passage detector can rebuild its local INSIDE/OUTSIDE view
   * at boot from the gate's own history instead of starting amnesiac.
   */
  readJournal() {
    const out = [];
    for (const file of [this._archivePath, this._logPath]) out.push(...readJsonl(file));
    return out.filter((e) => Number.isFinite(e.seq)).sort((a, b) => a.seq - b.seq);
  }

  /**
   * Re-send delivered history. Safe by construction: Nexus dedupes on physical
   * passage time, so re-pushing everything yields zero duplicate rows. This is
   * the recovery path for a pump bug — "run replay", not "reconstruct data".
   */
  replay({ fromSeq, fromTimestamp } = {}) {
    const wanted = [];
    for (const file of [this._archivePath, this._logPath]) {
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
    let journalBytes = null;
    try {
      journalBytes = fs.statSync(this._logPath).size;
    } catch { /* no journal yet */ }
    return {
      configured: Boolean(this.url),
      url: this.url || null,
      gateId: this.gateId,
      queueDepth: this.pending.length,
      oldestPendingAt: this.pending[0]?.at ?? null,
      cursor: this.cursor,
      sent: this.sentCount,
      deadLetters: this.deadCount,
      lastPushAt: this.lastPushAt,
      lastError: this.lastError,
      // Journal health — the operational-visibility block. `healthy: false`
      // means either the disk is rejecting appends (enqueueFailures) or the
      // file has interior corruption and delivery is paused (corrupt).
      journal: {
        healthy: !this._journalCorrupt && this._enqueueFailures === 0,
        corrupt: this._journalCorrupt,
        bytes: journalBytes,
        tornRecovered: this._tornRecovered,
        enqueueFailures: this._enqueueFailures,
        lastEnqueueError: this._lastEnqueueError,
      },
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
