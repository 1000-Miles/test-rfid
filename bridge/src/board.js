'use strict';

/**
 * Board feed — today's real receiving documents for the gate board.
 *
 * The kiosk used to run on hardcoded demo POs. This module replaces that seam
 * with the live Nexus documents:
 *
 *   inbound  <- GET /api/operations/handheld/receiving/batches
 *               (an open RECEIVING BATCH is the document a carton is credited
 *               against — cartons have no FK to a PO, so the batch, not the PO,
 *               is the real unit of work; its po_refs are shown as metadata.)
 *
 * RECEIVING ONLY, deliberately. The shipping feed
 * (GET /api/operations/handheld/shipping/shipments) is not called and no
 * outbound document is produced: the gate is being run as a receiving gate for
 * now, and the board must not show shipping. The outbound mapper lives in git
 * history if that changes — nothing else here assumes one direction.
 *
 * It proxies rather than letting the browser call Nexus directly, for two
 * reasons: the device token stays server-side, and the last good response is
 * cached to disk so a warehouse PC that boots with no WAN still shows the board
 * it had yesterday instead of an empty screen. Same offline-first stance as the
 * movement outbox, in the read direction.
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'board-cache.json');

class BoardFeed {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || '').replace(/\/$/, '');
    this.token = opts.token || '';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    // Cache older than this triggers a background refresh on the next request.
    // Must stay UNDER the kiosk's poll interval (DOC_POLL_MS in documents.ts,
    // currently 5s) — at or above it, every other poll is served the same
    // payload and the faster polling achieves nothing. BOARD_CACHE_MS overrides;
    // raise it and the kiosk interval together if Nexus read load ever bites.
    this.maxAgeMs = opts.maxAgeMs ?? 4_000;
    // How long a FAILING board may still be trusted to judge an inbound passage
    // (see receivableSku). Far longer than maxAgeMs on purpose: serving a
    // slightly stale board to a screen is harmless, but refusing to credit a
    // real delivery because the WAN blipped is not, so the verdict outlives the
    // display's idea of freshness.
    this.expectMaxAgeMs = opts.expectMaxAgeMs ?? 30 * 60_000;
    this.log = opts.log || (() => {});
    // Called when a load shows receiving having gone BACKWARDS — see _detectReset.
    this.onReceivingReset = opts.onReceivingReset || (() => {});
    this._suppressReset = null; // set by suppressNextReset(), cleared on use
    this.lastFetchAt = null;
    this.lastError = null;
    this._refreshing = null;
    this.cache = this._readCache();
  }

  /**
   * Drop the cached board — part of a local wipe when Nexus has been reset.
   * Without it the kiosk keeps painting yesterday's documents from disk and the
   * "clean slate" still shows the batch that was just deleted server-side.
   */
  clearCache() {
    this.cache = null;
    this.lastFetchAt = null;
    this.lastError = null;
    try {
      if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
    } catch (err) {
      this.log(`board cache remove failed: ${err.message}`, 'warn');
    }
  }

  /** Warm the cache at boot so the first kiosk request is already instant. */
  start() {
    void this.load();
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  _readCache() {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
      // A cache written while the shipping feed was still wired would otherwise
      // put outbound documents back on a receiving-only board — the disk copy
      // outlives the code change, so it is filtered on the way in.
      return {
        ...cached,
        docs: (cached.docs || []).filter((d) => d.dir === 'in'),
        pool: (cached.pool || []).filter((d) => d.dir === 'in'),
      };
    } catch {
      return null;
    }
  }

  _writeCache(payload) {
    try {
      // Atomic: this file is the whole "boots with no WAN still shows a board"
      // story — a kill mid-write must leave the old complete board, not a
      // truncated one.
      writeFileAtomic(CACHE_PATH, JSON.stringify(payload, null, 2) + '\n');
    } catch (err) {
      this.log(`board cache write failed: ${err.message}`, 'warn');
    }
  }

  async _get(pathname) {
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl}${pathname}`, {
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`GET ${pathname} -> HTTP ${res.status}`);
    return res.json();
  }

  /**
   * What the kiosk calls. Answers from cache immediately and refreshes behind
   * it, so a screen never waits on two Nexus round trips to paint.
   *
   * Only a cold bridge (no cache at all) blocks on the network. Everything
   * after that is instant, because a board that is a few seconds out of date is
   * worth far more at a doorway than a correct board that arrives late.
   *
   * `stale` stays reserved for "the last fetch actually failed" — a cache
   * served while a refresh is in flight is not stale, and must not raise the
   * amber warning on the board.
   */
  async get() {
    if (!this.cache) return this.load(); // cold start — nothing to serve yet

    const age = this.lastFetchAt ? Date.now() - Date.parse(this.lastFetchAt) : Infinity;
    if (age > this.maxAgeMs && !this._refreshing) {
      // Fire and forget: the caller gets the current cache, the next caller
      // gets the fresher one. Errors are recorded by load() itself.
      this._refreshing = this.load().finally(() => {
        this._refreshing = null;
      });
    }
    return {
      ok: true,
      stale: Boolean(this.lastError),
      source: this.lastError ? 'cache' : 'cache-fresh',
      ...(this.lastError ? { error: this.lastError } : {}),
      ...this.cache,
    };
  }

  /**
   * Fetch and map today's board. Returns the cached copy (flagged stale) when
   * Nexus is unreachable — a stale board is far more useful at a doorway than
   * no board, and the movement path is unaffected either way.
   */
  async load() {
    if (!this.configured) {
      return { ok: false, stale: true, source: 'unconfigured', error: 'NEXUS_BASE_URL is not set', ...emptyBoard() };
    }
    try {
      const batches = await this._get('/api/operations/handheld/receiving/batches');

      const docs = batches.filter((b) => b.status === 'receiving').map(batchToDoc);
      // The manual-add pool is draft batches: real documents that exist but are
      // not being received yet. Open POs are deliberately NOT used here — the
      // PO endpoint carries no per-line received counts, so a PO added to the
      // board could never be counted against.
      const pool = batches.filter((b) => b.status === 'draft').map(batchToDoc);

      const payload = { docs, pool, fetchedAt: new Date().toISOString() };
      this._detectReset(this.cache, payload);
      this.cache = payload;
      this._writeCache(payload);
      this.lastFetchAt = payload.fetchedAt;
      this.lastError = null;
      this.log(`board loaded: ${docs.length} document(s) on today's board, ${pool.length} in the add pool`);
      return { ok: true, stale: false, source: 'nexus', ...payload };
    } catch (err) {
      this.lastError = err.message;
      this.log(`board load failed (${err.message}) — ${this.cache ? 'serving cached board' : 'no cache available'}`, 'warn');
      if (this.cache) return { ok: true, stale: true, source: 'cache', error: err.message, ...this.cache };
      return { ok: false, stale: true, source: 'none', error: err.message, ...emptyBoard() };
    }
  }

  /**
   * Is this product on a receiving batch a carton may be credited against?
   *
   * The gate's whole receiving decision rests on this answer (see
   * _decideReceiving in passage.js): no match here means the read is ignored and
   * nothing is reported at all.
   *
   * Nexus does the deleted/archived filtering: the receiving endpoint only ever
   * returns live batches (there is no deletedAt or archived field on the payload
   * at all), so "absent from this feed" already means deleted, archived, closed,
   * or never created. The bridge does not re-derive that, and must not try — a
   * second rule here could only disagree with Nexus's.
   *
   * The disk cache IS consulted, unlike the accusation-style check this replaced.
   * Declining here does not mean "no verdict", it means the gate receives
   * NOTHING — and a warehouse PC that boots with no WAN must still be able to
   * take a delivery in. `source` travels with the answer so a receipt decided on
   * cached paperwork is visible as such rather than indistinguishable from one
   * checked against current paperwork.
   *
   * The POOL counts. Draft batches are real, undeleted documents staff receive
   * against on the kiosk, and ignoring their cartons would drop real stock on a
   * technicality.
   *
   * @returns {{ok: boolean, source: 'live'|'cache'|'none'}}
   */
  receivableSku(sku) {
    if (!sku || !this.cache) return { ok: false, source: 'none' };
    const fresh =
      Boolean(this.lastFetchAt) && Date.now() - Date.parse(this.lastFetchAt) <= this.expectMaxAgeMs;
    for (const doc of [...(this.cache.docs || []), ...(this.cache.pool || [])]) {
      if ((doc.lines || []).some((l) => l.sku === sku)) return { ok: true, source: fresh ? 'live' : 'cache' };
    }
    return { ok: false, source: fresh ? 'live' : 'cache' };
  }

  /**
   * Did receiving go BACKWARDS between two loads?
   *
   * The carton-withdrawal signal in passage.js only fires when warehouse_carton
   * rows disappear, which misses the common case entirely: resetting a batch
   * that has no carton rows yet changes nothing at carton level, so nothing is
   * "withdrawn" and no screen is told anything. What always moves is the
   * FIGURE — a line's received count dropping, or a whole document vanishing.
   *
   * That is a fact this feed can see for itself, on the poll it already runs.
   * Only DECREASES count: receiving going up is the normal case and says
   * nothing about a reset.
   */
  /**
   * Skip the next comparison.
   *
   * Set when a reset has ALREADY been handled through the webhook. The refresh
   * that follows it would otherwise see the figures drop and announce the same
   * reset a second time — and the second announcement is not harmless: it wipes
   * the gate's memory again, this time possibly after cartons have started
   * coming back through, throwing away the re-scan already in progress.
   */
  suppressNextReset(why = '') {
    this._suppressReset = why || 'handled elsewhere';
  }

  _detectReset(before, after) {
    if (this._suppressReset) {
      const why = this._suppressReset;
      this._suppressReset = null;
      this.log(`receiving figures changed but the reset was already handled (${why}) — not announcing it twice`);
      return;
    }
    if (!before) return; // first load of this process — nothing to compare
    const priorReceived = new Map();
    for (const doc of before.docs || []) {
      for (const line of doc.lines || []) priorReceived.set(`${doc.id}::${line.sku}`, line.received || 0);
    }
    const reasons = [];
    const stillThere = new Set();
    for (const doc of after.docs || []) {
      for (const line of doc.lines || []) {
        const key = `${doc.id}::${line.sku}`;
        stillThere.add(key);
        const was = priorReceived.get(key);
        if (was != null && (line.received || 0) < was) reasons.push(`${doc.id} ${line.sku} ${was}->${line.received || 0}`);
      }
    }
    for (const key of priorReceived.keys()) if (!stillThere.has(key)) reasons.push(`${key} removed`);
    if (!reasons.length) return;
    this.log(`receiving reset detected: ${reasons.slice(0, 6).join(', ')}${reasons.length > 6 ? ` (+${reasons.length - 6} more)` : ''}`);
    this.onReceivingReset({ reasons });
  }

  status() {
    return {
      configured: this.configured,
      baseUrl: this.baseUrl || null,
      lastFetchAt: this.lastFetchAt,
      lastError: this.lastError,
      cached: Boolean(this.cache),
      cachedAt: this.cache?.fetchedAt ?? null,
    };
  }
}

