import { defaultCheckOpenPrs } from "./open-pr-gate.mjs";

// This verifier is used to prove PR absence before flagging unowned work. Its
// polarity is deliberately conservative: unverifiable spares the ticket.
export function makeOpenPrVerifier({
  checkOpenPrs = defaultCheckOpenPrs,
  getQuota = () => null,
  now = () => Date.now(),
  ttlMs = 30 * 60_000,
  minRemaining = 500,
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
    const remaining = quota?.core?.remaining ?? quota?.remaining;
    if (Number.isFinite(Number(remaining)) && Number(remaining) < minRemaining) {
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
