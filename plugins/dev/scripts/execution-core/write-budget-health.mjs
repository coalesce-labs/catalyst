// write-budget-health.mjs — CTL-1936 AC5, the `catalyst doctor` half.
//
// "Given a host has exhausted its daily cloud write budget … `catalyst doctor` reports the
// host as write-exhausted rather than healthy."
//
// The event raised at the crossing is edge-triggered and therefore easy to miss — it fires
// once, hours before anyone looks. This is the standing answer: the same fact, on demand.
//
// ⛔ ADVISORY — never FAIL. doctor's FAIL count gates worker activation, and a host whose
// Linear write budget is spent can still do every other kind of work; taking it out of
// service would turn a bounded degradation into an outage. Same posture, and same reason,
// as checkRegistryTeamIdentity and install-completeness.

import { existsSync } from "node:fs";

import { STATUS, mkCheck } from "./doctor-status.mjs";
import {
  DEFAULT_DAILY_BUDGET,
  DEFAULT_PER_TICKET_CAP,
  readLedger,
  rollToDay,
  utcDayOf,
} from "./linear-write-budget.mjs";
import { defaultBudgetPath } from "./linear-write-proxy.mjs";

export function checkLinearWriteBudget(deps = {}) {
  const {
    env = process.env,
    nowFn = () => Date.now(),
    path = defaultBudgetPath(env),
    readLedgerFn = readLedger,
    exists = existsSync,
    dailyBudget = Number(env.CATALYST_LINEAR_WRITE_DAILY_BUDGET) || DEFAULT_DAILY_BUDGET,
    perTicketCap = Number(env.CATALYST_LINEAR_WRITE_TICKET_CAP) || DEFAULT_PER_TICKET_CAP,
  } = deps;

  if (!exists(path)) {
    // No ledger is the normal state for a host with the proxy off, or one that has not
    // written yet today. It is NOT evidence of health, and it is not a problem either.
    return mkCheck(
      "linear-write-budget",
      STATUS.INFO,
      `no write-budget ledger at ${path} — this host has not proxied a Linear write (proxy off, or none yet)`
    );
  }

  const r = readLedgerFn(path);
  if (r.state !== "loaded") {
    // ⛔ Unusable is reported as unusable. Reading it as "nothing spent" would report a
    // host as healthy on the strength of a file that is telling us it is broken — and
    // that host's throttle is also disarmed, which is the thing an operator most needs
    // to know here.
    return mkCheck(
      "linear-write-budget",
      STATUS.WARN,
      `write-budget ledger present but UNUSABLE (${r.reason ?? "unknown"}) at ${path} — ` +
        "this host's cloud write spend is NOT being bounded (CTL-1936)"
    );
  }

  // ⚠️ Roll to today BEFORE judging. Yesterday's exhausted ledger is not today's
  // exhaustion — the budget resets on the UTC day boundary, so reading the stored totals
  // without the roll would report a host as write-exhausted for a whole day after it
  // recovered.
  const today = utcDayOf(nowFn());
  const ledger = rollToDay(r.ledger, today);
  const total = Number(ledger.total ?? 0) || 0;
  const byTicket = ledger.byTicket ?? {};
  const worst = Object.entries(byTicket).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0] ?? null;

  if (total >= dailyBudget) {
    return mkCheck(
      "linear-write-budget",
      STATUS.WARN,
      `WRITE-EXHAUSTED — ${total}/${dailyBudget} cloud writes spent for UTC ${ledger.day}; ` +
        `every further Linear write from this host is refused until the day rolls` +
        (worst ? ` (largest single ticket: ${worst[0]} at ${worst[1]})` : "")
    );
  }
  if (worst && (worst[1] ?? 0) >= perTicketCap) {
    // A runaway in progress: the host is not out of budget, but one caller is capped —
    // which is the shape that spent an entire day in 13 minutes before the cap existed.
    return mkCheck(
      "linear-write-budget",
      STATUS.WARN,
      `one ticket is at its per-ticket cap — ${worst[0]} at ${worst[1]}/${perTicketCap} ` +
        `(host total ${total}/${dailyBudget}, UTC ${ledger.day}); its writes are refused locally while others proceed`
    );
  }
  return mkCheck(
    "linear-write-budget",
    STATUS.PASS,
    `cloud write spend ${total}/${dailyBudget} for UTC ${ledger.day}` +
      (worst ? `; largest single ticket ${worst[0]} at ${worst[1]}/${perTicketCap}` : "")
  );
}