const emptyBoard = () => ({ docs: [], pool: [], fetchedAt: null });

/**
 * A receiving batch becomes an inbound document. expectedCartons is 0 on lines
 * whose product has no units-per-carton configured; that is passed through
 * honestly rather than guessed at, so the board shows 0/0 instead of inventing
 * a target.
 */
function batchToDoc(batch) {
  const poRefs = batch.poRefs?.length ? batch.poRefs.join(' · ') : '';
  return {
    // id stays the batch ref: it is unique, and it is what the counting logic
    // keys on. `title` is what the board SHOWS — the PO, because that is the
    // reference warehouse staff and suppliers actually recognise. A batch with
    // no PO ref falls back to its own ref rather than rendering blank.
    id: batch.ref,
    title: poRefs || batch.ref,
    dir: 'in',
    party: batch.vendor || 'Unknown vendor',
    meta: poRefs ? batch.ref : `${batch.ref} · no PO reference`,
    due: 0,
    lines: (batch.lines || []).map((l) => ({
      sku: l.productCode,
      name: l.productName || l.productCode,
      expected: l.expectedCartons ?? 0,
      received: l.receivedCartons ?? 0,
      // Nexus already resolves the product photo per line (idea.icon_image_url,
      // via readReceivingBatches) and sends it straight through the handheld
      // route — this was simply never copied onto the DocLine the kiosk reads.
      photoUrl: l.imageUrl || null,
      emoji: l.emoji || null,
      // Total UNITS, not cartons — Nexus gives units-per-carton per line, not a
      // pre-multiplied total, so the kiosk derives it the same way for every
      // line rather than trusting a second source of truth.
      unitsPerCarton: l.unitsPerCarton ?? null,
    })),
  };
}

module.exports = { BoardFeed };
