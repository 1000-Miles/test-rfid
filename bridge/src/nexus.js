'use strict';

/**
 * Mock Nexus — stand-in for the real warehouse inventory system.
 *
 * Real operation this simulates: two IR beams guard the warehouse entrance;
 * when a pallet/box passes, the reader bursts and every EPC seen "checks in":
 * an entry event fires to Nexus, and inventory marks the item INSIDE.
 *
 * Direction (two IR beams, decided by the bridge controller):
 *   - GPI1 beam broken first = IN, GPI2 beam broken first = OUT. The
 *     controller stamps that passage direction onto every tag message it
 *     emits during the burst; this module just consumes `tag.direction`.
 *   - Reads for an EPC are buffered in a SLIDING window: the decision fires
 *     after `quietMs` (default 700ms) with no new reads, or `maxWindowMs`
 *     (default 4000ms) after the first read — whichever comes first. This
 *     keeps a whole slow passage in one decision. The first read carrying a
 *     direction wins for that EPC.
 *   - Reads with NO direction (manual-mode reads, ambiguous both-beams-at-
 *     once triggers, HW-mode UDP reads) are stray reads -> IGNORED, status
 *     never flips.
 *   - Dedup, two layers:
 *       1. Passage-scoped: a tag fires at most ONE event per physical passage
 *          (`tag.passageId` from the controller) — a pallet parked in the
 *          doorway can't re-fire however long it sits there.
 *       2. Time-based: after a movement event, that EPC is ignored for
 *          `dedupMs` (default 5000) as a noise floor between passages.
 *     Strays only get a 1s cooldown so a real passage right after is not
 *     swallowed.
 *
 * Other behaviour:
 *   - Catalog lookup: data/catalog.json maps EPC -> item (sku, name, pallet).
 *     Unknown EPCs are auto-registered as unknown items (still tracked).
 *   - In-memory inventory: epc -> { item, status: 'INSIDE'|'OUTSIDE', ... }.
 *   - If NEXUS_URL is set, each event is also POSTed there (fire-and-forget)
 *     — that's the seam where the real Nexus plugs in later.
 *
 * Emits 'movement' events:
 *   { type: 'entry'|'exit', direction: 'in'|'out', method: 'ir',
 *     epc, known, item, location, timestamp, antennas: number[] }.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');

class MockNexus extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dedupMs = opts.dedupMs ?? 5000;
    this.quietMs = opts.quietMs ?? 700;
    this.maxWindowMs = opts.maxWindowMs ?? 4000;
    this.location = opts.location ?? 'WH-ENTRANCE-1';
    this.url = opts.url || ''; // real Nexus endpoint, empty = mock-only
    this.apiKey = opts.apiKey || ''; // sent as Authorization: Bearer <key>
    this.authHeader = opts.authHeader || ''; // raw "Name: value" override for non-Bearer schemes
    this.catalog = {};
    this.inventory = new Map(); // epc -> record
    this.events = []; // newest first, capped
    this.maxEvents = 200;
    this._lastEventAt = new Map(); // epc -> ms epoch
    this._lastEventPassage = new Map(); // epc -> passageId of last fired event (one event per tag per passage)
    this._pending = new Map(); // epc -> { reads: [{ant,rssi,dir,pid,t}], timer }
    this._unknownSeq = 0;
    this.loadCatalog();
  }

  /** Live-adjust timing/antenna config. Returns the resulting summary. */
  setConfig(cfg = {}) {
    if (Number.isFinite(cfg.dedupMs) && cfg.dedupMs >= 0) this.dedupMs = cfg.dedupMs;
    if (Number.isFinite(cfg.quietMs) && cfg.quietMs >= 100) this.quietMs = cfg.quietMs;
    if (Number.isFinite(cfg.maxWindowMs) && cfg.maxWindowMs >= this.quietMs) this.maxWindowMs = cfg.maxWindowMs;
    return this.summary();
  }

  loadCatalog() {
    try {
      this.catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
    } catch (err) {
      this.catalog = {};
      this.emit('log', `catalog load failed (${err.message}) — all EPCs will be unknown`);
    }
    return this.catalog;
  }

  /**
   * A tag was read at the portal. Buffers reads per EPC for the decision
   * window, then _decide() fires the movement event. Returns null always
   * (decisions are async).
   */
  tagSeen(tag) {
    const epc = tag.epc;
    if (!epc) return null;
    const now = Date.now();

    const last = this._lastEventAt.get(epc) || 0;
    if (now - last < this.dedupMs) {
      const rec = this.inventory.get(epc);
      if (rec) rec.lastSeen = new Date(now).toISOString();
      return null;
    }

    let p = this._pending.get(epc);
    if (!p) {
      p = { reads: [], quiet: null, max: setTimeout(() => this._decide(epc), this.maxWindowMs) };
      this._pending.set(epc, p);
    }
    // sliding window: re-arm the quiet timer on every read
    if (p.quiet) clearTimeout(p.quiet);
    p.quiet = setTimeout(() => this._decide(epc), this.quietMs);
    p.reads.push({ ant: tag.antenna ?? null, rssi: tag.rssi ?? null, dir: tag.direction ?? null, pid: tag.passageId ?? null, t: now });
    return null;
  }

  /** Decision window closed for an EPC — derive direction and fire the event. */
  _decide(epc) {
    const p = this._pending.get(epc);
    this._pending.delete(epc);
    if (!p) return null;
    if (p.quiet) clearTimeout(p.quiet);
    if (p.max) clearTimeout(p.max);
    if (p.reads.length === 0) return null;
    const now = Date.now();

    const rec0 = this.inventory.get(epc);
    // DIRECTION REQUIRED: the controller stamps the IR passage direction
    // (GPI1 first = in, GPI2 first = out) on tags read during a burst. Reads
    // without one (manual mode, ambiguous trigger, reflections) are stray —
    // no event, no status change.
    const firstDir = p.reads.find((x) => x.dir === 'in' || x.dir === 'out');
    if (!firstDir) {
      this.emit('log', `stray read ignored: ${epc} has no IR direction (${p.reads.length} reads), status stays ${rec0 ? rec0.status : 'untracked'}`);
      // short cooldown only (min(dedupMs, 1s)) — a real passage moments later must still count
      this._lastEventAt.set(epc, now - Math.max(0, this.dedupMs - 1000));
      return null;
    }
    // Passage-scoped dedup: a tag fires at most ONE event per physical
    // passage (beams broken -> clear), no matter how long it lingers in the
    // doorway. A new passage gets a new id and counts again immediately.
    if (firstDir.pid != null && this._lastEventPassage.get(epc) === firstDir.pid) {
      this.emit('log', `duplicate suppressed: ${epc} already fired for passage #${firstDir.pid}`);
      this._lastEventAt.set(epc, now - Math.max(0, this.dedupMs - 1000));
      return null;
    }
    this._lastEventAt.set(epc, now);
    if (firstDir.pid != null) this._lastEventPassage.set(epc, firstDir.pid);
    const direction = firstDir.dir;
    const method = 'ir';

    const known = Object.prototype.hasOwnProperty.call(this.catalog, epc);
    const item = known
      ? this.catalog[epc]
      : { sku: `UNKNOWN-${String(++this._unknownSeq).padStart(3, '0')}`, name: 'Unregistered item', pallet: null, category: null };

    const timestamp = new Date(now).toISOString();
    let rec = rec0;
    if (!rec) {
      rec = { epc, item, known, status: 'OUTSIDE', firstSeen: timestamp, lastSeen: timestamp, entries: 0, exits: 0 };
      this.inventory.set(epc, rec);
    }
    rec.status = direction === 'in' ? 'INSIDE' : 'OUTSIDE';
    rec.lastSeen = timestamp;
    if (direction === 'in') rec.entries += 1;
    else rec.exits = (rec.exits || 0) + 1;

    const strongest = p.reads.reduce((a, b) => ((b.rssi ?? -999) > (a.rssi ?? -999) ? b : a));
    const event = {
      type: direction === 'in' ? 'entry' : 'exit',
      direction,
      method,
      epc,
      known,
      item,
      location: this.location,
      rssi: strongest.rssi,
      antenna: strongest.ant,
      antennas: [...new Set(p.reads.map((r) => r.ant).filter((a) => a != null))],
      reads: p.reads.length,
      timestamp,
    };
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) this.events.length = this.maxEvents;

    this.emit('movement', event);
    this._forward(event);
    return event;
  }

  async _forward(event) {
    if (!this.url) return;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
      if (this.authHeader) {
        const idx = this.authHeader.indexOf(':');
        if (idx > 0) headers[this.authHeader.slice(0, idx).trim()] = this.authHeader.slice(idx + 1).trim();
      }
      const res = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(event),
      });
      if (!res.ok) this.emit('log', `Nexus POST ${res.status}`);
    } catch (err) {
      this.emit('log', `Nexus forward error: ${err.message}`);
    }
  }

  getInventory() {
    return [...this.inventory.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
  }

  getEvents(limit = 50) {
    return this.events.slice(0, limit);
  }

  summary() {
    let inside = 0;
    for (const rec of this.inventory.values()) if (rec.status === 'INSIDE') inside++;
    return {
      inside,
      totalSeen: this.inventory.size,
      events: this.events.length,
      dedupMs: this.dedupMs,
      quietMs: this.quietMs,
      maxWindowMs: this.maxWindowMs,
      location: this.location,
    };
  }

  reset() {
    this.inventory.clear();
    this.events.length = 0;
    this._lastEventAt.clear();
    this._lastEventPassage.clear();
    for (const p of this._pending.values()) {
      if (p.quiet) clearTimeout(p.quiet);
      if (p.max) clearTimeout(p.max);
    }
    this._pending.clear();
    this._unknownSeq = 0;
  }
}

module.exports = { MockNexus };
