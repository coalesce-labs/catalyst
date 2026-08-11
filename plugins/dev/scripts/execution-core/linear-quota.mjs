// Pure normalization and evaluation for Linear's request-quota response headers.
// Deliberately owns no filesystem, subprocess, or clock IO. The finite-number
// handling mirrors github-quota.mjs intentionally; the gates evolve separately.
function finiteOr(value, fallback) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const LINEAR_QUOTA_DEFAULTS = {
  remainingPct: finiteOr(process.env.CATALYST_LINEAR_QUOTA_PCT, 10),
  stalenessMs: finiteOr(process.env.CATALYST_LINEAR_QUOTA_STALE_MS, 15 * 60_000),
};

function headerGet(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name) ?? headers.get(name.toLowerCase());
  const wanted = name.toLowerCase();
  for (const [key, value] of headers instanceof Map ? headers : Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return value;
  }
  return null;
}

export function parseLinearQuotaHeaders(headers, { host = null, nowMs } = {}) {
  const limit = Number(headerGet(headers, "x-ratelimit-requests-limit"));
  const remaining = Number(headerGet(headers, "x-ratelimit-requests-remaining"));
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining) || remaining < 0 || !Number.isFinite(nowMs)) return null;
  let sampledAt;
  try { sampledAt = new Date(nowMs).toISOString(); } catch { return null; }
  const reset = Number(headerGet(headers, "x-ratelimit-requests-reset"));
  let resetAt = null;
  if (Number.isFinite(reset)) {
    try { resetAt = new Date(reset * 1_000).toISOString(); } catch { resetAt = null; }
  }
  return { requests: { limit, used: Math.max(0, limit - remaining), remaining, resetAt }, host, sampledAt };
}

function unknown(fields = {}) {
  return { state: "unknown", remaining: null, limit: null, remainingPct: null, resetAt: null, sampledAt: null, ...fields };
}

export function evaluateLinearQuota(snapshot, { nowMs, remainingPct, stalenessMs } = {}) {
  const remaining = snapshot?.requests?.remaining;
  const limit = snapshot?.requests?.limit;
  const sampledMs = Date.parse(snapshot?.sampledAt ?? "");
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(sampledMs) || !Number.isFinite(nowMs)) return unknown();
  const fields = { remaining, limit, remainingPct: (remaining / limit) * 100, resetAt: snapshot.requests.resetAt ?? null, sampledAt: snapshot.sampledAt };
  if (Math.max(0, nowMs - sampledMs) > finiteOr(stalenessMs, LINEAR_QUOTA_DEFAULTS.stalenessMs)) return unknown(fields);
  if (remaining === 0) return { state: "exhausted", ...fields };
  return { state: fields.remainingPct <= finiteOr(remainingPct, LINEAR_QUOTA_DEFAULTS.remainingPct) ? "low" : "ok", ...fields };
}
