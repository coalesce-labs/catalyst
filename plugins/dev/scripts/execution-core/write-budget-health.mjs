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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import { STATUS, mkCheck } from "./doctor-status.mjs";
import { parseEnvAssignments } from "./execution-core-env-drift-health.mjs";
import {
  DEFAULT_DAILY_BUDGET,
  DEFAULT_PER_TICKET_CAP,
  readLedger,
  rollToDay,
  utcDayOf,
} from "./linear-write-budget.mjs";
import { defaultBudgetPath } from "./linear-write-proxy.mjs";

// CTL-2073: `env.CATALYST_LINEAR_WRITE_DAILY_BUDGET` used to mean "doctor's own
// process.env" — but doctor runs in a plain shell, and the lever the DAEMON actually
// enforces lives in execution-core.env, the file its launcher sources before start.
// Measured on mini: the daemon ran under 2000, doctor's shell had the var unset, so
// this fell back to DEFAULT_DAILY_BUDGET (300) — smaller than every real deployment,
// so the check failed in the alarming direction (WRITE-EXHAUSTED at 34% of the real
// budget) rather than the quiet one. Same defect class as CTL-2068/CTL-2071: resolving
// configuration from a process that isn't the one being graded.
function resolveDaemonBudget(varName, fallback, { env, execCoreEnvPath, envFileExists, envFileRead }) {
  if (envFileExists(execCoreEnvPath)) {
    try {
      const raw = parseEnvAssignments(envFileRead(execCoreEnvPath, "utf8")).get(varName);
      if (raw !== undefined) {
        const n = Number(raw.trim().replace(/^["']|["']$/g, ""));
        if (Number.isFinite(n) && n > 0) return n;
      }
    } catch {
      // unreadable env file (permissions, disappeared mid-read) — fall through
    }
  }
  // Still consult doctor's own env: covers a caller that already exported the var
  // (a test, or doctor invoked from inside the daemon's own sourced shell).
  const n = Number(env[varName]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function checkLinearWriteBudget(deps = {}) {
  const {
    env = process.env,
    nowFn = () => Date.now(),
    path = defaultBudgetPath(env),
    readLedgerFn = readLedger,
    exists = existsSync,
    // CTL-2073 — separate DI names from the ledger's `exists`/readLedgerFn above,
    // deliberately: a test stubbing ONLY the ledger's existence must not also make
    // this env-file check believe execution-core.env exists on whatever host the
    // test happens to run on.
    execCoreEnvPath = env.CATALYST_EXECUTION_CORE_ENV || resolve(homedir(), ".config", "catalyst", "execution-core.env"),
    envFileExists = existsSync,
    envFileRead = readFileSync,
    dailyBudget = resolveDaemonBudget("CATALYST_LINEAR_WRITE_DAILY_BUDGET", DEFAULT_DAILY_BUDGET, {
      env,
      execCoreEnvPath,
      envFileExists,
      envFileRead,
    }),
    perTicketCap = resolveDaemonBudget("CATALYST_LINEAR_WRITE_TICKET_CAP", DEFAULT_PER_TICKET_CAP, {
      env,
      execCoreEnvPath,
      envFileExists,
      envFileRead,
    }),
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
