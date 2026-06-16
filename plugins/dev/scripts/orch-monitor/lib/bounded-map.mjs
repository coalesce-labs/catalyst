// bounded-map.mjs — insertion-order-LRU Map with optional per-entry TTL.
//
// CTL-1215: the repo had no shared LRU; the only existing bound was the inline
// insertion-order evict in beliefRates (belief-store-queries.mjs, RATES_LRU_CAP).
// This generalizes that proven pattern into one tested helper so the monitor's
// long-lived caches (linear-title-description-fallback, transcript-path) and any
// future bounded map share one implementation rather than three inline copies.
//
// Semantics:
//   - set() touches recency (delete + re-insert) so re-set keys move to MRU and
//     are skipped by the next oldest-evict round.
//   - get() honors TTL: an entry past its (per-entry or default) ttlMs is deleted
//     and undefined is returned (lazy expiry). Within TTL the value is returned;
//     recency is NOT promoted on get (hot reads stay cheap, matching beliefRates).
//   - has() does NOT consider TTL — it is a pure presence check (lazy expiry only
//     fires on get / sweepExpired).
//   - sweepExpired() walks all entries once and deletes the expired ones, returning
//     the count removed. A low-frequency setInterval calls this so never-re-read
//     keys actually leave memory (lazy expiry alone never fires for them).
//
// Eviction is the proven `this._m.keys().next().value` + delete insertion-order
// pattern; the underlying Map preserves insertion order, so the first key is the
// oldest. No deps beyond the language.

export class BoundedMap {
  /**
   * @param {object} opts
   * @param {number} opts.cap          max entries before oldest-evict on set()
   * @param {number} [opts.defaultTtlMs] per-entry TTL when set() omits one (default Infinity)
   * @param {() => number} [opts.now]  injectable clock (ms epoch) for tests
   */
  constructor({ cap, defaultTtlMs = Infinity, now = () => Date.now() }) {
    if (!Number.isFinite(cap) || cap <= 0) {
      throw new Error(`BoundedMap: cap must be a positive number, got ${cap}`);
    }
    this._cap = cap;
    this._defaultTtlMs = defaultTtlMs;
    this._now = now;
    /** @type {Map<unknown, { value: unknown, ts: number, ttlMs: number }>} */
    this._m = new Map();
  }

  get size() {
    return this._m.size;
  }

  // Pure presence check — does NOT consider TTL (lazy expiry fires on get only).
  has(k) {
    return this._m.has(k);
  }

  // Returns the live value, or undefined if absent or expired. Expired entries
  // are deleted as a side effect (lazy expiry). Recency is not promoted.
  get(k) {
    const entry = this._m.get(k);
    if (entry === undefined) return undefined;
    if (this._now() - entry.ts >= entry.ttlMs) {
      this._m.delete(k);
      return undefined;
    }
    return entry.value;
  }

  // Insert/update. Re-setting an existing key moves it to MRU. Evicts the oldest
  // entry when size exceeds cap.
  set(k, value, ttlMs = this._defaultTtlMs) {
    // delete-first so a re-set moves the key to MRU (end of insertion order).
    this._m.delete(k);
    this._m.set(k, { value, ts: this._now(), ttlMs });
    while (this._m.size > this._cap) {
      const oldest = this._m.keys().next().value;
      this._m.delete(oldest);
    }
    return this;
  }

  delete(k) {
    return this._m.delete(k);
  }

  clear() {
    this._m.clear();
  }

  // Walk every entry once; delete the expired ones. Returns the count removed.
  sweepExpired() {
    const now = this._now();
    let removed = 0;
    for (const [k, entry] of this._m) {
      if (now - entry.ts >= entry.ttlMs) {
        this._m.delete(k);
        removed++;
      }
    }
    return removed;
  }

  // Insertion-order keys (oldest-first). Mainly for tests / introspection.
  keys() {
    return this._m.keys();
  }
}
