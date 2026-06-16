// Type declarations for bounded-map.mjs (CTL-1215) — insertion-order-LRU Map
// with optional per-entry TTL. Lets the typechecked TS server + tests import
// BoundedMap without a TS7016 implicit-any error.

export interface BoundedMapOpts {
  /** Max entries before oldest-evict on set(). */
  cap: number;
  /** Per-entry TTL when set() omits one. Default Infinity. */
  defaultTtlMs?: number;
  /** Injectable clock (ms epoch) for tests. */
  now?: () => number;
}

export class BoundedMap<K = unknown, V = unknown> {
  constructor(opts: BoundedMapOpts);
  /** Current entry count. */
  readonly size: number;
  /** Pure presence check — does NOT consider TTL. */
  has(k: K): boolean;
  /** Live value or undefined (expired entries are deleted lazily on get). */
  get(k: K): V | undefined;
  /** Insert/update; re-set moves to MRU; evicts oldest past cap. */
  set(k: K, value: V, ttlMs?: number): this;
  delete(k: K): boolean;
  clear(): void;
  /** Delete every expired entry; returns the count removed. */
  sweepExpired(): number;
  /** Insertion-order (oldest-first) keys. */
  keys(): IterableIterator<K>;
}
