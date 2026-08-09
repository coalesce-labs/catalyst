// Pure normalization and evaluation for GitHub's `rate_limit` response.
// This module deliberately owns no filesystem, subprocess, or clock IO.

// Codex P2 (CAT-40): `Number(x) || fallback` silently discards an explicit 0.
// A `0` percentage floor is a MEANINGFUL operator choice — "only total
// exhaustion blocks dispatch" — and `||` turned it into the 10% default, so
// 1-10% remaining tripped Gate 3 against the configured intent. Take any finite
// non-negative number at face value; fall back only when the value is absent or
// unparseable.
// An empty/whitespace-only string is "unset", not zero — `Number("")` is 0, which
// would otherwise turn an exported-but-blank env var into the strictest setting.
function finiteOr(value, fallback) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const GITHUB_QUOTA_DEFAULTS = {
  coreRemainingPct: finiteOr(process.env.CATALYST_BH_GH_CORE_PCT, 10),
  stalenessMs: finiteOr(process.env.CATALYST_BH_GH_QUOTA_STALE_MS, 15 * 60_000),
};

function normalizeResource(resource) {
  if (!resource || typeof resource !== "object") return null;
  const { limit, used, remaining } = resource;
  if (![limit, used, remaining].every(Number.isFinite)) return null;
  const reset = resource.reset;
  let resetAt = null;
  if (Number.isFinite(reset)) {
    try {
      resetAt = new Date(reset * 1_000).toISOString();
    } catch {
      resetAt = null;
    }
  }
  return { limit, used, remaining, resetAt };
}

export function parseRateLimitBody(bodyText, { host = null, nowMs } = {}) {
  if (typeof bodyText !== "string" || bodyText.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const core = normalizeResource(parsed?.resources?.core);
  if (!core || !Number.isFinite(nowMs)) return null;
  let sampledAt;
  try {
    sampledAt = new Date(nowMs).toISOString();
  } catch {
    return null;
  }
  return {
    core,
    graphql: normalizeResource(parsed?.resources?.graphql),
    search: normalizeResource(parsed?.resources?.search),
    host,
    sampledAt,
  };
}

function unknown(fields = {}) {
  return {
    state: "unknown",
    remaining: null,
    limit: null,
    remainingPct: null,
    resetAt: null,
    ageMs: null,
    stale: false,
    ...fields,
  };
}

export function evaluateQuotaHeadroom(snapshot, thresholds = {}, nowMs) {
  const remaining = snapshot?.core?.remaining;
  const limit = snapshot?.core?.limit;
  const sampledMs = Date.parse(snapshot?.sampledAt ?? "");
  if (!snapshot?.core || !Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(sampledMs) || !Number.isFinite(nowMs)) {
    return unknown();
  }

  const ageMs = Math.max(0, nowMs - sampledMs);
  const stalenessMs = finiteOr(thresholds.stalenessMs, GITHUB_QUOTA_DEFAULTS.stalenessMs);
  const fields = {
    remaining,
    limit,
    remainingPct: (remaining / limit) * 100,
    resetAt: snapshot.core.resetAt ?? null,
    ageMs,
    stale: ageMs > stalenessMs,
  };
  if (fields.stale) return unknown(fields);
  if (remaining === 0) return { state: "exhausted", ...fields };
  const floor = finiteOr(thresholds.coreRemainingPct, GITHUB_QUOTA_DEFAULTS.coreRemainingPct);
  return { state: fields.remainingPct <= floor ? "low" : "ok", ...fields };
}
