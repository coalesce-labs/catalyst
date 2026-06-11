// Type declarations for linear-estimate-fallback.mjs (CTL-974 supplemental
// estimate resolver).

/** Estimation method descriptor as returned by the Linear GraphQL API. */
export interface EstimationMethod {
  type: string;
  allowZero: boolean;
  extended: boolean;
}

/**
 * fillEstimateFallback — given an array of ticket IDs whose durable-cache
 * estimate is null, return a map { [id]: number|null } for those IDs.
 *
 * - Hits are served from the in-memory TTL cache (5 min).
 * - Remaining IDs are batched into a single Linear GraphQL call.
 * - Always resolves; never rejects (fail-open).
 */
export function fillEstimateFallback(
  ticketIds: string[],
): Promise<Record<string, number | null>>;

/**
 * getEstimationMethodAsync — async version of the scheduler's
 * getEstimationMethod. Reads the shared on-disk cache first (24h TTL),
 * falls back to a live Linear GraphQL fetch on a miss. Returns null on any
 * failure (fail-open).
 */
export function getEstimationMethodAsync(
  teamId: string,
): Promise<EstimationMethod | null>;

// Test helpers — exposed so tests can clear caches without module reload.
export function _clearEstimateCache(): void;
export function _clearMethodCache(): void;
export function _getEstimateCacheSize(): number;
