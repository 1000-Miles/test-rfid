'use strict';

/**
 * Mock Nexus — stand-in for the real warehouse inventory system.
 *
 * Real operation this simulates: an IR beam guards the warehouse entrance;
 * when a pallet/box passes, the reader bursts and every EPC seen "checks in":
 * an entry event fires to Nexus, and inventory marks the item INSIDE.
 *
 * Direction (4-antenna portal, single IR, two stacked pairs):
 *   - `outsideAntennas` (default [1,3]) face outside the door,
 *     `insideAntennas` (default [2,4]) face inside. Pairs: 1/2 below, 3/4
 *     above — group logic covers both pairs and cross-pair sightings.
 *   - Reads for an EPC are buffered in a SLIDING window: the decision fires
 *     after `quietMs` (default 700ms) with no new reads, or `maxWindowMs`
 *     (default 4000ms) after the first read — whichever comes first. This
 *     keeps a whole slow passage in one decision.
 *       first seen on any outside ant -> then any inside ant = IN  (entry)
 *       first seen on any inside ant  -> then any outside    = OUT (exit)
 *       seen on only ONE side = stray read -> IGNORED, status never flips
 *   - Dedup: after a movement event, that EPC is ignored for `dedupMs`
 *     (default 5000). Strays only get a 1s cooldown so a real passage right
 *     after is not swallowed.
 *
 * Other behaviour:
 *   - Catalog lookup: data/catalog.json maps EPC -> item (sku, name, pallet).
 *     Unknown EPCs are auto-registered as unknown items (still tracked).
 *   - In-memory inventory: epc -> { item, status: 'INSIDE'|'OUTSIDE', ... }.
 *   - If NEXUS_URL is set, each event is also POSTed there (fire-and-forget)
 *     — that's the seam where the real Nexus plugs in later.
 *
 * Emits 'movement' events:
 *   { type: 'entry'|'exit', direction: 'in'|'out', method: 'antenna'|'toggle',
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
    this.outsideAntennas = opts.outsideAntennas ?? [1, 3];
    this.insideAntennas = opts.insideAntennas ?? [2, 4];
    this.location = opts.location ?? 'WH-ENTRANCE-1';
    this.url = opts.url || ''; // real Nexus endpoint, empty = mock-only
    this.catalog = {};
    this.inventory = new Map(); // epc -> record
    this.events = []; // newest first, capped
    this.maxEvents = 200;
    this._lastEventAt = new Map(); // epc -> ms epoch
    this._pending = new Map(); // epc -> { reads: [{ant,rssi,t}], timer }
    this._unknownSeq = 0;
    this.loadCatalog();
  }

  /** Live-adjust timing/antenna config. Returns the resulting summary. */
  setConfig(cfg = {}) {
    if (Number.isFinite(cfg.dedupMs) && cfg.dedupMs >= 0) this.dedupMs = cfg.dedupMs;
    if (Number.isFinite(cfg.quietMs) && cfg.quietMs >= 100) this.quietMs = cfg.quietMs;
    if (Number.isFinite(cfg.maxWindowMs) && cfg.maxWindowMs >= this.quietMs) this.maxWindowMs = cfg.maxWindowMs;
    if (Array.isArray(cfg.outsideAntennas) && cfg.outsideAntennas.length) this.outsideAntennas = cfg.outsideAntennas;
    if (Array.isArray(cfg.insideAntennas) && cfg.insideAntennas.length) this.insideAntennas = cfg.insideAntennas;
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
    p.reads.push({ ant: tag.antenna ?? null, rssi: tag.rssi ?? null, t: now });
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

    const firstOn = (ants) => {
      const r = p.reads.find((x) => ants.includes(x.ant));
      return r ? r.t : null;
    };
    const tOut = firstOn(this.outsideAntennas);
    const tIn = firstOn(this.insideAntennas);

    const rec0 = this.inventory.get(epc);
    // SEQUENCE REQUIRED: direction only from real outside->inside (or reverse)
    // evidence. One-sided sightings are stray reads (reflections, box parked
    // near the door) — no event, no status change.
    if (tOut == null || tIn == null || tOut === tIn) {
      const side = tOut != null ? 'outside' : tIn != null ? 'inside' : 'unknown';
      this.emit('log', `stray read ignored: ${epc} seen ${side}-only (${p.reads.length} reads), status stays ${rec0 ? rec0.status : 'untracked'}`);
      // short cooldown only — a real passage moments later must still count
      this._lastEventAt.set(epc, now - this.dedupMs + 1000);
      return null;
    }
    this._lastEventAt.set(epc, now);
    const direction = tOut < tIn ? 'in' : 'out';
    const method = 'antenna';

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
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      outsideAntennas: this.outsideAntennas,
      insideAntennas: this.insideAntennas,
      location: this.location,
    };
  }

  reset() {
    this.inventory.clear();
    this.events.length = 0;
    this._lastEventAt.clear();
    for (const p of this._pending.values()) {
      if (p.quiet) clearTimeout(p.quiet);
      if (p.max) clearTimeout(p.max);
    }
    this._pending.clear();
    this._unknownSeq = 0;
  }
}

module.exports = { MockNexus };
