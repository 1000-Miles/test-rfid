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
 * TWO detection modes, switchable at runtime (`detectMode`), IR machinery
 * fully intact in both:
 *
 *   'ir' (default) — direction observed by the beams, exactly as documented
 *   below. Reads without a direction are strays.
 *
 *   'toggle' (NO-IR, the mode this gate runs) — no beams; the antennas face
 *   each other across the doorway and the reader reads continuously. Every read
 *   burst ("visit") IS a passage. Direction is NOT inferred from visit order any
 *   more: the first-pass-in / next-pass-out rule that used to live here has been
 *   deleted in favour of _decideReceiving, which asks the paperwork instead of
 *   guessing. Extra guards, all of which exist because there is no passage
 *   boundary anymore — and which are now noise control rather than the thing
 *   holding correctness together:
 *     - absenceMs: a new visit opens only after the tag has been UNSEEN this
 *       long ("it left the field" replaces "the beams cleared") — otherwise a
 *       pallet parked in the read zone flips in/out forever
 *     - toggleDedupMs: re-arm time after an event, much longer than the IR
 *       dedupMs; must stay above the RF discovery tail (reads trail a real
 *       passage by 10-20s)
 *     - minRssi: optional logical read-zone shrink — weaker reads are ignored
 *       entirely (not even presence), as if the tag were out of range
 *     - toggleMinReads: a visit with fewer reads is dropped as noise.
 *       DEFAULT 1 — i.e. off. Set >1 only with evidence of ghost reads at this
 *       gate, and never without somewhere for the drops to show: a single read
 *       is usually a real carton at an awkward angle, and dropping it loses a
 *       carton silently, which costs far more than an occasional stray.
 *
 * WHAT A READ BECOMES — receiving only, no direction logic:
 *   This gate receives, or it does nothing. See _decideReceiving for the rule
 *   in full; in short, a read becomes a receipt only when the tag is a KNOWN
 *   carton, has NOT been taken in already (locally or per Nexus), and its
 *   product is on an open receiving batch. Everything else is ignored —
 *   silently on the boards, counted in summary().
 *
 *   There is no outbound path. Shipping is off (allowShipping) because nothing
 *   tells this bridge which cartons are on an open shipment, so an exit could
 *   only be guessed at; an observed outbound read is ignored instead.
 *
 *   The two modes below therefore differ only in READ QUALITY — whether a
 *   physical passage boundary exists — never in what a read means.
 *
 * Read grouping (two IR beams, decided by the bridge controller):
 *   - GPI1 beam broken first = IN, GPI2 beam broken first = OUT. The
 *     controller stamps that passage direction onto every tag message it
 *     emits during the burst. An 'out' stamp is now an ignore, not a dispatch.
 *   - Reads for an EPC are buffered in a SLIDING window: the decision fires
 *     after `quietMs` (default 700ms) with no new reads, or `maxWindowMs`
 *     (default 4000ms) after the first read — whichever comes first. This
 *     keeps a whole slow passage in one decision. The first read carrying a
 *     direction wins for that EPC.
 *   - Reads with NO direction (manual-mode reads, ambiguous both-beams-at-
 *     once triggers, HW-mode UDP reads) are stray reads -> IGNORED, status
 *     never flips. In no-IR mode there is no stamp to require, so the window
 *     groups one visit and the rule decides it.
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
 *   - Sanity checking is no longer a stamp on a reported passage; it IS the
 *     decision. What used to be reported-but-flagged ('no-open-batch',
 *     'not-received', 'already-shipped') is now simply not an event at all, so
 *     `unexpected` is permanently null and the boards have no exceptions to
 *     file. The reasons live in summary().ignored instead.
 *   - In-memory live view: epc -> { item, status: 'INSIDE'|'OUTSIDE', ... }.
 *     This is a LOCAL DISPLAY CONVENIENCE for the dashboard/TV board only — it
 *     resets on restart and is not a record of anything. Nexus owns warehouse
 *     state (warehouse_carton / warehouse_pallet); never reconcile against this.
 *
 * Emits 'movement' events — always a receipt:
 *   { type: 'entry', direction: 'in', method: 'ir'|'toggle',
 *     epc, known, item, location, timestamp, antennas: number[],
 *     basis: 'on-open-batch' | 'on-open-batch-cached'  (WHY it was received),
 *     unexpected: null  (kept on the wire; nothing questionable is emitted) }.
 */

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { writeFileAtomic } = require('./atomic-write');

const CATALOG_PATH = path.join(__dirname, '..', 'data', 'catalog.json');
const FORGOTTEN_PATH = path.join(path.dirname(CATALOG_PATH), 'receiving-forgotten.json');

