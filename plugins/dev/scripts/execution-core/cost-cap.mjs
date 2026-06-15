// cost-cap.mjs — CTL-1137 cost-cap watcher: pure decision + cost source + throttle.
//
// Out-of-process preemption: the daemon (NOT the worker — never the watcher-is-the-
// watched anti-pattern that caused the 2026-06-14 outage) checks each LIVE autonomous
// phase worker's cumulative SESSION cost against a per-session cap. Mirrors the CTL-729
// hung-detector split: a pure, IO-free decision fn (evaluateCostCap) that is fully
// unit-testable, plus injectable IO (fetchSessionCostUsd from Prometheus, the throttle).
// The enforce side effects (terminal-write + reap + event) live in the scheduler Pass 0c
// driver, exactly as Pass 0w delegates to killHungWorker.
//
// TWO INVARIANTS, both load-bearing:
//   1. FAIL-OPEN. A missing/unreadable cost (Prom down, session unresolved, empty result)
//      is NEVER evidence to abort. We never kill a daemon because we cannot read its cost.
//   2. AUTONOMOUS-ONLY. The caller scopes to nested bg phase workers; interactive sessions
//      (the $300+ outliers) are out of scope and the cap never touches them.

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const ACTIONABLE_STATUS = new Set(["running", "dispatched"]);
const NO_OP = (reason) => Object.freeze({ action: "none", reason, costUsd: null });

// evaluateCostCap — decide whether ONE worker should be preempted for cost.
// inputs: { status, sessionCost (number|null), capUsd }
//   sessionCost — cumulative USD for the worker's Claude session, or null when the
//                 cost signal is unavailable (Prom error / session unresolved / empty).
// returns frozen { action: "abort"|"none", reason, costUsd }
export function evaluateCostCap(i) {
  // Status gate — only a running/dispatched worker can be preempted (terminal absorbs all).
  if (!ACTIONABLE_STATUS.has(i.status)) return NO_OP("not-actionable");
  // FAIL-OPEN — no cost signal is never evidence of an overspend.
  if (i.sessionCost == null || !Number.isFinite(i.sessionCost)) return NO_OP("no-cost-data");
  const cap = Number(i.capUsd);
  if (!Number.isFinite(cap) || cap <= 0) return NO_OP("no-cap");
  if (i.sessionCost < cap) return NO_OP("under-cap");
  return Object.freeze({
    action: "abort",
    reason: `cost_cap_exceeded:$${i.sessionCost.toFixed(2)}>=$${cap.toFixed(2)}`,
    costUsd: i.sessionCost,
  });
}

// --- throttle: only Prom-query a given session once per pollMs, not every tick ---
// The scheduler ticks every few seconds; a Prom HTTP call per live worker per tick
// would hammer the stack. A session's cumulative cost moves slowly relative to the
// cap ($40 vs <$3 typical), so a ~30s cadence preempts a runaway with ample margin.
const _lastCheckBySession = new Map();
export function shouldCheckNow(sessionId, nowMs, pollMs, store = _lastCheckBySession) {
  if (!sessionId) return false;
  const last = store.get(sessionId);
  if (last != null && nowMs - last < pollMs) return false;
  store.set(sessionId, nowMs);
  return true;
}
// Test hook — reset the module-level throttle store between cases.
export function _resetCostCapThrottle() { _lastCheckBySession.clear(); }

// fetchSessionCostUsd — the Prometheus cost source. FAIL-OPEN: returns null on ANY
// error/timeout/empty result so the caller never aborts on a missing signal.
// The metric is a per-session cumulative counter, so the instant sum IS the spend.
export async function fetchSessionCostUsd(
  sessionId,
  { promBaseUrl, timeoutMs = 8000, fetchImpl = globalThis.fetch } = {},
) {
  if (!sessionId || !promBaseUrl || typeof fetchImpl !== "function") return null;
  const query = `sum(claude_code_cost_usage_USD_total{session_id="${sessionId}"})`;
  const url = `${promBaseUrl.replace(/\/+$/, "")}/api/v1/query?query=${encodeURIComponent(query)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res || res.ok !== true) return null;
    const json = await res.json();
    if (json?.status !== "success") return null;
    const raw = json?.data?.result?.[0]?.value?.[1];
    const n = raw == null ? null : Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // Prom unreachable / timeout / parse error → no signal → fail-open
  } finally {
    clearTimeout(timer);
  }
}

// markPhaseSignalFailed — the ENFORCE terminal-write (only reached in mode:"enforce").
// Atomically rewrites the worker's active phase signal to status:"failed" with the
// cost-cap reason + a needs-human marker, mirroring abort-worker.mjs's atomic write.
// The sync terminal write is the load-bearing state change: isTicketInFlight then
// treats the ticket as no longer holding a live worker, freeing the slot and stopping
// re-fire next tick. Best-effort; never throws (a missing/unwritable signal is a no-op).
export function markPhaseSignalFailed(orchDir, ticket, phase, { reason, costUsd, capUsd, nowIso } = {}) {
  const file = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  let signal;
  try {
    signal = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return false; // no/unreadable signal — nothing to preempt
  }
  const updated = {
    ...signal,
    status: "failed",
    failureReason: reason,
    needsHuman: true,
    costCap: { costUsd, capUsd, abortedAt: nowIso ?? new Date().toISOString() },
  };
  try {
    const tmp = `${file}.tmp.${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`);
    renameSync(tmp, file); // atomic — the signal is the source of truth
    return true;
  } catch {
    return false;
  }
}

// checkWorkerCost — the per-worker async action (the body of scheduler Pass 0c,
// extracted so it is unit-testable without the scheduler harness). Fetches the
// session cost, decides, and either logs (shadow) or preempts (enforce:
// terminal-write → reap). All IO is injected. Returns the action taken for
// observability/testing. FAIL-OPEN is inherited from evaluateCostCap (a null cost
// from fetchCost → "none"). Never throws on the action path; a fetch rejection
// propagates to the caller's .catch (which logs + continues).
export async function checkWorkerCost({
  orchDir, ticket, phase, status, sessionId, bgJobId,
  mode, capUsd, promBaseUrl,
  fetchCost = fetchSessionCostUsd,
  markFailed = markPhaseSignalFailed,
  reap,
  log,
}) {
  const sessionCost = await fetchCost(sessionId, { promBaseUrl });
  const decision = evaluateCostCap({ status, sessionCost, capUsd });
  if (decision.action !== "abort") return { action: "none", reason: decision.reason };
  if (mode === "shadow") {
    log?.warn?.(
      { ticket, phase, costUsd: decision.costUsd, capUsd, reason: decision.reason },
      "scheduler: cost-cap WOULD abort (shadow mode, no action) (CTL-1137)",
    );
    return { action: "would-abort", costUsd: decision.costUsd };
  }
  // enforce: the terminal-write frees the slot, then reap the bg supervisor.
  markFailed(orchDir, ticket, phase, { reason: decision.reason, costUsd: decision.costUsd, capUsd });
  if (bgJobId && reap) {
    await reap("phase.cost-cap.reap-requested", { ticket, bgJobId }).catch(() => {});
  }
  log?.warn?.(
    { ticket, phase, costUsd: decision.costUsd, capUsd, reason: decision.reason },
    "scheduler: cost-cap PREEMPTED worker over cap (CTL-1137)",
  );
  return { action: "aborted", costUsd: decision.costUsd };
}
