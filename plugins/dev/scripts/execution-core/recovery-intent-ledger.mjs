import { readFileSync } from "node:fs";
import { join } from "node:path";

export const RECOVERY_LEAVE_ALONE_TTL_MS =
  Number(process.env.CATALYST_RECOVERY_LEAVE_ALONE_TTL_HOURS) * 3600e3 || 24 * 3600e3;

export function recoveryIntentPath(orchDir, ticket) {
  return join(orchDir, ".recovery-intents", `${ticket}.json`);
}

export function readRecoveryIntent(orchDir, ticket) {
  if (!orchDir || !ticket) return null;
  try {
    const data = JSON.parse(readFileSync(recoveryIntentPath(orchDir, ticket), "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

export function leaveAloneSuppression(ticket, { orchDir, now = () => Date.now() } = {}) {
  const data = readRecoveryIntent(orchDir, ticket);
  if (!data || data.verdict !== "leave-alone") return null;
  // Codex #3217 P2: NEVER suppress a ticket still carrying the escalated latch.
  // `recordVerdict` deliberately preserves `escalated: true` when a later
  // leave-alone verdict lands, and the authoritative `defaultSkipReason` gives
  // that latch (7-day terminal TTL) precedence over the shorter leave-alone TTL —
  // the ticket is handed off to a human. Suppressing it here would drop a
  // still-human-owned ticket out of the operator sweep for up to the leave-alone
  // TTL and report that no action is needed. Defer to the authoritative
  // precedence instead.
  if (data.escalated === true) return null;
  const verdictTs = data.verdictTs;
  if (typeof verdictTs !== "number" || !Number.isFinite(verdictTs)) return null;
  const ageMs = now() - verdictTs;
  if (!(ageMs >= 0) || ageMs >= RECOVERY_LEAVE_ALONE_TTL_MS) return null;
  return {
    suppressed: true,
    ageMs,
    verdictTs,
    verdictReason: typeof data.verdictReason === "string" ? data.verdictReason : null,
  };
}