class PassageDetector extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dedupMs = opts.dedupMs ?? 5000;
    this.quietMs = opts.quietMs ?? 700;
    this.maxWindowMs = opts.maxWindowMs ?? 4000;
    // --- NO-IR trial mode ("toggle") — see the module docblock ---------------
    this.detectMode = opts.detectMode === 'toggle' ? 'toggle' : 'ir';
    this.toggleDedupMs = opts.toggleDedupMs ?? 60_000;
    this.absenceMs = opts.absenceMs ?? 30_000;
    this.minRssi = Number.isFinite(opts.minRssi) ? opts.minRssi : null;
    this.toggleMinReads = opts.toggleMinReads ?? 1; // 1 = accept a single read; see the note above
    /**
     * Count a no-IR carton the MOMENT it is decidable, instead of holding it
     * for the decision window.
     *
     * The window earns its keep in IR mode, where it waits for a directioned
     * read. In toggle mode it cannot change the outcome: the direction is not
     * inferred from the reads at all (see _fire — `direction` is 'in', and the
     * verdict comes from _decideReceiving, which reads the catalogue and the
     * open batch), and the only thing the reads themselves decide is the
     * toggleMinReads noise floor. So once that many reads are in, every extra
     * millisecond is latency and nothing else.
     *
     * That latency is what the floor sees as cartons TRICKLING onto the board:
     * the reader runs continuously in toggle mode, so a pallet sitting in the
     * field keeps re-arming each tag's quiet timer, and every carton ends up
     * firing at its own maxWindowMs — staggered by whenever that tag was first
     * seen, one every few seconds, rather than as a pallet.
     *
     * The cost is telemetry, not correctness: the movement event carries the
     * reads it had at firing time, so `reads`, `antennas` and the strongest
     * RSSI narrow to the deciding read(s). The console's tag feed is unaffected
     * (the controller emits every read on its own, floor tuning included), and
     * the trailing reads are still absorbed by the re-arm and absence gates —
     * they simply no longer pad the receipt.
     *
     * OFF by default: this changes when a live gate commits a carton, and that
     * is the floor's call to make, not a default to inherit.
     */
    this.toggleFastCount = opts.toggleFastCount === true;
    this._lastReadAt = new Map(); // epc -> ms epoch of last accepted read (feeds the absence gate)
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
    // Injected by server.js from the BoardFeed: sku -> {ok, source}.
    // A function rather than a snapshot because the board refreshes on its own
    // schedule and the answer must be the one true at PASSAGE time, not at
    // construction time. Absent (reader-only builds, tests) = nothing is
    // receivable, which is the safe direction: the gate reports nothing rather
    // than crediting cartons against paperwork it cannot see.
    this.receivableSku = typeof opts.receivableSku === 'function' ? opts.receivableSku : null;
    /**
     * Shipping. OFF, and it stays off until Nexus can tell this gate which
     * cartons are on an open shipment — it currently cannot: the shipping feed
     * is not called and no outbound document reaches the bridge. With no such
     * source an exit could only ever be GUESSED, and guessing is exactly what
     * put 196 dispatches for cartons nobody shipped into this gate's journal.
     * So an outbound read is IGNORED rather than reported.
     */
    this.allowShipping = opts.allowShipping === true;
    // Why reads were ignored, by reason, since boot. The answer to "the gate saw
    // it, so why didn't it receive it?" — without which the only honest reply is
    // "read the logs". Exposed in summary().
    this._ignored = new Map();
    /**
     * The last few reads that were declined, WITH the tag and the reason.
     *
     * Counts alone could not answer the only question anyone actually asks —
     * "the gate saw that carton, why didn't it count?" — because the answer is
     * per-tag and the counters are per-reason. Worse, they survive a wipe, so
     * after a redo they mix two runs together and the arithmetic stops adding
     * up. Bounded, newest first, and cleared by a reset along with the counts.
     */
    this._ignoredRecent = [];
    /**
     * When each carton was FORGOTTEN, and when everything was.
     *
     * The journal is the gate's durable memory, and hydrate() replays it at
     * every boot. A reset that only cleared the in-memory record was therefore
     * undone by the next restart: the journal still said "received", hydrate
     * put the carton back INSIDE, and the redo was declined as
     * 'already-received-here' — silently, which is the worst way to lose a
     * re-scan and exactly what the reset exists to prevent.
     *
     * So a forget is a durable, TIMESTAMPED fact. Any journalled movement at or
     * before the cutoff is void; anything after it stands, so a carton received
     * again after the reset is remembered normally.
     */
    this._forgottenAt = new Map(); // epc -> ms
    this._forgottenAllAt = 0; // ms, from resetForReceiving()
    this._forgottenPath = FORGOTTEN_PATH;
    this._loadForgotten();
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
    if (cfg.detectMode === 'ir' || cfg.detectMode === 'toggle') {
      if (cfg.detectMode !== this.detectMode) this.emit('log', `detect mode -> ${cfg.detectMode.toUpperCase()}`);
      this.detectMode = cfg.detectMode;
    }
    if (Number.isFinite(cfg.toggleDedupMs) && cfg.toggleDedupMs >= 0) this.toggleDedupMs = cfg.toggleDedupMs;
    if (Number.isFinite(cfg.absenceMs) && cfg.absenceMs >= 0) this.absenceMs = cfg.absenceMs;
    if (cfg.minRssi === null) this.minRssi = null;
    else if (Number.isFinite(cfg.minRssi)) this.minRssi = cfg.minRssi;
    if (Number.isFinite(cfg.toggleMinReads) && cfg.toggleMinReads >= 1) this.toggleMinReads = Math.floor(cfg.toggleMinReads);
    if (typeof cfg.toggleFastCount === 'boolean') {
      if (cfg.toggleFastCount !== this.toggleFastCount) {
        this.emit('log', `no-IR fast count -> ${cfg.toggleFastCount ? 'ON (count on the deciding read)' : 'OFF (hold for the decision window)'}`);
      }
      this.toggleFastCount = cfg.toggleFastCount;
    }
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
      // Kept for the withdrawal diff below: only a pass that actually READ the
      // state can tell a withdrawn carton from a failed fetch.
      const prevCatalog = this.catalog;
      const hadState = Boolean(this._cartonStateAt);
      let stateOk = false;
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
        stateOk = true;
      } catch (err) {
        // Non-fatal, same stance as the pallet registry: without state the gate
        // reports passages exactly as it did before, just without a verdict.
        this._cartonStateAt = null;
        this.emit('log', `carton state load failed (${err.message}) — outbound passages will not be checked`);
      }

      if (stateOk && hadState) this._forgetWithdrawn(prevCatalog, map);

      this.catalog = map;
      this.catalogSource = 'supabase';
      this.emit(
        'log',
        `catalog loaded from Supabase: ${rows.length} carton tags (${withState.size} with a warehouse record), ${pallets} pallet tags`
      );
      try {
        // Atomic: this file is what an OFFLINE boot knows the tags by — a kill
        // mid-write must leave the previous complete catalog, not half of one.
        writeFileAtomic(CATALOG_PATH, JSON.stringify(map, null, 2) + '\n');
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
   * Cartons Nexus has WITHDRAWN since the last catalog pass — the tag had a
   * warehouse_carton row and now has none.
   *
   * That disappearance is how a receiving RESET reaches the gate. Nexus soft-
   * deletes the cartons a reset undoes, so the row vanishes from the state read
   * and the goods are, as far as the records go, no longer in the building. They
   * have to roll back through the doorway to be received again.
   *
   * Without this the gate refuses the redo outright. _decideReceiving ignores a
   * tag whose record still says INSIDE, so a withdrawn pallet rolling back in
   * would be declined as 'already-received-here' — silently, which is the worst
   * possible way to lose a re-scan. Clearing the local claim is what makes the
   * carton receivable again: the record goes OUTSIDE, and with Nexus's row gone
   * too, the next pass sees a carton nobody has taken in.
   *
   * Only ever called after a state read that actually SUCCEEDED, and only when
   * the previous pass had state too. A failed fetch leaves every entry without
   * state, which is indistinguishable from every carton being withdrawn at once,
   * and acting on that would empty the building on one bad request.
   *
   * The event dedupe is cleared with it so a pallet re-rolled straight after the
   * reset isn't swallowed by toggleDedupMs. The absence gate (_lastReadAt) is
   * deliberately NOT cleared: it is what stops a pallet parked in the read zone
   * from firing on its own, and a reset is not a movement.
   */
  _forgetWithdrawn(prevCatalog, nextCatalog) {
    const withdrawn = [];
    for (const [tag, prev] of Object.entries(prevCatalog || {})) {
      if (!prev || prev.kind !== 'carton') continue;
      if (!prev.state && !prev.receivedAt) continue; // never had a row — nothing to lose
      const next = nextCatalog[tag];
      if (next && (next.state || next.receivedAt)) continue; // still on the books
      withdrawn.push(tag);
    }
    if (withdrawn.length === 0) return;

    const cleared = this.forgetEpcs(withdrawn);
    this.emit(
      'log',
      `${withdrawn.length} carton tag(s) withdrawn in Nexus (receiving reset or delete) — ` +
        `${cleared} local record(s) set OUTSIDE; they now read as ARRIVING at the gate`
    );
    // Tell the screens too. Fixing the gate's own direction state is only half
    // the job: the kiosk holds its own record of what it has credited today, and
    // after a reset in Nexus that record is stale in a way no poll reveals —
    // the cartons come back through and the board answers "already received
    // today" while the pallet and the print show them correctly. Nothing else
    // knows a reset happened, so the detector has to say so.
    this.emit('withdrawn', { epcs: withdrawn, cleared });
  }

  /**
   * Forget the gate's movement memory for SPECIFIC tags, so each reads as
   * arriving next time it passes.
   *
   * The scoped counterpart to resetForReceiving(): when the caller knows
   * exactly which cartons were un-received — a reset webhook that names them —
   * throwing away every other tag's state is collateral damage. A carton from
   * an untouched batch that happens to be sitting inside would come back as
   * ARRIVING and be counted twice.
   *
   * Same three registers as the full reset, and `_lastReadAt` is kept for the
   * same reason: it is the absence gate, and a reset in Nexus is not a movement
   * at the door.
   *
   * Emits nothing — the caller decides what to tell the screens, because the
   * 'withdrawn' listener triggers a FULL wipe and would undo the scoping.
   *
   * @returns {number} how many tags actually had local state to clear.
   */
  forgetEpcs(epcs) {
    const now = Date.now();
    let cleared = 0;
    let stamped = 0;
    for (const tag of epcs || []) {
      if (!tag) continue;
      // Stamped whether or not there is a local record: the journal may still
      // hold a receipt for a carton this process has never seen in memory, and
      // that is precisely the one a restart would resurrect.
      this._forgottenAt.set(tag, now);
      stamped++;
      this._lastEventAt.delete(tag);
      this._lastEventPassage.delete(tag);
      const rec = this.inventory.get(tag);
      if (!rec) continue;
      rec.status = 'OUTSIDE';
      rec.lastMoveAt = 0; // OUTSIDE again, so _decideReceiving can take it in
      cleared++;
    }
    if (stamped) this._saveForgotten();
    return cleared;
  }

  /**
   * Resolve a reset's SCOPE to the exact tags it affected, then forget only
   * those.
   *
   * A batch or pallet redo must never clear the whole gate. Cartons from
   * untouched batches that happen to be sitting inside would come back as
   * arriving and be counted a second time — the redo would fix one batch and
   * corrupt every other.
   *
   * Three ways to name the scope, unioned:
   *   epcs    — exact tags. Best, and what Nexus's reset marker already sends.
   *   batches — a batch ref, e.g. 'RB-2026-0005'. Resolved locally: a carton's
   *             code carries its batch as a prefix (RB-2026-0005-BSC-358-…), so
   *             the gate can find the tags itself without being told.
   *   skus    — every carton of a product.
   *
   * NOT resolvable here: a pallet CODE. The catalog knows which product and
   * which box a tag is, but not which pallet a carton was put on — nothing in
   * warehouse_carton's selected columns carries it. A pallet redo therefore has
   * to arrive as `epcs` or `skus`; asking for it by pallet code alone returns
   * nothing matched, and the caller decides what to do about that rather than
   * this quietly widening to everything.
   *
   * @returns {{epcs: string[], cleared: number, matched: {epcs:number,batches:number,skus:number}}}
   */
  forgetScope({ epcs = [], batches = [], skus = [] } = {}) {
    const want = new Set();
    const matched = { epcs: 0, batches: 0, skus: 0 };

    for (const e of epcs || []) {
      if (typeof e === 'string' && e.trim()) {
        want.add(e.trim().toUpperCase());
        matched.epcs++;
      }
    }
    const batchRefs = (batches || []).filter((b) => typeof b === 'string' && b.trim()).map((b) => b.trim().toUpperCase());
    const skuSet = new Set((skus || []).filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim().toUpperCase()));

    if (batchRefs.length || skuSet.size) {
      for (const [tag, item] of Object.entries(this.catalog || {})) {
        if (!item || item.kind !== 'carton') continue; // pallets are not received
        const code = String(item.carton || '').toUpperCase();
        if (code && batchRefs.some((ref) => code.startsWith(ref))) {
          if (!want.has(tag)) matched.batches++;
          want.add(tag);
          continue;
        }
        if (skuSet.size && skuSet.has(String(item.sku || '').toUpperCase())) {
          if (!want.has(tag)) matched.skus++;
          want.add(tag);
        }
      }
    }

    const list = [...want];
    return { epcs: list, cleared: this.forgetEpcs(list), matched };
  }

  /**
   * Persist the forget cutoffs. Best-effort, but loudly so: unwritten, the next
   * restart replays the journal and quietly un-does the reset.
   */
  _saveForgotten() {
    try {
      // Only cutoffs that can still void something are worth keeping. A global
      // cutoff supersedes every per-carton stamp at or before it.
      for (const [epc, at] of this._forgottenAt) if (at <= this._forgottenAllAt) this._forgottenAt.delete(epc);
      writeFileAtomic(
        this._forgottenPath,
        JSON.stringify({ allAt: this._forgottenAllAt, epcs: Object.fromEntries(this._forgottenAt) }) + '\n'
      );
    } catch (err) {
      this.emit('log', `forget-state write failed (${err.message}) — a restart may un-do this reset`);
    }
  }

  _loadForgotten() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._forgottenPath, 'utf8'));
      if (Number.isFinite(raw?.allAt)) this._forgottenAllAt = raw.allAt;
      for (const [epc, at] of Object.entries(raw?.epcs || {})) {
        if (Number.isFinite(at)) this._forgottenAt.set(String(epc).toUpperCase(), at);
      }
    } catch {
      /* nothing forgotten yet, or unreadable — the journal simply applies in full */
    }
  }

  /**
   * Rebuild the gate's own memory from the outbox's movement journal at boot.
   *
   * The in-memory live view used to die with the process, which made every tag
   * look "never seen" after a restart — and in toggle mode that memory is the
   * primary direction source. The journal already holds every movement this
   * gate ever fired, so replaying "last event per EPC" restores both the
   * INSIDE/OUTSIDE flip and the re-arm clock (_lastEventAt), making them
   * survive restarts and long offline stretches.
   *
   * Purely local: no network, no 'movement' events emitted, nothing re-sent.
   * Entries must be in seq order (Outbox.readJournal guarantees it).
   */
  hydrate(entries = []) {
    let applied = 0;
    for (const entry of entries) {
      const e = entry && entry.event;
      if (!e || !e.epc || (e.direction !== 'in' && e.direction !== 'out')) continue;
      const t = Date.parse(e.timestamp || entry.at || '');
      if (!Number.isFinite(t)) continue;
      const iso = new Date(t).toISOString();
      let rec = this.inventory.get(e.epc);
      if (!rec) {
        rec = {
          epc: e.epc,
          item: e.item ?? { sku: 'UNKNOWN', name: 'Unregistered item', pallet: null, category: null },
          known: Boolean(e.known),
          status: 'OUTSIDE',
          firstSeen: iso,
          lastSeen: iso,
          entries: 0,
          exits: 0,
          lastMoveAt: 0,
        };
        this.inventory.set(e.epc, rec);
      }
      // Void: this movement predates a reset that forgot the carton. Skipped
      // rather than applied-then-cleared, so `entries` and the re-arm clock do
      // not carry it either.
      if (t <= Math.max(this._forgottenAllAt, this._forgottenAt.get(e.epc) || 0)) continue;
      if (t >= (rec.lastMoveAt || 0)) {
        rec.status = e.direction === 'in' ? 'INSIDE' : 'OUTSIDE';
        rec.lastMoveAt = t;
        rec.lastSeen = iso;
        if (e.item) rec.item = e.item;
        rec.known = Boolean(e.known);
      }
      // Same tally rules as _fire: a contested exit is not a dispatch.
      if (e.direction === 'in') rec.entries += 1;
      else if (!e.unexpected) rec.exits = (rec.exits || 0) + 1;
      if (t > (this._lastEventAt.get(e.epc) || 0)) this._lastEventAt.set(e.epc, t);
      applied += 1;
    }
    if (applied) this.emit('log', `hydrated ${this.inventory.size} tag state(s) from ${applied} journaled movement(s)`);
    return applied;
  }

  /**
   * THE RECEIVING RULE — the whole decision this gate makes.
   *
   * Direction is no longer inferred, guessed or flipped. It is not decided at
   * all: this gate receives, or it does nothing. The question a read must answer
   * is not "which way is this going" but "is this a carton the paperwork is
   * still waiting for":
   *
   *   1. unknown tag                  -> ignore. No record anywhere means there
   *                                      is nothing to credit it against.
   *   2. not a carton (pallet tag)    -> ignore. Pallets have their own
   *                                      lifecycle; they are not received.
   *   3. this gate already took it in -> ignore. Local memory: instant, and the
   *                                      only source that is never minutes old.
   *   4. Nexus says already received  -> ignore. Catches cartons taken in by a
   *                                      handheld, or by this gate before a
   *                                      restart.
   *   5. product on no open batch     -> local exception. Show it to the
   *                                      worker, but never credit or deliver it.
   *   6. otherwise                    -> RECEIVE.
   *
   * Every ignore is SILENT on the boards, deliberately: a doorway that
   * announces every carton it correctly declined is a doorway nobody reads.
   * Each one is counted in summary() and logged, so the reason is always
   * recoverable after the fact.
   *
   * What this replaces: the old first-pass-in / next-pass-out inference, which
   * had to guess because it had nothing else to go on. In this gate's own
   * journal that guess produced 196 dispatches for cartons that never shipped
   * and 449 arrivals against no open batch. Neither is reachable from here any
   * more — an event now needs a positive reason to exist at all.
   *
   * @returns {{action: 'receive'|'exception'|'ignore', reason: string}}
   */
  _decideReceiving(item, known, rec) {
    if (!known) return { action: 'ignore', reason: 'unknown-tag' };
    if (item.kind !== 'carton') return { action: 'ignore', reason: 'not-a-carton' };
    if (rec && rec.status === 'INSIDE') return { action: 'ignore', reason: 'already-received-here' };
    if (this._nexusSaysReceived(item)) return { action: 'ignore', reason: 'already-received-nexus' };
    if (!this.receivableSku) return { action: 'ignore', reason: 'no-batch-data' };
    const batch = this.receivableSku(item.sku);
    if (!batch || batch.source === 'none') return { action: 'ignore', reason: 'no-batch-data' };
    if (!batch.ok) return { action: 'exception', reason: 'not-on-open-batch' };
    return { action: 'receive', reason: batch.source === 'live' ? 'on-open-batch' : 'on-open-batch-cached' };
  }

  /**
   * Does Nexus's own record say this carton has already been taken in?
   *
   * A warehouse_carton row is created ON RECEIPT, so the row existing at all is
   * the answer — 'shipped' included, since a carton cannot ship without having
   * been received first.
   *
   * DELIBERATELY that simple. An earlier version also compared the carton code
   * against the label's box id, to survive a tag being re-used on a later
   * carton: a row from the tag's previous life would otherwise block its new
   * carton forever. This warehouse does not re-use labels — one label, one
   * carton, for its whole life — so that guard protected against nothing while
   * being able to cause real harm: any mismatch in Nexus's own code formatting
   * would read as "not received" and receive an already-received carton a second
   * time. Given item 1 of NEXUS-HANDOFF.md (a carton row inserted per passage),
   * a false "not received" is the expensive direction to be wrong in.
   *
   * If labels ever ARE re-used, this is where the suffix check goes back.
   */
  _nexusSaysReceived(item) {
    return Boolean(item.state || item.receivedAt);
  }

  /** Record an ignored read: counted for summary(), logged once, never shown. */
  _ignore(epc, item, known, reason, reads) {
    this._ignored.set(reason, (this._ignored.get(reason) || 0) + 1);
    this._ignoredRecent.unshift({
      epc,
      sku: known ? item?.sku ?? null : null,
      name: known ? item?.name ?? null : null,
      reason,
      reads,
      at: new Date().toISOString(),
    });
    // Bounded: this is a diagnostic tail, not a log. A pallet parked in the read
    // zone produces these by the hundred.
    if (this._ignoredRecent.length > 300) this._ignoredRecent.length = 300;
    this.emit('log', `ignored ${epc} (${known ? item.sku : 'unregistered'}) — ${reason} [${reads} read(s)]`);
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
    const toggle = this.detectMode === 'toggle';

    // NO-IR mode RSSI floor: logically shrinks the read zone. A read weaker
    // than the floor is treated as "not at the portal" — ignored entirely, and
    // deliberately NOT counted as presence, so a tag hovering at the edge of
    // the field still reads as absent and fires cleanly when it finally
    // crosses close to the antennas.
    if (toggle && this.minRssi != null && tag.rssi != null && tag.rssi < this.minRssi) return null;

    // Dedup / re-arm. Toggle mode uses its own, much longer window: with no
    // passage boundary this is what stops the RF discovery tail (reads trail a
    // passage by 10-20s) from reading as a second passage.
    const last = this._lastEventAt.get(epc) || 0;
    if (now - last < (toggle ? this.toggleDedupMs : this.dedupMs)) {
      const rec = this.inventory.get(epc);
      if (rec) rec.lastSeen = new Date(now).toISOString();
      if (toggle) this._lastReadAt.set(epc, now); // still presence — keeps the absence gate honest
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

    // NO-IR absence gate: a new visit opens only after the tag has been GONE
    // for absenceMs — "it left the field" is the no-IR substitute for "the
    // beams cleared". Without it, a pallet parked inside the read zone would
    // open a fresh visit the moment the re-arm window expires and flip in/out
    // forever. The cost is deliberate: a tag that never leaves the field never
    // fires again — that is a read-zone (power/RSSI floor) problem to fix
    // physically, not something software can direction-guess its way out of.
    // Sits AFTER the fast path so an IR-stamped read (observed ground truth)
    // is never swallowed by a mere lingering heuristic.
    if (toggle && !this._pending.has(epc)) {
      const seenAt = this._lastReadAt.get(epc) || 0;
      this._lastReadAt.set(epc, now);
      if (seenAt && now - seenAt < this.absenceMs) {
        const rec = this.inventory.get(epc);
        if (rec) rec.lastSeen = new Date(now).toISOString();
        return null; // lingering in the field, not a new passage
      }
    } else if (toggle) {
      this._lastReadAt.set(epc, now);
    }

    // SLOW PATH — no direction yet. Buffer and wait: a directioned read may
    // still arrive (the passage can open mid-window), and if none does this
    // is a stray that must be ignored rather than counted.
    // In toggle mode the buffer means something different: it IS the visit —
    // the quiet/max window groups one physical pass into one decision, and
    // _fire infers the direction instead of discarding the reads.
    let p = this._pending.get(epc);
    if (!p) {
      p = { reads: [], quiet: null, max: setTimeout(() => this._decide(epc), this.maxWindowMs) };
      this._pending.set(epc, p);
    }
    // sliding window: re-arm the quiet timer on every read
    if (p.quiet) clearTimeout(p.quiet);
    p.quiet = setTimeout(() => this._decide(epc), this.quietMs);
    p.reads.push(read);

    // NO-IR FAST PATH — see toggleFastCount. The noise floor is the only thing
    // the reads decide here, so the instant it is satisfied the answer is final
    // and holding the carton any longer only delays the board.
    if (toggle && this.toggleFastCount && p.reads.length >= this.toggleMinReads) {
      return this._decide(epc);
    }
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
    const firstDir = p.reads.find((x) => x.dir === 'in' || x.dir === 'out');
    // IR mode, DIRECTION REQUIRED: the controller stamps the IR passage
    // direction (GPI1 first = in, GPI2 first = out) on tags read during a
    // burst. Reads without one (manual mode, ambiguous trigger, reflections)
    // are stray — no event, no status change.
    if (!firstDir && this.detectMode !== 'toggle') {
      this.emit('log', `stray read ignored: ${epc} has no IR direction (${p.reads.length} reads), status stays ${rec0 ? rec0.status : 'untracked'}`);
      // short cooldown only (min(dedupMs, 1s)) — a real passage moments later must still count
      this._lastEventAt.set(epc, now - Math.max(0, this.dedupMs - 1000));
      return null;
    }
    // Toggle mode noise floor. OFF by default (toggleMinReads = 1): a tag read
    // once is a carton that was read once, not noise. This dropped real stock
    // — a carton read a single time vanished with only a log line to show for
    // it, so the board showed 7 of 8 and nothing said why.
    //
    // The drop is now emitted as a 'dropped' event as well as a log line, so if
    // the floor is ever raised again the losses are visible on the board
    // instead of silent.
    if (!firstDir && p.reads.length < this.toggleMinReads) {
      const detail = `${epc} only ${p.reads.length} read(s) (< ${this.toggleMinReads})`;
      this.emit('log', `no-IR visit dropped: ${detail} — treated as noise, NOT counted`);
      this.emit('dropped', { epc, reads: p.reads.length, minReads: this.toggleMinReads, timestamp: new Date(now).toISOString() });
      return null;
    }
    // Passage-scoped dedup: a tag fires at most ONE event per physical
    // passage (beams broken -> clear), no matter how long it lingers in the
    // doorway. A new passage gets a new id and counts again immediately.
    if (firstDir && firstDir.pid != null && this._lastEventPassage.get(epc) === firstDir.pid) {
      this.emit('log', `duplicate suppressed: ${epc} already fired for passage #${firstDir.pid}`);
      this._lastEventAt.set(epc, now - Math.max(0, this.dedupMs - 1000));
      return null;
    }
    this._lastEventAt.set(epc, now);
    if (firstDir && firstDir.pid != null) this._lastEventPassage.set(epc, firstDir.pid);

    const known = Object.prototype.hasOwnProperty.call(this.catalog, epc);
    const item = known
      ? this.catalog[epc]
      : { sku: `UNKNOWN-${String(++this._unknownSeq).padStart(3, '0')}`, name: 'Unregistered item', pallet: null, category: null };

    // Shipping is off (see this.allowShipping). An observed outbound passage is
    // therefore not a dispatch waiting to be reported — it is a read this gate
    // has nothing to do with, and reporting it anyway is what filled the journal
    // with shipments nobody made.
    if (firstDir?.dir === 'out' && !this.allowShipping) {
      return this._ignore(epc, item, known, 'shipping-disabled', p.reads.length);
    }

    // THE decision — see _decideReceiving. Either this is a carton the paperwork
    // is still waiting for, or nothing happens at all.
    const decision = this._decideReceiving(item, known, rec0);
    if (decision.action === 'ignore') {
      // Missing batch data is the one ignore that is a TEMPORARY condition — the
      // board is mid-load, or the bridge has just booted. Re-arming for the full
      // window would make a restart during receiving silently drop cartons for a
      // minute apiece, so this reason alone gets a short retry instead.
      if (decision.reason === 'no-batch-data') {
        const rearm = this.detectMode === 'toggle' ? this.toggleDedupMs : this.dedupMs;
        this._lastEventAt.set(epc, now - Math.max(0, rearm - 5_000));
      }
      return this._ignore(epc, item, known, decision.reason, p.reads.length);
    }

    // Always a receipt. Kept as a variable rather than inlined because the event
    // shape (and Nexus's ingest) still carries a direction field, and it must
    // read as deliberate rather than as a leftover.
    const direction = 'in';
    const method = firstDir ? 'ir' : 'toggle';
    const basis = decision.reason;
    // Off-batch cartons are local-only exception events. The Outbox journals
    // them for evidence but deliberately does not queue them for Nexus or add
    // them to a pallet. The dashboard can therefore show NO RECEIVING without
    // turning the warning into stock.
    const unexpected = decision.action === 'exception' ? 'no-open-batch' : null;
    this.emit('log', `${unexpected ? 'NO RECEIVING' : 'RECEIVE'} ${epc} (${item.sku}) [${basis}] from ${p.reads.length} read(s)`);

    const timestamp = new Date(now).toISOString();
    const scanStartedAt = new Date(Math.min(...p.reads.map((read) => read.t))).toISOString();
    let rec = rec0;
    if (!rec) {
      rec = { epc, item, known, status: 'OUTSIDE', firstSeen: timestamp, lastSeen: timestamp, entries: 0, exits: 0 };
      this.inventory.set(epc, rec);
    }
    // INSIDE is now also the "already received" register the rule reads on the
    // next pass (_decideReceiving step 3), which is why the reset paths clear it
    // — resetForReceiving() wipes the inventory, forgetEpcs() flips the named
    // tags back to OUTSIDE. Without that, a redo after a Nexus reset would find
    // every carton already received and take nothing in.
    if (!unexpected) {
      rec.status = 'INSIDE';
      rec.lastSeen = timestamp;
      rec.lastMoveAt = now;
      rec.entries += 1;
    }

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
      // Stable boundary for one physical IR passage. The delivery layer uses
      // this to send every carton on the pallet in one Nexus request instead
      // of serialising one HTTP request per tag. Toggle mode has no physical
      // passage boundary and therefore keeps the legacy single-event path.
      passageId: firstDir?.pid ?? null,
      detectedAt: timestamp,
      scanStartedAt,
      // null on every ordinary passage; a reason code when this exit
      // contradicts Nexus's record of the carton. Nexus's ingest is free to
      // ignore it (it owns the decision), but the field means the gate no
      // longer reports a contested exit as though it were a clean one.
      unexpected,
      // WHY this carton was received (see _decideReceiving) —
      // 'on-open-batch', or 'on-open-batch-cached' when the batch list came
      // from the disk cache rather than a live load. The distinction is the
      // difference between a receipt checked against current paperwork and one
      // checked against the last copy the gate managed to download.
      basis,
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
      detectMode: this.detectMode,
      toggleDedupMs: this.toggleDedupMs,
      absenceMs: this.absenceMs,
      minRssi: this.minRssi,
      toggleMinReads: this.toggleMinReads,
      toggleFastCount: this.toggleFastCount,
      location: this.location,
      catalogSize: Object.keys(this.catalog).length,
      catalogSource: this.catalogSource,
      allowShipping: this.allowShipping,
      // Ignored reads by reason since boot — the only place "why was that carton
      // not received?" can be answered without trawling the log.
      ignored: Object.fromEntries(this._ignored),
      // The per-tag tail behind those counts: which carton, and why it was
      // declined. Answers "the gate saw it, so why is it not on the label?"
      ignoredRecent: this._ignoredRecent.slice(0, 60),
    };
  }

  /**
   * Receiving was reset in Nexus, so forget everything this gate believes about
   * where each carton is.
   *
   * Without this the bridge silently rejects a redo. Its per-EPC memory
   * outlives the reset, and each part of it refuses a re-read for a different
   * reason: `_lastEventAt` holds the tag inside `toggleDedupMs`, and
   * `inventory` still says INSIDE so the direction inference reports the carton
   * LEAVING. Walk the same eight cartons back through and only the two that
   * happen to clear every gate register — the reader sees all eight and the
   * bridge accepts two.
   *
   * `_lastReadAt` is deliberately KEPT, for the reason _forgetWithdrawn gives:
   * it is the absence gate, the only thing stopping a pallet parked in the read
   * zone from firing on its own, and a reset in Nexus is not a movement at the
   * door. A carton still has to leave the field and come back — which is what
   * physically happens when someone redoes the receiving.
   */
  resetForReceiving() {
    const known = this.inventory.size;
    const readAt = new Map(this._lastReadAt); // survive the wipe below
    this.reset();
    this._lastReadAt = readAt;
    // Durable, for the same reason forgetEpcs stamps: clearing memory alone is
    // undone by the next boot, because the journal still says "received".
    this._forgottenAllAt = Date.now();
    this._forgottenAt.clear();
    this._saveForgotten();
    this.emit(
      'log',
      `receiving reset — cleared movement memory for ${known} tag(s); every carton now reads as ARRIVING ` +
        `(absence gate kept, so a tag must still leave the read zone first)`
    );
  }

  reset() {
    // Cleared with everything else: ignore counts that outlive a wipe mix the
    // old run into the new one, and "59 received, 119 ignored" stops being
    // arithmetic anyone can check.
    this._ignored.clear();
    this._ignoredRecent.length = 0;
    this.inventory.clear();
    this.events.length = 0;
    this._lastEventAt.clear();
    this._lastEventPassage.clear();
    this._lastReadAt.clear();
    for (const p of this._pending.values()) {
      if (p.quiet) clearTimeout(p.quiet);
      if (p.max) clearTimeout(p.max);
    }
    this._pending.clear();
    this._unknownSeq = 0;
  }
}

module.exports = { PassageDetector };
