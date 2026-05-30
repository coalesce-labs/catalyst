// board-logic.ts — pure, dependency-free helpers for the board transport layer
// (CTL-733 PR-2b). NO imports and NO DOM access on purpose: this lets the
// orch-monitor `bun test` suite import + unit-test these from outside the `ui/`
// module graph (no `@/` alias, no React/EventSource), the same way
// board-snapshot.test.ts tests the snapshot manager's pure logic.

/** Reconnect backoff floor (ms) — mirrors use-monitor.ts. */
export const INITIAL_BACKOFF_MS = 500;
/** Reconnect backoff ceiling (ms) — mirrors use-monitor.ts. */
export const MAX_BACKOFF_MS = 15000;

/** Next exponential-backoff delay: double, capped at `max`. Resets to
 *  INITIAL_BACKOFF_MS on a successful connection (caller's responsibility). */
export function nextBackoff(current: number, max: number = MAX_BACKOFF_MS): number {
  return Math.min(max, Math.max(1, current) * 2);
}

/** Parse a snapshot's `generatedAt` to epoch ms; 0 if absent/unparseable. */
export function snapshotMs(p: { generatedAt?: string } | null | undefined): number {
  const g = p?.generatedAt;
  if (!g) return 0;
  const ms = Date.parse(g);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Monotonic gate around a snapshot consumer: drops any snapshot OLDER than the
 * last one emitted, so a late IndexedDB cache read (or an out-of-order frame)
 * can't clobber a fresher live snapshot already on screen. Equal timestamps pass
 * (idempotent refresh). Generic so it's testable without the full BoardPayload.
 */
export function createSnapshotGate<T extends { generatedAt?: string }>(
  emit: (p: T) => void,
): (p: T) => void {
  let lastMs = 0;
  return (p) => {
    const ms = snapshotMs(p);
    if (ms < lastMs) return;
    lastMs = ms;
    emit(p);
  };
}
