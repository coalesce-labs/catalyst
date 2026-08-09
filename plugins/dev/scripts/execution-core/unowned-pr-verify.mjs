import { defaultCheckOpenPrs } from "./open-pr-gate.mjs";

// Accept both shapes the quota snapshot is written in: an epoch-millisecond integer
// and an ISO string. Date.parse() on a number yields NaN, so branch on the type.
function tsOf(value) {
  if (value == null) return NaN;
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== "") return n;
  return Date.parse(String(value));
}

// This verifier is used to prove PR absence before flagging unowned work. Its
// polarity is deliberately conservative: unverifiable spares the ticket.
export function makeOpenPrVerifier({
  checkOpenPrs = defaultCheckOpenPrs,
  getQuota = () => null,
  now = () => Date.now(),
  ttlMs = 30 * 60_000,
  minRemaining = 500,
  // CAT-11 (Codex P2 round 1): how old a quota snapshot may be and still gate.
  quotaMaxAgeMs = 15 * 60_000,
  enabled = true,
} = {}) {
  const memo = new Map();
  return function verifyOpenPrs(ticket) {
    if (!enabled) return null;
    const at = Number(now());
    const cached = memo.get(ticket);
    if (cached && at - cached.at < ttlMs) return cached.result;

    let quota = null;
    try { quota = getQuota(); } catch { /* advisory snapshot */ }
    // CAT-11 (Codex P2 round 1): only a FRESH snapshot may gate. A raw remaining-value
    // check meant that if the sampler wrote a below-floor reading and then stopped (or
    // could not refresh), every verification stayed unverifiable forever — permanently
    // hiding unowned tickets — even long after the real quota reset. Treat a snapshot
    // that is stale, or whose own reset time has already passed, as UNKNOWN and let
    // verification proceed; the per-call gh failure path still catches a real 403.
    const remaining = quota?.core?.remaining ?? quota?.remaining;
    const sampledAt = tsOf(quota?.core?.sampledAt ?? quota?.sampledAt);
    const resetAt = tsOf(quota?.core?.resetAt ?? quota?.resetAt ?? quota?.core?.reset ?? quota?.reset);
    const stale = Number.isFinite(quotaMaxAgeMs) && quotaMaxAgeMs > 0
      && (!Number.isFinite(sampledAt) || at - sampledAt > quotaMaxAgeMs);
    const alreadyReset = Number.isFinite(resetAt) && resetAt <= at;
    if (Number.isFinite(Number(remaining)) && Number(remaining) < minRemaining
        && !stale && !alreadyReset) {
      return { unverifiable: true, reason: "github-quota-floor" };
    }

    try {
      const result = checkOpenPrs(ticket);
      if (!result?.unverifiable) memo.set(ticket, { at, result });
      return result;
    } catch (error) {
      return { unverifiable: true, reason: error instanceof Error ? error.message : String(error) };
    }
  };
}
