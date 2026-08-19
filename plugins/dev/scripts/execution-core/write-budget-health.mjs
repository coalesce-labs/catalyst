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
//
// Returns { value, confirmed }. `confirmed:false` means neither the env FILE nor
// doctor's own env carried the var, so `value` is DEFAULT_* — a guess, not a read.
function resolveDaemonBudget(varName, fallback, { env, execCoreEnvPath, envFileExists, envFileRead }) {
  if (envFileExists(execCoreEnvPath)) {
    try {
      const raw = parseEnvAssignments(envFileRead(execCoreEnvPath, "utf8")).get(varName);
      if (raw !== undefined) {
        const n = Number(raw.trim().replace(/^["']|["']$/g, ""));
        if (Number.isFinite(n) && n > 0) return { value: n, confirmed: true };
      }
    } catch {
      // unreadable env file (permissions, disappeared mid-read) — fall through
    }
  }
  // Still consult doctor's own env: covers a caller that already exported the var
  // (a test, or doctor invoked from inside the daemon's own sourced shell).
  const n = Number(env[varName]);
  if (Number.isFinite(n) && n > 0) return { value: n, confirmed: true };
  return { value: fallback, confirmed: false };
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
    // CTL-2073 AC2: "never assert exhaustion off an unverified default." A daemon
    // pid-file existing means SOME daemon is (or recently was) running this host's
    // real, possibly-different budget — so an unconfirmed DEFAULT_* value cannot be
    // trusted to compare against. No pid-file at all means there is no daemon to
    // disagree with the default, so DEFAULT_* is the legitimately correct value
    // (this is the normal, healthy shape for a host with the proxy off entirely).
    // Deliberately just existence, not full liveness/identity verification (unlike
    // checkSdkDaemonEnv's `ps eww` probe) — this check is advisory-only and a stale
    // pid-file merely means "be more cautious," never "FAIL".
    pidFilePath = resolve(env.CATALYST_DIR || `${homedir()}/catalyst`, "execution-core", "daemon.pid"),
    pidFileExists = existsSync,
    dailyBudgetR = resolveDaemonBudget("CATALYST_LINEAR_WRITE_DAILY_BUDGET", DEFAULT_DAILY_BUDGET, {
      env,
      execCoreEnvPath,
      envFileExists,
      envFileRead,
    }),
    perTicketCapR = resolveDaemonBudget("CATALYST_LINEAR_WRITE_TICKET_CAP", DEFAULT_PER_TICKET_CAP, {
      env,
      execCoreEnvPath,
      envFileExists,
      envFileRead,
    }),
  } = deps;
  const dailyBudget = dailyBudgetR.value;
  const perTicketCap = perTicketCapR.value;
  // Lazy — only stat the pid-file if a value actually went unconfirmed AND the
  // ledger is about to compare against it below (the common case never reaches here).
  let daemonMightBeRunning;
  const daemonPossiblyRunning = () =>
    daemonMightBeRunning ?? (daemonMightBeRunning = pidFileExists(pidFilePath));

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
    // CTL-2073 AC2: "never assert exhaustion off an unverified default." dailyBudget
    // here is DEFAULT_DAILY_BUDGET (300) — a guess, not a read — precisely when a
    // daemon pid-file exists: some daemon is (or was) configured with its OWN real
    // budget that this check could not read, so 300 is not confirmed to be it.
    if (!dailyBudgetR.confirmed && daemonPossiblyRunning()) {
      return mkCheck(
        "linear-write-budget",
        STATUS.INFO,
        `cannot verify this host's real write-budget limit — a daemon pid-file exists at ${pidFilePath} ` +
          `but neither execution-core.env nor this shell's own env carries CATALYST_LINEAR_WRITE_DAILY_BUDGET; ` +
          `${total} writes spent for UTC ${ledger.day} against an UNCONFIRMED default of ${dailyBudget} — ` +
          `not asserting exhaustion off a limit that has not actually been read`
      );
    }
    return mkCheck(
      "linear-write-budget",
      STATUS.WARN,
      `WRITE-EXHAUSTED — ${total}/${dailyBudget} cloud writes spent for UTC ${ledger.day}; ` +
        `every further Linear write from this host is refused until the day rolls` +
        (worst ? ` (largest single ticket: ${worst[0]} at ${worst[1]})` : "")
    );
  }
  if (worst && (worst[1] ?? 0) >= perTicketCap) {
    if (!perTicketCapR.confirmed && daemonPossiblyRunning()) {
      return mkCheck(
        "linear-write-budget",
        STATUS.INFO,
        `cannot verify this host's real per-ticket write cap — a daemon pid-file exists at ${pidFilePath} ` +
          `but neither execution-core.env nor this shell's own env carries CATALYST_LINEAR_WRITE_TICKET_CAP; ` +
          `${worst[0]} at ${worst[1]} writes against an UNCONFIRMED cap of ${perTicketCap} — ` +
          `not asserting a cap breach off a limit that has not actually been read`
      );
    }
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
