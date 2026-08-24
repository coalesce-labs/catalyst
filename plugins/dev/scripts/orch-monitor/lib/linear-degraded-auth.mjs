// linear-degraded-auth.mjs — CTL-2187. The ONE place orch-monitor decides which
// credential its DEGRADED-PATH Linear reads authenticate with.
//
// ── the gap this closes ──────────────────────────────────────────────────────
// The monitor's degraded resolvers (linear-estimate-fallback.mjs,
// linear-title-description-fallback.mjs) each carried a private
// `linearAuthHeader()` that read ONLY `resolveSecret("linear-api-token")` — a
// `delivery:"env-alias"` row whose envNames are exactly
// ["LINEAR_API_TOKEN","LINEAR_API_KEY"] (lib/secret-contract.mjs). In the
// monitor process BOTH of those are, by design, absent: catalyst-monitor.sh
// cmd_start calls `linear_app_actor_clear_inherited "catalyst-monitor"` and
// mints a SCOPED credential into CATALYST_MONITOR_APP_ACTOR_TOKEN instead. So
// every degraded read resolved null, emitted
// `catalyst.linear.read result=failed` and returned BEFORE fetch — measured at
// ~788k WARN records over 8 days across the two minis, and NOT decaying,
// because getEstimationMethodAsync never resolved and therefore never wrote the
// team-estimation cache that would have stopped the next render re-attempting.
//
// ── why this does NOT re-break CTL-1612 ──────────────────────────────────────
// ⛔ The obvious "fix" — re-exporting LINEAR_API_TOKEN into the monitor's
// environment, or adding CATALYST_MONITOR_APP_ACTOR_TOKEN to the secret-contract
// row's envNames ladder — WOULD re-break it, and would look like a fix because
// the warnings stop. CTL-1612's guarantee is that an OPERATOR'S INLINE REPLY
// must never post as the app actor: linear-comment.mjs's `linearTokenCandidates`
// resolves `env.LINEAR_API_TOKEN` / `env.LINEAR_API_KEY` FIRST, ahead of the
// Layer-2 personal token, so any app-actor value reachable under either alias is
// the value the reply would be posted with (and CTL-1567's provenance gate then
// silently drops it / 502s). The clear at catalyst-monitor.sh:508-518 is
// deliberate and correct, and this module does not undo it.
//
// Instead the scoped token is consumed HERE, under its OWN name, and turned
// straight into an `Authorization` header for one outbound GraphQL READ. It is
// never assigned to process.env.LINEAR_API_TOKEN / LINEAR_API_KEY, never added
// to the secret-contract row, and never placed in an env handed to a subprocess.
// `linearTokenCandidates` reads neither this module nor this variable, so the
// inline-reply path cannot see the value — structurally, not by convention.
// This is the same shape CTL-1612 itself already sanctioned for the peer-anchor
// read (server.ts readAnchor: layer the scoped token onto a COPY of env for just
// that one call, leaving the real process.env aliases untouched).
//
// ── tier order ───────────────────────────────────────────────────────────────
// 1. `resolveSecret("linear-api-token")` — the existing env-alias ladder.
//    Deliberately still FIRST so behaviour is unchanged wherever it already
//    resolves: an operator's PERSONAL `lin_api_*` key SURVIVES
//    linear_app_actor_clear_inherited (that function only unsets non-personal
//    shapes), and a dev-shell monitor run has it. This tier is the one that
//    matches the human operator, so it keeps precedence.
// 2. CATALYST_MONITOR_APP_ACTOR_TOKEN — the scoped mint. The only Linear
//    credential a launchd-started monitor has.
//
// READ-ONLY by construction: the only consumers are the two degraded READ
// resolvers. Nothing here writes to Linear.

import { resolveSecret } from "../../lib/secret-contract.mjs";

/**
 * The env var carrying catalyst-monitor.sh's scoped app-actor mint. Named once
 * here so a grep for the variable finds this contract, not N call sites.
 */
export const SCOPED_APP_ACTOR_ENV = "CATALYST_MONITOR_APP_ACTOR_TOKEN";

/** Tier label stamped on a result, for logs/tests. */
export const TIER_ENV_ALIAS = "env-alias";
export const TIER_SCOPED_APP_ACTOR = "scoped-app-actor";

// authHeaderFor — the byte-identical header shape every other Linear caller in
// this repo uses (linear-query.mjs authHeader, and the two resolvers' former
// private copies): an OAuth access token is a Bearer credential, a personal API
// key is sent raw.
function authHeaderFor(token) {
  return /^lin_oauth/i.test(token) ? `Bearer ${token}` : token;
}

/**
 * resolveDegradedLinearAuth — the credential for ONE degraded-path Linear read.
 *
 * @param {{env?: Record<string, string | undefined>}} [opts]
 * @returns {{header: string, tier: string} | null} null when NO tier resolves —
 *   the honest "this node has no Linear credential" answer the callers still
 *   report as `result:"failed"`. Never throws.
 */
export function resolveDegradedLinearAuth({ env = process.env } = {}) {
  // Tier 1 — the existing env-alias ladder (unchanged precedence).
  const aliasToken = (resolveSecret("linear-api-token", { env }).value ?? "").trim();
  if (aliasToken) return { header: authHeaderFor(aliasToken), tier: TIER_ENV_ALIAS };

  // Tier 2 — the scoped app-actor mint. Consumed under its own name, never
  // written back onto an alias (see the CTL-1612 note at the top of this file).
  const scoped = (env?.[SCOPED_APP_ACTOR_ENV] ?? "").trim();
  if (scoped) return { header: authHeaderFor(scoped), tier: TIER_SCOPED_APP_ACTOR };

  return null;
}
