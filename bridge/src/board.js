'use strict';

/**
 * Board feed — today's real receiving and shipping documents for the gate board.
 *
 * The kiosk used to run on hardcoded demo POs. This module replaces that seam
 * with the live Nexus documents:
 *
 *   inbound  <- GET /api/operations/handheld/receiving/batches
 *               (an open RECEIVING BATCH is the document a carton is credited
 *               against — cartons have no FK to a PO, so the batch, not the PO,
 *               is the real unit of work; its po_refs are shown as metadata.)
 *   outbound <- GET /api/operations/handheld/shipping/shipments
 *
 * It proxies rather than letting the browser call Nexus directly, for two
 * reasons: the device token stays server-side, and the last good response is
 * cached to disk so a warehouse PC that boots with no WAN still shows the board
 * it had yesterday instead of an empty screen. Same offline-first stance as the
 * movement outbox, in the read direction.
 */

const fs = require('fs');
const path = require('path');

const CACHE_PATH = path.join(__dirname, '..', 'data', 'board-cache.json');

class BoardFeed {
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl || '').replace(/\/$/, '');
    this.token = opts.token || '';
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    // Cache older than this triggers a background refresh on the next request.
    // Kept under the kiosk's own 5s poll (BOARD_CACHE_MS overrides), so the
    // board is never served anything older than roughly one poll cycle.
    this.maxAgeMs = opts.maxAgeMs ?? 4_000;
    this.log = opts.log || (() => {});
    this.lastFetchAt = null;
    this.lastError = null;
    this._refreshing = null;
    this.cache = this._readCache();
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
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch {
      return null;
    }
  }

  _writeCache(payload) {
    try {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(payload, null, 2) + '\n');
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
      const [batches, shipments] = await Promise.all([
        this._get('/api/operations/handheld/receiving/batches'),
        this._get('/api/operations/handheld/shipping/shipments'),
      ]);

      const docs = [
        ...batches.filter((b) => b.status === 'receiving').map(batchToDoc),
        ...shipments.filter((s) => s.status === 'open').map(shipmentToDoc),
      ];
      // The manual-add pool is draft batches: real documents that exist but are
      // not being received yet. Open POs are deliberately NOT used here — the
      // PO endpoint carries no per-line received counts, so a PO added to the
      // board could never be counted against.
      const pool = batches.filter((b) => b.status === 'draft').map(batchToDoc);

      const payload = { docs, pool, fetchedAt: new Date().toISOString() };
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

/** A shipment becomes an outbound document; destinations are the counterparty. */
function shipmentToDoc(shipment) {
  const dests = shipment.destinations || [];
  const party = dests.length
    ? dests.map((d) => d.city || d.shipperName || d.code).filter(Boolean).join(' · ') || 'Unnamed destination'
    : 'No destination';
  const etd = dests.find((d) => d.etd)?.etd;
  return {
    id: shipment.ref,
    dir: 'out',
    party,
    meta: [shipment.planRef, etd ? `ETD ${String(etd).slice(0, 10)}` : null].filter(Boolean).join(' · ') || 'No plan reference',
    due: 0,
    lines: (shipment.lines || []).map((l) => ({
      sku: l.productCode,
      name: l.productName || l.productCode,
      expected: l.cartons ?? 0,
      received: l.shippedCartons ?? 0,
      photoUrl: l.imageUrl || null,
      emoji: l.emoji || null,
      unitsPerCarton: l.unitsPerCarton ?? null,
    })),
  };
}

module.exports = { BoardFeed };
