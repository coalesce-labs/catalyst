// Type declarations for linear-estimate-fallback.mjs (CTL-974 supplemental
// estimate resolver).

/** Estimation method descriptor as returned by the Linear GraphQL API. */
export interface EstimationMethod {
  type: string;
  allowZero: boolean;
  extended: boolean;
}

/** CTL-1806: test seam for the replica tier. Forwarded verbatim to
 *  readReplicaEstimates, so an injected `readerFactory` drives the replica
 *  contract offline and a `dbPath` pins the file-presence gate. */
export interface ReplicaTierOptions {
  replicaOptions?: {
    dbPath?: string;
    readerFactory?: ((opts: { dbPath: string }) => unknown) | null;
  };
}

/**
 * fillEstimateFallback — given an array of ticket IDs whose durable-cache
 * estimate is null, return a map { [id]: number|null } for those IDs.
 *
 * - Hits are served from the in-memory TTL cache (5 min).
 * - CTL-1806: remaining IDs are served from the LOCAL REPLICA (file-presence
 *   gate, fail-open). A replica NULL estimate is a MISS, not an authoritative
 *   null, so it falls through rather than dropping the chip.
 * - Only genuine replica misses reach a Linear GraphQL call, and each such call
 *   emits `catalyst.linear.read {source:"linearis_miss", op:"estimate"}`.
 * - Always resolves; never rejects (fail-open).
 */
export function fillEstimateFallback(
  ticketIds: string[],
  opts?: ReplicaTierOptions,
): Promise<Record<string, number | null>>;

/**
 * getEstimationMethodAsync — async version of the scheduler's
 * getEstimationMethod, sharing its on-disk cache, path and 7-day TTL
 * (CTL-1806 D1 collapsed the duplicate 24h cache over the same file).
 *
 * The team estimation method has NO replica source — the replica has no teams
 * table and carries no issueEstimation — so a cold cache falls back to a
 * labelled DEGRADED Linear fetch that emits
 * `catalyst.linear.read {source:"linearis", op:"team_method"}`. Returns null on
 * any failure; it is deliberately never defaulted to a scale, because null makes
 * the scheduler SKIP its estimate write while a guess would write a wrong one.
 */
export function getEstimationMethodAsync(
  teamId: string,
): Promise<EstimationMethod | null>;

// Test helpers — exposed so tests can clear caches without module reload.
export function _clearEstimateCache(): void;
export function _clearMethodCache(): void;
export function _getEstimateCacheSize(): number;
