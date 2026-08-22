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

/**
 * Per-product carton counts for one pallet's queued entries.
 *
 * Grouped by SKU rather than name: the SKU is the identity Nexus reconciles on,
 * and two products can legitimately share a display name. The name rides along
 * for display only. Unregistered tags already carry a synthetic sku from
 * passage.js, so they group as their own visible line instead of silently
 * dropping out — the counts here must always sum to cartonCount, or the card
 * would tell an operator a pallet holds fewer cartons than it does.
 */
function productBreakdown(entries) {
  const bySku = new Map();
  for (const entry of entries) {
    const item = entry.event?.item;
    const sku = item?.sku || 'UNKNOWN-SKU';
    const seen = bySku.get(sku);
    if (seen) seen.cartons += 1;
    else bySku.set(sku, { sku, name: item?.name || 'Unregistered item', cartons: 1 });
  }
  // Biggest line first — an operator eyeballing a pallet checks the bulk SKUs.
  return [...bySku.values()].sort((a, b) => b.cartons - a.cartons || a.sku.localeCompare(b.sku));
}

class Outbox extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.url = opts.url || '';
    this.batchUrl = opts.batchUrl || '';
    this.apiKey = opts.apiKey || '';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.baseBackoffMs = opts.baseBackoffMs ?? 1_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 60_000;
    this.drainPerSec = opts.drainPerSec ?? 5;
    this.batchSettleMs = opts.batchSettleMs ?? 500;
    this.toggleBatchQuietMs = opts.toggleBatchQuietMs ?? 1_500;
    this.togglePalletWindowMs = opts.togglePalletWindowMs ?? 120_000;
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
    this._openPalletPath = path.join(this.dataDir, 'movement-open-pallet.json');
    // Pallet numbering is its OWN durable counter, not the movement sequence.
    // Operators read this number off a label and say it out loud, so it has to
    // start at 1 and count pallets — the movement seq counts cartons and was
    // already past 300 on day one.
    this._palletSeqPath = path.join(this.dataDir, 'pallet-seq.json');
    // Survives wipes ON PURPOSE — see _loadGeneration.
    this._generationPath = path.join(this.dataDir, 'movement-generation.json');
    this.generation = this._loadGeneration();
    // Short gate code carried in every pallet code. The counter is per-gate and
    // local, so this prefix is the ONLY thing keeping two gates from both
    // minting 001. Kept to a couple of characters because it is read aloud and
    // printed on a label people scan, not just stored.
    this.gateShort =
      String(opts.gateShort || 'G1')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '')
        .slice(0, 4) || 'G1';
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
    this._batchTimer = null;
    this._palletTimer = null;
    this._tornRecovered = 0;
    this._journalCorrupt = false;
    this._enqueueFailures = 0;
    this._lastEnqueueError = null;
    this._passageRequestIds = new Map();
    this._passagePalletCodes = new Map();
    this._readyEmitted = new Set();
    this._togglePassage = null;

    this._restore();
    this._restoreOpenPallet();
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

  /**
   * Which "life" of the journal this is. Incremented by every wipe and never
   * reset, so a sequence starting again at 1 still yields event IDs the server
   * has never seen. This file is the one thing a wipe must NOT delete.
   */
  _loadGeneration() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._generationPath, 'utf8'));
      if (Number.isFinite(raw?.generation) && raw.generation >= 1) return Math.floor(raw.generation);
    } catch (_) {
      /* first run, or unreadable — 1 is the safe start */
    }
    return 1;
  }

  _bumpGeneration() {
    this.generation += 1;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      writeFileAtomic(this._generationPath, JSON.stringify({ generation: this.generation }) + '\n');
    } catch (err) {
      // Unpersisted, the next boot reverts and IDs collide again — loud, not silent.
      this.log(`generation write failed (${err.message}) — event IDs may collide with the server after a restart`, 'warn');
    }
    return this.generation;
  }

  /**
   * The next durable pallet code: PALLET-G1-001, PALLET-G1-002, …
   *
   * Short on purpose. This string IS the barcode and the caption on the label,
   * and it is what someone reads down a radio; the old
   * PLT-YIWU-MAIN-GATE-00000319 was none of those things comfortably.
   *
   * The counter is written to disk BEFORE the code is handed out, because the
   * failure that matters is a reboot re-issuing a number: two physical pallets
   * sharing a code merge into one in Nexus, and no later reconciliation can
   * separate them. Losing a number to a crash is harmless by comparison — the
   * sequence is allowed to skip.
   *
   * Uniqueness across gates rests entirely on `gateShort` (GATE_SHORT), because
   * the counter itself is local to this bridge. Two gates sharing a short code
   * WILL mint the same pallet code and merge two physical pallets in Nexus, so
   * give every gate its own and never reuse a retired one.
   */
  _nextPalletCode() {
    // NOTE: the format is dictated by NEXUS, which validates palletCode and
    // rejects anything else with 400 {"fieldErrors":{"palletCode":["Invalid"]}}.
    // A shorter code (PALLET-G1-001) was tried and every carton carrying one was
    // dead-lettered — the gate read them, the board counted them, and the server
    // refused them. Do not change this shape without changing Nexus first.
    //
    // The human-readable short name still exists: palletCaption() in
    // printer/tspl.js and palletName() in the dashboard both render this as
    // "PALLET-526", so the label and screen stay readable while the wire format
    // stays valid.
    let next = 1;
    try {
      const raw = JSON.parse(fs.readFileSync(this._palletSeqPath, 'utf8'));
      if (Number.isFinite(raw?.seq) && raw.seq >= 0) next = Math.floor(raw.seq) + 1;
    } catch (_) {
      // No counter yet (first pallet) or an unreadable one. Starting from 1 is
      // right for the first case; for the second it risks a repeat, so say so
      // loudly rather than silently reusing numbers.
      if (fs.existsSync(this._palletSeqPath)) {
        this.log('pallet counter unreadable — restarting at 1, codes may repeat', 'warn');
      }
    }
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      writeFileAtomic(this._palletSeqPath, JSON.stringify({ seq: next }) + '\n');
    } catch (err) {
      // Durability is the whole point, so a failed write must not be papered
      // over: the caller still gets a code, but the next boot may reuse it.
      this.log(`pallet counter write failed (${err.message}) — ${next} may be reissued after a restart`, 'warn');
    }
    const gate = this.gateId.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 18) || 'GATE';
    return `PLT-${gate}-${String(next).padStart(8, '0')}`;
  }

  /**
   * Throw away every trace of local receiving state.
   *
   * For the case where Nexus has been reset: the server forgets the passages,
   * and anything still held here would either be re-pushed into a database that
   * no longer expects it, or sit in a queue forever waiting on rows that are
   * gone. Wiping only one side leaves the two permanently disagreeing, which is
   * worse than either being empty.
   *
   * Deliberately IRREVERSIBLE and deliberately not automatic — undelivered
   * passages are real warehouse events, so this must be an explicit act by
   * someone who knows the server was reset too.
   *
   * What survives: the tag catalogue (Nexus's own registry, re-fetched anyway)
   * and printer settings. Neither is receiving state.
   */
  wipeLocalState() {
    const removed = [];
    // Close the journal handle first, or the unlink leaves this process writing
    // to a file nobody can see and the "wiped" log quietly refills.
    try {
      if (this._fd != null) {
        fs.closeSync(this._fd);
        this._fd = null;
      }
    } catch (_) {
      /* already closed */
    }
    for (const file of [this._logPath, this._cursorPath, this._deadPath, this._openPalletPath, this._palletSeqPath]) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          removed.push(path.basename(file));
        }
      } catch (err) {
        this.log(`wipe: could not remove ${path.basename(file)} (${err.message})`, 'warn');
      }
    }
    // In-memory state must go too. Clearing the files alone was the trap: this
    // process rewrites them from memory moments later, so the wipe appeared to
    // work and then undid itself.
    this.pending = [];
    this.cursor = 0;
    this.nextSeq = 1;
    // The sequence restarts, so the generation MUST advance or the new events
    // collide with the server's memory of the old ones.
    this._bumpGeneration();
    this.lastError = null;
    this.lastPushAt = null;
    this.sent = 0;
    this.deadLetters = 0;
    this._passageRequestIds.clear();
    this._passagePalletCodes.clear();
    this._readyEmitted.clear();
    this._openPallet = null;
    this.log(`local state wiped: ${removed.join(', ') || 'nothing on disk'}; queue, cursor and pallet numbering reset`);
    return { removed, queueDepth: 0, cursor: 0, nextSeq: 1 };
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
        // Same rule as enqueue: contested passages are history, never traffic.
        // Skipping them here is also the repair path for a queue already jammed
        // by ones journaled before this rule existed.
        if (entry.seq > this.cursor && !entry.event?.unexpected) this.pending.push(entry);
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
    // In no-IR receiving mode the first carton opens a fixed two-minute pallet
    // session. Quiet RFID gaps only settle the UI; they never close the pallet.
    // `!event.unexpected` is what keeps a contested carton OUT OF THE PALLET.
    // Without it, a product on no open receiving batch opened a pallet session
    // and was counted into it, so the pallet card, the count in the console and
    // the PRINTED PALLET TAG all said 8 cartons when only 4 were receivable —
    // and the tag listed products nobody had booked. It is still journaled and
    // still delivered on the plain path below; it just cannot become part of a
    // pallet that staff put away.
    if (this.batchUrl && event?.method === 'toggle' && event.direction === 'in' && event.passageId == null && !event.unexpected) {
      if (!this._togglePassage) {
        const openedAt = new Date();
        this._togglePassage = {
          id: `toggle-${seq}`,
          openedAt: openedAt.toISOString(),
          closesAt: new Date(openedAt.getTime() + this.togglePalletWindowMs).toISOString(),
        };
      }
      event.passageId = this._togglePassage.id;
      event.syntheticPassage = true;
      event.palletSession = true;
      event.palletOpenedAt = this._togglePassage.openedAt;
      event.palletClosesAt = this._togglePassage.closesAt;
    }
    // Immutable identity, stamped BEFORE journaling so it survives restart and
    // replay byte-for-byte. Entries journaled by older bridge versions have no
    // eventId and are sent as-is — Nexus's time-window dedupe still covers them.
    if (event && typeof event === 'object' && !event.eventId) {
      event.gateId = this.gateId;
      event.seq = seq;
      // Generation-scoped, because `seq` restarts at 1 after a local wipe while
      // NEXUS REMEMBERS EVERYTHING. Without it the first carton after a wipe
      // reuses eventId gate:1 for a different payload, Nexus rightly answers
      // 409 conflict, and the queue jams on event one — every reading after a
      // reset silently fails to arrive.
      event.eventId = `${this.gateId}:g${this.generation}:${seq}`;
    }
    if (event && event.passageId != null && !event.passageRequestId) {
      const key = `${event.direction}:${event.passageId}`;
      let requestId = this._passageRequestIds.get(key);
      if (!requestId) {
        // Controller passage numbers restart at 1 after a reboot; the durable
        // movement sequence does not. Basing the request identity on seq avoids
        // colliding with an old "passage 1" from a previous process lifetime.
        requestId = `${this.gateId}:passage:${seq}`;
        this._passageRequestIds.set(key, requestId);
      }
      event.passageRequestId = requestId;
      let palletCode = this._passagePalletCodes.get(key);
      if (!palletCode) {
        palletCode = this._nextPalletCode();
        this._passagePalletCodes.set(key, palletCode);
      }
      event.palletCode = palletCode;
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
    // JOURNALED BUT NOT QUEUED. A contested passage is a local record, not
    // something Nexus is willing to take: the batch endpoint answers a passage
    // it cannot resolve with `503 passage resolved to 0 receiving batches`,
    // which the pump correctly treats as retryable — so a single Test Product
    // in a passage jammed the whole queue behind it and NOTHING was delivered,
    // legitimate receipts included. Nexus creates no carton row for these
    // anyway, so sending them buys nothing and costs everything.
    //
    // The journal above is still the durable record, and the console, the
    // wallboard and the bridge log all still show them.
    if (event?.unexpected) return { seq, eventId: event?.eventId ?? null };
    this.pending.push(entry);
    if (event?.palletSession) {
      this._togglePassage.requestId = event.passageRequestId;
      this._togglePassage.palletCode = event.palletCode;
      this._writeOpenPallet();
      this._schedulePalletDeadline();
      if (this._batchTimer) clearTimeout(this._batchTimer);
      const passageId = event.passageId;
      this._batchTimer = setTimeout(() => {
        this._batchTimer = null;
        this._emitPalletOpen(passageId);
      }, this.toggleBatchQuietMs);
      this._batchTimer.unref?.();
      this._emitPalletOpen(passageId);
      return { seq, eventId: event?.eventId ?? null };
    }
    // IR reads for one physical pallet arrive as a short burst. Debounce that
    // burst so the pump can deliver the whole passage in one request. Events
    // without a passage boundary retain the immediate legacy path.
    if (this.batchUrl && event?.passageId != null) {
      if (this._batchTimer) clearTimeout(this._batchTimer);
      const settleMs = event.syntheticPassage ? this.toggleBatchQuietMs : this.batchSettleMs;
      const closingPassageId = event.passageId;
      this._batchTimer = setTimeout(() => {
        this._batchTimer = null;
        if (this._togglePassage?.id === closingPassageId) this._togglePassage = null;
        this._emitBatchReady(closingPassageId);
        this._pump();
      }, settleMs);
      if (this._batchTimer.unref) this._batchTimer.unref();
    } else {
      this._pump();
    }
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

  /** The controller observed both beams clear, so no more tags can join this
   * physical passage. Flush immediately instead of waiting for the safety
   * debounce. */
  flushPassage(passageId) {
    if (!this.batchUrl || passageId == null) return;
    if (this._batchTimer) clearTimeout(this._batchTimer);
    this._batchTimer = null;
    if (this._togglePassage?.id === passageId) this._togglePassage = null;
    this._emitBatchReady(passageId);
    this._pump();
  }

  /**
   * The queued entries for a passage that may legitimately go ON a pallet.
   *
   * Contested passages are excluded HERE as well as at the session gate above,
   * because the two modes get their passageId from different places: in no-IR
   * mode the gate refuses to open a session for a contested carton, but under IR
   * the passage id comes from the controller and a contested carton genuinely
   * shares it with its neighbours. One selector means the carton count, the
   * per-product breakdown and the printed tag can never disagree about what is
   * on the pallet.
   */
  pallettableEntries(passageId) {
    return this.pending.filter((entry) => entry.event?.passageId === passageId && !entry.event?.unexpected);
  }

  _restoreOpenPallet() {
    let saved;
    try { saved = JSON.parse(fs.readFileSync(this._openPalletPath, 'utf8')); }
    catch { return; }
    const firstMatching = this.pending.find((entry) => entry.event?.passageId === saved?.id);
    const closesAt = Date.parse(saved?.closesAt);
    if (!firstMatching || !Number.isFinite(closesAt) || closesAt <= Date.now()) {
      try { fs.unlinkSync(this._openPalletPath); } catch { /* already absent */ }
      return;
    }
    this._togglePassage = saved;
    const first = firstMatching.event;
    const key = `${first.direction}:${first.passageId}`;
    if (first.passageRequestId) this._passageRequestIds.set(key, first.passageRequestId);
    if (first.palletCode) this._passagePalletCodes.set(key, first.palletCode);
  }

  _writeOpenPallet() {
    try {
      writeFileAtomic(this._openPalletPath, JSON.stringify(this._togglePassage) + '\n');
    } catch (err) {
      this.log(`open pallet state write failed: ${err.message}`, 'error');
    }
  }

  _schedulePalletDeadline() {
    if (!this._togglePassage) return;
    if (this._palletTimer) clearTimeout(this._palletTimer);
    const delay = Math.max(0, Date.parse(this._togglePassage.closesAt) - Date.now());
    this._palletTimer = setTimeout(() => this.closeTogglePallet({ reason: 'timeout' }), delay);
    this._palletTimer.unref?.();
  }

  openPallet() {
    if (!this._togglePassage) return null;
    const entries = this.pallettableEntries(this._togglePassage.id);
    if (!entries.length) return null;
    const first = entries[0].event;
    return {
      requestId: first.passageRequestId,
      passageId: first.passageId,
      palletCode: first.palletCode,
      direction: first.direction,
      cartonCount: entries.length,
      products: productBreakdown(entries),
      openedAt: this._togglePassage.openedAt,
      closesAt: this._togglePassage.closesAt,
      queued: Boolean(this.lastError || !this.batchUrl),
      timestamp: new Date().toISOString(),
    };
  }

  _emitPalletOpen(passageId) {
    const pallet = this.openPallet();
    if (pallet?.passageId === passageId) this.emit('pallet-open', pallet);
  }

  closeTogglePallet({ requestId, reason = 'operator' } = {}) {
    const pallet = this.openPallet();
    if (!pallet) return { closed: false, error: 'No open pallet.' };
    if (requestId && requestId !== pallet.requestId) {
      return { closed: false, error: 'The open pallet changed. Refresh and try again.' };
    }
    if (this._batchTimer) clearTimeout(this._batchTimer);
    if (this._palletTimer) clearTimeout(this._palletTimer);
    this._batchTimer = null;
    this._palletTimer = null;
    this._togglePassage = null;
    try { fs.unlinkSync(this._openPalletPath); } catch (err) {
      if (err.code !== 'ENOENT') this.log(`open pallet state cleanup failed: ${err.message}`, 'warn');
    }
    this._emitBatchReady(pallet.passageId, reason);
    this._pump();
    return { closed: true, reason, ...pallet };
  }

  _emitBatchReady(passageId, closeReason) {
    const entries = this.pallettableEntries(passageId);
    if (!entries.length) return;
    const first = entries[0].event;
    const requestId = first.passageRequestId;
    if (!requestId || this._readyEmitted.has(requestId)) return;
    this._readyEmitted.add(requestId);
    this.emit('batch-ready', {
      requestId,
      passageId,
      palletCode: first.palletCode,
      direction: first.direction,
      cartonCount: entries.length,
      products: productBreakdown(entries),
      queued: Boolean(this.lastError || !this.batchUrl),
      closeReason,
      timestamp: new Date().toISOString(),
    });
  }

  emitPendingBatches() {
    for (const passageId of new Set(this.pending.map((entry) => entry.event?.passageId).filter((id) => id != null))) {
      if (passageId === this._togglePassage?.id) continue;
      this._emitBatchReady(passageId);
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

  /** Deliver one complete IR passage. Each member keeps its original eventId,
   * so Nexus can apply and dedupe the same durable events as the legacy route. */
  async _sendBatch(entries) {
    const first = entries[0]?.event;
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const requestId = first.passageRequestId || `${this.gateId}:passage:${first.seq}`;
    try {
      const res = await fetch(this.batchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          requestId,
          palletCode: first.palletCode,
          gateId: this.gateId,
          passageId: first.passageId,
          direction: first.direction,
          startedAt: entries.reduce(
            (earliest, entry) => {
              const candidate = entry.event.scanStartedAt || entry.event.timestamp;
              return !earliest || Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest;
            },
            null
          ),
          events: entries.map((entry) => entry.event),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = await res.text().catch(() => '');
      if (res.ok) {
        let reply;
        try { reply = JSON.parse(body); }
        catch { return { ok: false, terminal: false, error: `HTTP ${res.status}: invalid JSON acknowledgement` }; }
        if (reply?.ok !== true || reply?.state !== 'applied' || reply?.requestId !== requestId) {
          return { ok: false, terminal: false, error: `HTTP ${res.status}: invalid passage acknowledgement${body ? `: ${body.slice(0, 200)}` : ''}` };
        }
        return { ok: true, state: reply.state, reply };
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
    if (this._pumping || this._stopped || (!this.url && !this.batchUrl)) return;
    this._pumping = true;
    try {
      while (this.pending.length && !this._stopped) {
        const entry = this.pending[0];
        const passageId = entry.event?.passageId;
        // The open no-IR pallet is durable but intentionally not deliverable
        // until Print or the fixed deadline closes it.
        if (passageId != null && passageId === this._togglePassage?.id) break;
        const batch = [entry];
        if (this.batchUrl && passageId != null) {
          for (let i = 1; i < this.pending.length; i++) {
            const candidate = this.pending[i];
            if (candidate.event?.passageId !== passageId || candidate.event?.direction !== entry.event?.direction) break;
            batch.push(candidate);
          }
        }
        const result = this.batchUrl && passageId != null ? await this._sendBatch(batch) : await this._send(entry);

        if (result.ok) {
          this.pending.splice(0, batch.length);
          this.cursor = batch[batch.length - 1].seq;
          this._writeCursor();
          this.sentCount += batch.length;
          this.lastPushAt = new Date().toISOString();
          this.lastError = null;
          this._backoff = this.baseBackoffMs;
          for (const delivered of batch) this.emit('sent', delivered);
          if (result.reply) this.emit('batch-sent', result.reply);
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
    if (this._togglePassage) {
      this._schedulePalletDeadline();
      this._emitPalletOpen(this._togglePassage.id);
    }
    this._pump();
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    if (this._batchTimer) clearTimeout(this._batchTimer);
    if (this._palletTimer) clearTimeout(this._palletTimer);
    this._timer = null;
    this._batchTimer = null;
    this._palletTimer = null;
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
      openPallet: this.openPallet(),
      togglePalletWindowMs: this.togglePalletWindowMs,
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
