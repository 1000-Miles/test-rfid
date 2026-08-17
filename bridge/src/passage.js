'use strict';

/**
 * PassageDetector — turns a burst of raw antenna reads into ONE movement event
 * per tag per physical passage.
 *
 * This is the bridge's half of the gate contract and it is NOT a mock: nothing
 * downstream can reconstruct direction or collapse a read burst, so Nexus's
 * POST /api/movement is written assuming the bridge has already done both
 * ("exactly ONE event per tag per passage, direction taken from beam order,
 * already deduplicated on its side"). Delivery of the resulting event is the
 * Outbox's job; this module only decides.
 *
 * Two IR beams guard the warehouse entrance; when a pallet/box passes, the
 * reader bursts and every EPC seen produces a movement event.
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
 *   - Catalog lookup: loaded from Supabase when `catalogUrl`+`catalogKey` are
 *     set, from THREE registries because cartons and pallets are tracked
 *     separately and carton STATE is tracked separately again —
 *     `operations_label_tag` (printed carton tags: EPC ->
 *     product_code/product_name/box_id), `warehouse_pallet` (pallet tags,
 *     under `rfid_tag` -> code/status), and `warehouse_carton` (whether the
 *     carton behind a tag is actually in the building: state/receivedAt).
 *     Entries carry `kind: 'carton'|'pallet'` so downstream can tell them
 *     apart. Each successful load is cached to data/catalog.json so offline
 *     boots still know the tags. Unknown EPCs are auto-registered as unknown
 *     items (still tracked).
 *   - Outbound sanity check: an exit whose carton Nexus says was never
 *     received, or has already shipped, is stamped `unexpected: <reason>`.
 *     Such an exit is still reported and still journaled — it physically
 *     happened — but it is not presented as a dispatch: it does not move the
 *     local exit tally, the board files it as an exception instead of
 *     crediting a shipment line, and the voice warns instead of confirming.
 *     See _outboundCheck for why the check is a blacklist and why it goes
 *     quiet rather than guessing when the state data is stale.
 *   - In-memory live view: epc -> { item, status: 'INSIDE'|'OUTSIDE', ... }.
 *     This is a LOCAL DISPLAY CONVENIENCE for the dashboard/TV board only — it
 *     resets on restart and is not a record of anything. Nexus owns warehouse
 *     state (warehouse_carton / warehouse_pallet); never reconcile against this.
 *
 * Emits 'movement' events:
 *   { type: 'entry'|'exit', direction: 'in'|'out', method: 'ir',
 *     epc, known, item, location, timestamp, antennas: number[],
 *     unexpected: null | 'not-received' | 'already-shipped' }.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');

class PassageDetector extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dedupMs = opts.dedupMs ?? 5000;
    this.quietMs = opts.quietMs ?? 700;
    this.maxWindowMs = opts.maxWindowMs ?? 4000;
    this.location = opts.location ?? 'WH-ENTRANCE-1';
    this.catalogUrl = opts.catalogUrl || ''; // Supabase project URL for the tag registry
    this.catalogKey = opts.catalogKey || ''; // Supabase key (service role or anon)
    this.catalogSource = 'file'; // 'file' | 'supabase' — where the current catalog came from
    // Carton warehouse state is only trusted while it is FRESH — see
    // _outboundCheck. Stale state produces false alarms on cartons received
    // since the last refresh, so past this age the gate stops judging and goes
    // back to reporting the passage without a verdict.
    this.stateMaxAgeMs = opts.stateMaxAgeMs ?? 30 * 60_000;
    this._cartonStateAt = null; // ms epoch of the last successful warehouse_carton read
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
      this.catalogSource = 'file';
    } catch (err) {
      this.catalog = {};
      this.emit('log', `catalog load failed (${err.message}) — all EPCs will be unknown`);
    }
    return this.catalog;
  }

  /**
   * Load the catalog from Supabase `operations_label_tag` — the registry of
   * every printed tag. On success the result also overwrites
   * data/catalog.json so the next offline boot still knows the tags.
   * Returns the catalog, or null when remote loading is not configured /
   * failed (existing catalog is kept in that case).
   */
  async loadCatalogRemote() {
    if (!this.catalogUrl || !this.catalogKey) return null;
    const base = this.catalogUrl.replace(/\/$/, '');
    const headers = { apikey: this.catalogKey, Authorization: `Bearer ${this.catalogKey}` };
    try {
      const map = {};

      // Cartons — the printed-label registry, keyed by `epc`.
      const cartonUrl =
        `${base}/rest/v1/operations_label_tag` +
        `?select=epc,box_id,product_code,product_name,status&order=created_at.desc&limit=10000`;
      const res = await fetch(cartonUrl, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      for (const row of rows) {
        if (!row.epc) continue;
        map[String(row.epc).toUpperCase()] = {
          kind: 'carton',
          sku: row.product_code || row.box_id || 'UNKNOWN-SKU',
          name: row.product_name || 'Unnamed item',
          pallet: row.box_id || null,
          category: row.status || null,
        };
      }

      // Pallets are a SEPARATE registry: warehouse_pallet, and the tag column is
      // `rfid_tag`, not `epc`. Nothing links the two tables, so a second fetch is
      // the only way a BA01 tag resolves — without it every pallet crossing the
      // gate reads as "Unregistered item" even though Nexus knows it perfectly
      // well. Soft-deleted rows and untagged pallets are filtered server-side.
      //
      // Failure here is deliberately non-fatal: cartons are the volume case and
      // must not be lost because the pallet table was briefly unavailable.
      let pallets = 0;
      try {
        const palletUrl = `${base}/rest/v1/warehouse_pallet?select=code,rfid_tag,status&rfid_tag=not.is.null&deleted_at=is.null`;
        const pres = await fetch(palletUrl, { headers });
        if (!pres.ok) throw new Error(`HTTP ${pres.status}`);
        for (const row of await pres.json()) {
          const tag = String(row.rfid_tag || '').toUpperCase();
          if (!tag) continue;
          // A pallet has no SKU. `code` stands in for both the display name and
          // the pallet field so the board has something meaningful to print.
          const code = row.code || 'Unnamed pallet';
          map[tag] = { kind: 'pallet', sku: code, name: code, pallet: code, category: row.status || null };
          pallets += 1;
        }
      } catch (err) {
        this.emit('log', `pallet registry load failed (${err.message}) — pallet tags will read as unregistered`);
      }

      // Carton WAREHOUSE state, from a THIRD registry: warehouse_carton. The
      // label registry above only says a tag was printed; this one says whether
      // the carton it names is actually in the building, and it is the only
      // answer to "was this ever received?" that does not depend on this
      // process having been running at the time.
      //
      // A row is created when a carton is RECEIVED, so the absence of a row is
      // itself the signal: printed but never taken in. That is why this loop
      // annotates rather than registers — a tag with no row keeps its label
      // entry and gains no state, which _outboundCheck reads as not-received.
      //
      // Ordered created_at ASCENDING on purpose. rfid_tag is NOT unique here:
      // the same physical tag is re-used on a later carton, so a tag can own
      // several rows. Soft-deleted rows are filtered server-side, which today
      // happens to leave one live row per tag — but nothing in the schema
      // guarantees that, and if two ever survive, ascending order means the
      // last write wins and the newest row is the tag's current life. Any other
      // order could resurrect a carton that has already left.
      const withState = new Set(); // distinct tags, not rows — a tag can own several
      try {
        const stateUrl =
          `${base}/rest/v1/warehouse_carton` +
          `?select=code,rfid_tag,status,received_at,created_at&rfid_tag=not.is.null&deleted_at=is.null` +
          `&order=created_at.asc&limit=20000`;
        const sres = await fetch(stateUrl, { headers });
        if (!sres.ok) throw new Error(`HTTP ${sres.status}`);
        for (const row of await sres.json()) {
          const tag = String(row.rfid_tag || '').toUpperCase();
          const entry = map[tag];
          // Pallet tags share the namespace and have their own lifecycle; only
          // carton entries carry carton state.
          if (!entry || entry.kind !== 'carton') continue;
          entry.state = row.status || null;
          entry.receivedAt = row.received_at || null;
          entry.carton = row.code || null;
          withState.add(tag);
        }
        this._cartonStateAt = Date.now();
      } catch (err) {
        // Non-fatal, same stance as the pallet registry: without state the gate
        // reports passages exactly as it did before, just without a verdict.
        this._cartonStateAt = null;
        this.emit('log', `carton state load failed (${err.message}) — outbound passages will not be checked`);
      }

      this.catalog = map;
      this.catalogSource = 'supabase';
      this.emit(
        'log',
        `catalog loaded from Supabase: ${rows.length} carton tags (${withState.size} with a warehouse record), ${pallets} pallet tags`
      );
      try {
        fs.writeFileSync(CATALOG_PATH, JSON.stringify(map, null, 2) + '\n', 'utf8');
      } catch (err) {
        this.emit('log', `catalog cache write failed (${err.message}) — in-memory catalog still active`);
      }
      return this.catalog;
    } catch (err) {
      this.emit('log', `Supabase catalog load failed (${err.message}) — keeping ${Object.keys(this.catalog).length} cached entries`);
      return null;
    }
  }

  /**
   * Is this carton entitled to leave?
   *
   * Returns a reason code when an OUTBOUND passage contradicts what Nexus knows
   * about the carton, or null when the passage is unremarkable — including when
   * the gate simply cannot tell, which is not the same as "fine" but must be
   * treated as such: refusing to report a passage the gate is unsure about
   * would lose a movement that physically happened.
   *
   *   'not-received'    a printed tag with no warehouse_carton row — the carton
   *                     was never taken in, so it cannot be going out
   *   'already-shipped' the tag's current carton is already shipped; whatever
   *                     just left, it is not that carton leaving again
   *
   * Deliberately NOT a whitelist of good states: the status enum lives in Nexus
   * and can grow, and an unrecognised state must read as "no objection" rather
   * than alarming on every passage the day a new state is added.
   */
  _outboundCheck(item) {
    if (!item || item.kind !== 'carton') return null; // pallets have their own lifecycle
    if (!this._cartonStateAt) return null; // state never loaded — nothing to check against
    if (Date.now() - this._cartonStateAt > this.stateMaxAgeMs) return null; // too stale to accuse
    if (!item.receivedAt && !item.state) return 'not-received';
    if (item.state === 'shipped') return 'already-shipped';
    return null;
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

    const read = { ant: tag.antenna ?? null, rssi: tag.rssi ?? null, dir: tag.direction ?? null, pid: tag.passageId ?? null, t: now };

    // FAST PATH — decide on the spot.
    //
    // The quiet window exists to answer one question: does this EPC have a
    // direction? A read that already carries a passage direction has answered
    // it, and waiting longer cannot change the outcome, because the direction
    // is taken from the FIRST directioned read and passage-scoped dedup
    // (_lastEventPassage) already guarantees one event per tag per passage.
    // Waiting would only enrich the antenna list and RSSI — telemetry — at the
    // cost of ~700ms before the carton appears on the gate board.
    if ((read.dir === 'in' || read.dir === 'out') && read.pid != null) {
      const buffered = this._pending.get(epc);
      if (buffered) {
        // Earlier direction-less reads of the same tag: fold them in for a
        // fuller antenna list rather than discarding them.
        if (buffered.quiet) clearTimeout(buffered.quiet);
        if (buffered.max) clearTimeout(buffered.max);
        this._pending.delete(epc);
      }
      return this._fire(epc, [...(buffered?.reads ?? []), read], now);
    }

    // SLOW PATH — no direction yet. Buffer and wait: a directioned read may
    // still arrive (the passage can open mid-window), and if none does this
    // is a stray that must be ignored rather than counted.
    let p = this._pending.get(epc);
    if (!p) {
      p = { reads: [], quiet: null, max: setTimeout(() => this._decide(epc), this.maxWindowMs) };
      this._pending.set(epc, p);
    }
    // sliding window: re-arm the quiet timer on every read
    if (p.quiet) clearTimeout(p.quiet);
    p.quiet = setTimeout(() => this._decide(epc), this.quietMs);
    p.reads.push(read);
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
    return this._fire(epc, p.reads, Date.now());
  }

  /** Turn a set of reads for one EPC into at most one movement event. */
  _fire(epc, reads, now) {
    const p = { reads };

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

    // An outbound passage that Nexus's own records contradict. The passage is
    // still reported — it physically happened and the record of it is the whole
    // point — but it is stamped so nothing downstream mistakes it for a clean
    // dispatch: the board files it as an exception instead of crediting a
    // shipment line, and the voice warns instead of confirming.
    const unexpected = direction === 'out' && known ? this._outboundCheck(item) : null;
    if (unexpected) {
      this.emit('log', `UNEXPECTED OUT: ${epc} (${item.sku}) — ${unexpected}; reported but not counted as shipped`);
    }

    const timestamp = new Date(now).toISOString();
    let rec = rec0;
    if (!rec) {
      rec = { epc, item, known, status: 'OUTSIDE', firstSeen: timestamp, lastSeen: timestamp, entries: 0, exits: 0 };
      this.inventory.set(epc, rec);
    }
    rec.status = direction === 'in' ? 'INSIDE' : 'OUTSIDE';
    rec.lastSeen = timestamp;
    // A contested exit is not a dispatch, so it does not move the local tally
    // the TV board counts. Status still goes OUTSIDE: whatever the paperwork
    // says, the thing is no longer in the building.
    if (direction === 'in') rec.entries += 1;
    else if (!unexpected) rec.exits = (rec.exits || 0) + 1;

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
      // null on every ordinary passage; a reason code when this exit
      // contradicts Nexus's record of the carton. Nexus's ingest is free to
      // ignore it (it owns the decision), but the field means the gate no
      // longer reports a contested exit as though it were a clean one.
      unexpected,
      timestamp,
    };
    this.events.unshift(event);
    if (this.events.length > this.maxEvents) this.events.length = this.maxEvents;

    // Delivery is deliberately NOT done here. The listener hands the event to
    // the Outbox, which journals it before touching the network; a direct
    // fire-and-forget POST from this method would lose events during an outage
    // and would double-send alongside the outbox.
    this.emit('movement', event);
    return event;
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
      catalogSize: Object.keys(this.catalog).length,
      catalogSource: this.catalogSource,
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

module.exports = { PassageDetector };
