// Type declarations for linear-estimation-method.mjs (CTL-954, extended CTL-1806).
//
// CTL-1806 made this module a CROSS-PACKAGE API: orch-monitor's
// linear-estimate-fallback.mjs now shares its TTL, cache path, query and
// read/write helpers instead of carrying duplicates that wrote the SAME file
// with a DIFFERENT (24h vs 7-day) TTL.

/** Estimation method descriptor as returned by the Linear GraphQL API. */
export interface EstimationMethod {
  /** "fibonacci" | "tShirt" | "exponential" | "linear" | "notUsed" */
  type: string;
  allowZero: boolean;
  extended: boolean;
}

/**
 * The ONE TTL for the team estimation method (7 days), shared by both writers of
 * `~/catalyst/execution-core/team-estimation-<TEAM>.json`.
 */
export const TEAM_ESTIMATION_TTL_MS: number;

/** The GraphQL query text, shared so the two callers cannot drift. */
export const TEAM_ESTIMATION_QUERY: string;

/** The single on-disk location for a team's estimation method. */
export function teamEstimationCachePath(teamId: string): string;

/**
 * The shared cache tiers (in-process memo, then the on-disk record) under the one
 * TTL. `null` means "not cached / stale / corrupt" — the caller must fetch.
 */
export function readTeamEstimationCache(
  teamId: string,
  opts?: { ttlMs?: number },
): EstimationMethod | null;

/**
 * Persist a resolved method atomically (tmp + rename) and seed the memo. Returns
 * the written record, or null when the disk write failed.
 */
export function writeTeamEstimationCache(
  teamId: string,
  method: EstimationMethod,
): { teamId: string; method: EstimationMethod; fetchedAt: string } | null;

/**
 * getEstimationMethod — the team's Linear estimation method: shared cache first,
 * then a SYNCHRONOUS `curl` fetch (the scheduler's pull loop is synchronous).
 *
 * Returns null on ANY failure, and that null is load-bearing: the scheduler SKIPS
 * its `applyEstimate` Linear write when the method is unavailable. It must never
 * be defaulted to a scale — writing a Fibonacci number into a tShirt team's
 * estimate field is irreversible without an audit.
 */
export function getEstimationMethod(
  teamId: string,
  opts?: { ttlMs?: number },
): EstimationMethod | null;

/** Sorted integer point values for an estimation type; [] for notUsed/unknown. */
export function scaleForMethod(type: string): number[];

/** Map a triage `estimated_scope` to the closest valid integer for a type. */
export function mapScopeToEstimate(scope: string, type: string): number | null;

/** Test-only: reset the module-level memo. */
export function _resetMemoForTests(): void;
