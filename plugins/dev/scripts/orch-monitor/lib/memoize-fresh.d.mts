// memoize-fresh.d.mts — CTL-1257. Hand-written companion for memoize-fresh.mjs so
// the parent orch-monitor tsconfig (which typechecks server.ts + the __tests__
// contract suites) can import createMemoizedRead without a TS7016 implicit-any
// error. Keep in sync with the .mjs.

/**
 * Wrap a read function so repeated calls within a TTL (or until an explicit
 * invalidate()) reuse the cached value instead of re-reading. Single-slot,
 * keyed on the caller-supplied `key(...)` (default: one slot).
 */
// Callers pass the value type explicitly (createMemoizedRead<string>({...})), which
// disables inference of a generic arg-tuple, so the read/key/get arg lists use the
// idiomatic variadic-utility `any[]` (arg positions only — the cached value stays
// typed `T`). read and key always receive the same args get() is called with.
export function createMemoizedRead<T>(opts: {
  /** underlying read; its result is cached */
  read: (...args: any[]) => T;
  /** hard staleness bound in ms (belt-and-suspenders) */
  ttlMs: number;
  /** derive a cache key from the get() args (default: single slot) */
  key?: (...args: any[]) => string;
  /** injectable clock (ms epoch) for tests */
  now?: () => number;
}): { get: (...args: any[]) => T; invalidate: () => void };
