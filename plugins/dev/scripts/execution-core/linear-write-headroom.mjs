// linear-write-headroom.mjs — CTL-2027 Phase 2.
//
// Pure normalization and evaluation for the host's Linear write-budget ledger
// (linear-write-budget.mjs's `{day, total, byTicket}` shape). This module
// deliberately owns NO filesystem, subprocess, or clock IO — the ledger is read
// and rolled to the current UTC day by the CALLER (write-budget-health.mjs's
// `checkLinearWriteBudget`, board-health.mjs's board-scan reader) and handed in
// here, mirroring github-quota.mjs's `evaluateQuotaHeadroom` (CAT-40) — the same
// "read outside, evaluate inside a zero-IO leaf" split.
//
// Before this module, `write-budget-health.mjs` was the ONLY place this
// arithmetic existed, and it is a doctor-shaped check (returns an `mkCheck`
// object, tangled with pid-file/execution-core.env resolution) — not a reusable
// evaluator. board-health.mjs could not call it without either importing a
// doctor check or hand-rolling a THIRD copy of "spent vs budget" arithmetic.
// This is the one shared evaluator both now call.
//
// `resolveWriteBudgetCaps` is NOT reimplemented here — it is re-exported
// straight from linear-write-proxy.mjs, the proxy's own cap resolver (the
// numbers a live proxy actually enforces). A second, independently-typed copy
// of "parse CATALYST_LINEAR_WRITE_DAILY_BUDGET as a finite positive integer or
// fall back" is exactly the kind of drift CTL-2073's own comment on that
// function warns against ("a doctor-side re-validation would only be able to
// agree with this by accident").

export { resolveWriteBudgetCaps } from "./linear-write-proxy.mjs";
import { utcDayOf } from "./linear-write-budget.mjs";

// A budget headroom evaluator answers "how close is this host to being
// throttled", which is a different question from doctor's own thresholds — so
// this default is independently chosen, not copied from GITHUB_QUOTA_DEFAULTS'
// 10%. Linear write spend can be bursty (a single stuck caller can spend its
// entire per-ticket cap in well under a minute — see CTL-1936's incident
// writeup), so a slightly wider warn band gives an operator more lead time
// before the state flips straight from "ok" to "capped".
export const LINEAR_WRITE_HEADROOM_DEFAULTS = {
  warnPct: finiteOr(process.env.CATALYST_BH_LINEAR_WRITE_WARN_PCT, 20),
};

// An empty/whitespace-only string is "unset", not zero — `Number("")` is 0,
// which would otherwise turn an exported-but-blank env var into the strictest
// possible warn threshold. Mirrors github-quota.mjs's own `finiteOr`.
function finiteOr(value, fallback) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function unknown() {
  return { state: "unknown", remaining: null, remainingPct: null };
}

/** the (ticketId, spent) pair with the highest spend, or null for an empty ledger. */
function worstOf(byTicket) {
  const entries = Object.entries(byTicket ?? {});
  if (entries.length === 0) return null;
  return entries.sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))[0];
}

/**
 * evaluateLinearWriteHeadroom — pure. `{ ledger, caps, now }` →
 * `{ state, remaining, remainingPct, ... }`, `state` ∈ `ok | warn | capped | unknown`.
 *
 * ⛔ Every new verdict here is THREE-VALUED (CTL-2027 Desired End State #4): an
 * absent, malformed, or STALE (wrong UTC day) ledger reports `unknown`, never
 * `ok`. This is deliberately stricter than `checkLinearWriteBudget`'s own INFO
 * treatment of an absent ledger — that check writes a human-legible sentence
 * ("this host has not proxied a write") where "no evidence" and "verified
 * healthy" read differently; a machine-consumed board-scan field has no such
 * nuance available, so an unread ledger must never be indistinguishable from a
 * genuinely spare one.
 *
 * `ledger.day !== utcDayOf(now)` is read the same way: this leaf does not roll
 * to today itself (that would be IO-adjacent policy — "what does yesterday's
 * spend mean for today's budget" belongs to the caller, exactly as
 * `checkLinearWriteBudget` already calls `rollToDay` before judging). Handing
 * this leaf a stale-day ledger is caller error, and the caller is told so via
 * `unknown` rather than the leaf silently pretending to roll it.
 *
 * `remaining`/`remainingPct` report the MORE CONSTRAINED of the two limits (the
 * host's daily total vs. the single worst ticket's per-ticket spend) — the
 * binding one, matching `checkLinearWriteBudget`'s own "per-ticket BEFORE
 * host-wide" precedence (a single runaway ticket at its cap is exactly the
 * CTL-2015 shape this ticket documents, and the host as a whole can be nowhere
 * near exhausted while that is true).
 */
export function evaluateLinearWriteHeadroom({ ledger, caps, now, warnPct = LINEAR_WRITE_HEADROOM_DEFAULTS.warnPct } = {}) {
  const dailyBudget = caps?.dailyBudget;
  const perTicketCap = caps?.perTicketCap;
  const capsValid =
    Number.isFinite(dailyBudget) && dailyBudget > 0 && Number.isFinite(perTicketCap) && perTicketCap > 0;
  if (!capsValid || !Number.isFinite(now)) return unknown();
  if (!ledger || typeof ledger !== "object" || Array.isArray(ledger)) return unknown();
  if (typeof ledger.day !== "string") return unknown();
  if (typeof ledger.total !== "number" || !Number.isFinite(ledger.total)) return unknown();
  if (!ledger.byTicket || typeof ledger.byTicket !== "object" || Array.isArray(ledger.byTicket)) return unknown();
  if (ledger.day !== utcDayOf(now)) return unknown(); // stale — the caller must roll before calling

  const total = ledger.total;
  const worstTicket = worstOf(ledger.byTicket);
  const worstSpent = worstTicket ? Number(worstTicket[1]) || 0 : 0;

  const dayRemaining = Math.max(0, dailyBudget - total);
  const dayRemainingPct = (dayRemaining / dailyBudget) * 100;
  const ticketRemaining = Math.max(0, perTicketCap - worstSpent);
  const ticketRemainingPct = (ticketRemaining / perTicketCap) * 100;

  const binding =
    dayRemainingPct <= ticketRemainingPct
      ? { remaining: dayRemaining, remainingPct: dayRemainingPct }
      : { remaining: ticketRemaining, remainingPct: ticketRemainingPct };

  const state = binding.remaining <= 0 ? "capped" : binding.remainingPct <= warnPct ? "warn" : "ok";

  return {
    state,
    remaining: binding.remaining,
    remainingPct: binding.remainingPct,
    total,
    dailyBudget,
    perTicketCap,
    worstTicket,
    dayRemaining,
    dayRemainingPct,
    ticketRemaining,
    ticketRemainingPct,
  };
}
