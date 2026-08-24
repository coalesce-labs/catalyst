// Type declarations for linear-degraded-auth.mjs (CTL-2187 — the one credential
// resolver for orch-monitor's degraded-path Linear reads).

/** The env var carrying catalyst-monitor.sh's scoped app-actor mint. */
export const SCOPED_APP_ACTOR_ENV: "CATALYST_MONITOR_APP_ACTOR_TOKEN";

/** Tier label: the LINEAR_API_TOKEN / LINEAR_API_KEY env-alias ladder. */
export const TIER_ENV_ALIAS: "env-alias";

/** Tier label: the scoped CATALYST_MONITOR_APP_ACTOR_TOKEN mint. */
export const TIER_SCOPED_APP_ACTOR: "scoped-app-actor";

/** A resolved degraded-read credential. */
export interface DegradedLinearAuth {
  /** Ready-to-send Authorization header value. */
  header: string;
  /** Which tier produced it — TIER_ENV_ALIAS or TIER_SCOPED_APP_ACTOR. */
  tier: string;
}

/**
 * resolveDegradedLinearAuth — the credential for ONE degraded-path Linear read.
 *
 * Tier 1 is the existing `resolveSecret("linear-api-token")` env-alias ladder
 * (unchanged precedence — an operator's personal `lin_api_*` key still wins).
 * Tier 2 is the scoped `CATALYST_MONITOR_APP_ACTOR_TOKEN` mint, consumed under
 * its own name and NEVER written back onto LINEAR_API_TOKEN / LINEAR_API_KEY —
 * that separation is what keeps CTL-1612's inline-reply guarantee intact.
 *
 * Returns null when no tier resolves. Never throws.
 */
export function resolveDegradedLinearAuth(opts?: {
  env?: Record<string, string | undefined>;
}): DegradedLinearAuth | null;
