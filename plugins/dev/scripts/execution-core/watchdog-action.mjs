// watchdog-action.mjs — CTL-729 progress-watchdog kill + escalate action.
// Called by Pass 0w (scheduler.mjs) after evaluateHungWorker returns
// "kill-escalate" and mode === "enforce".
//
// Performs four side-effects idempotently:
//   (1) Atomic terminal-signal rewrite: status:"failed" + failureReason + failedAt.
//   (2) Fire-and-forget reap-intent: routes through reaper._handleBgReap → claude stop.
//   (3) labelOnce(orchDir, ticket, "needs-human", writeStatus) — .applied marker guards.
//   (4) OPTIONAL revive-budget (default 0 = off): one --resume re-dispatch before escalating.
//
// The double-fire guard is the re-read terminal status ("already-terminal"), NOT the
// shared escalation cooldown — so a recovery escalation in the same window cannot
// suppress a genuine watchdog kill.
//
// SETTLED is intentionally wider than signal-reader.mjs:TERMINAL (includes "aborted",
// "skipped") — the watchdog's "I've already acted" check must absorb all
// variants of "this phase is done".

import { readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "./config.mjs";
import { emitReapIntent } from "./reap-intent.mjs";
import { labelOnce, recordEscalation } from "./label-guard.mjs";
import { coerceExplanation } from "./escalation-explanation.mjs";

const SETTLED = new Set(["done", "failed", "stalled", "aborted", "skipped", "complete"]);

function priorReviveCount(orchDir, ticket, phase) {
  try {
    const re = new RegExp(`^\\.watchdog-revive-${phase}\\.(\\d+)$`);
    return readdirSync(join(orchDir, "workers", ticket)).reduce((m, f) => {
      const x = re.exec(f);
      return x ? Math.max(m, Number(x[1])) : m;
    }, 0);
  } catch {
    return 0;
  }
}

// killHungWorker — perform the watchdog kill + escalate sequence.
// Returns { outcome: "escalated"|"revived"|"already-terminal" }.
// Async ONLY for the fire-and-forget reap emit; the terminal signal write is sync.
export async function killHungWorker(
  orchDir,
  ticket,
  signal,
  {
    elapsedMin,
    commitCount = 0,
    reviveBudget = 0,
    now = Date.now,
    writeStatus,
    emit = emitReapIntent,
    reviveDispatch,
  } = {},
) {
  const phase = signal.phase;
  if (SETTLED.has(signal.status)) return { outcome: "already-terminal" };
  const bgJobId = signal.raw?.bg_job_id;
  const failureReason = `hung_no_progress:${phase}:${Math.floor(elapsedMin)}m_${commitCount}_commits`;

  // OPTIONAL revive-budget: stop the old session then re-dispatch once before escalating.
  const used = priorReviveCount(orchDir, ticket, phase);
  if (reviveBudget > 0 && used < reviveBudget && typeof reviveDispatch === "function") {
    const attempt = used + 1;
    if (bgJobId) {
      void emit("phase.terminal.reap-requested", {
        ticket, phase, bgJobId, reason: `${failureReason}:revive`,
      }).catch((err) => log.warn({ ticket, phase, err }, "ctl-729: revive reap emit failed"));
    }
    try {
      // CTL-729 remediate: pass bgJobId so the scheduler's reviveDispatch closure
      // can resolve the dead session to a `claude --resume` UUID (re-dispatch with
      // continuity). orchDir is included for dispatchers that need it; the
      // production closure (scheduler Pass 0w) closes over orchDir and ignores it.
      reviveDispatch({ orchDir, ticket, phase, attempt, bgJobId });
    } catch (err) {
      log.warn({ ticket, phase, err: err.message }, "ctl-729: revive dispatch threw");
    }
    try {
      writeFileSync(
        join(orchDir, "workers", ticket, `.watchdog-revive-${phase}.${attempt}`),
        new Date(now()).toISOString(),
      );
    } catch (err) {
      // CTL-729 remediate: this marker is the SOLE persistence backing
      // priorReviveCount, which enforces the revive-budget cap. A silent write
      // failure makes the next tick read a lower count and revive the same worker
      // again (potentially unbounded), so make the failure observable.
      log.warn(
        { ticket, phase, attempt, err: err.message },
        "ctl-729: revive-marker write failed — revive cap may not hold",
      );
    }
    log.warn({ ticket, phase, attempt, reviveBudget }, "ctl-729: hung worker revived (budget)");
    return { outcome: "revived" };
  }

  // (1) Atomic terminal write. Re-read guards a raced-to-terminal worker.
  const sigPath = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  try {
    const cur = JSON.parse(readFileSync(sigPath, "utf8"));
    if (SETTLED.has(cur.status)) return { outcome: "already-terminal" };
    // CTL-1065: build structured explanation alongside failureReason.
    const explanation = coerceExplanation(
      {
        what_failed: `${phase} phase worker made no commits in ${Math.floor(elapsedMin)} minutes`,
        observed: { elapsedMin: Math.floor(elapsedMin), commitCount, bgJobId },
        attempts: [],
        why_gave_up: `watchdog killed the worker — no progress within the hung-worker threshold`,
        human_question: `restart ${ticket} ${phase} from scratch, or is this a known slow/flaky step (extend the threshold)?`,
      },
      { ticket, phase },
    );
    const updated = {
      ...cur,
      status: "failed",
      failureReason,
      explanation,
      failedAt: new Date(now()).toISOString(),
    };
    const tmp = `${sigPath}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`);
    renameSync(tmp, sigPath);
  } catch (err) {
    log.error({ ticket, phase, err: err.message }, "ctl-729: terminal signal write failed");
  }

  // (2) Fire-and-forget reap-intent → reaper._handleBgReap → claude stop <shortId>.
  if (bgJobId) {
    void emit("phase.terminal.reap-requested", {
      ticket, phase, bgJobId, worktreePath: signal.raw?.worktreePath, reason: failureReason,
    }).catch((err) => log.warn({ ticket, phase, err }, "ctl-729: reap-intent emit failed"));
  }

  // (3) needs-human (idempotent via .applied marker) + escalation record.
  labelOnce(orchDir, ticket, "needs-human", writeStatus);
  recordEscalation(orchDir, ticket, phase, failureReason, now());

  log.warn(
    { ticket, phase, elapsedMin, commitCount },
    "ctl-729: hung worker force-killed + escalated",
  );
  return { outcome: "escalated" };
}
