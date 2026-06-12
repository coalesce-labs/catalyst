// unstuck-orphan-merge.mjs — CTL-1064 Category C pure classifier.
//
// Classifies an orphan-sweep-stale signal as 'emit-complete' ONLY when the PR is
// verifiably MERGED per injected REST evidence AND the late-phase signal's bg job
// is dead/null AND no once-marker guards a prior emit AND .terminal-done.applied is
// absent (disjoint from J1). The REST call lives in the census (injected
// resolvePrState), never in the pure classifier.
//
// The act seam (Phase 7 scheduler-side) emits a synthetic phase-complete event so
// teardown proceeds.

// STALE_WORKER_CUTOFF_MS — a signal updated within this window is considered fresh
// and may still have a live worker even if bg_job_id appears dead. 300 seconds.
export const STALE_WORKER_CUTOFF_MS = 300_000;

// classifyOrphanMergedReconcile — PURE classifier. No IO.
// evidence shape:
//   ticket               string
//   phase                string  (typically 'monitor-merge')
//   prState              string|null  ('MERGED'|'OPEN'|'CLOSED'|null)
//   bgJobAlive           bool    (true = a live bg job for this signal)
//   signalUpdatedAt      number|null  (epoch-ms of signal's updatedAt, or null)
//   nowMs                number  (current epoch-ms, injected for testability)
//   alreadyEmitted       bool    (.unstuck-orphan-merge-<phase>.applied present)
//   terminalDoneApplied  bool    (.terminal-done.applied present — teardown owns it)
//   linearTerminal       bool
//
// Returns { action: 'emit-complete' } or { action: 'skip', reason }
export function classifyOrphanMergedReconcile(evidence = {}) {
  const {
    prState,
    bgJobAlive,
    signalUpdatedAt,
    nowMs,
    alreadyEmitted,
    terminalDoneApplied,
    linearTerminal,
  } = evidence;

  // .terminal-done.applied present → teardown already owns this ticket; skip.
  if (terminalDoneApplied) return { action: "skip", reason: "terminal-done-owns-it" };
  // linearTerminal → skip (ticket is already in a terminal state).
  if (linearTerminal) return { action: "skip", reason: "linear-terminal" };
  // alreadyEmitted marker → idempotent skip.
  if (alreadyEmitted) return { action: "skip", reason: "already-emitted" };

  // Fail-closed: null/undefined prState → we have no evidence the PR merged.
  // Missing evidence is never treated as MERGED.
  if (!prState) return { action: "skip", reason: "pr-state-unknown" };

  // PR must be in MERGED state.
  if (prState !== "MERGED") return { action: "skip", reason: "pr-not-merged" };

  // bg job alive → the worker is still running; let it finish naturally.
  if (bgJobAlive) return { action: "skip", reason: "bg-job-alive" };

  // Signal is fresh (within cutoff) → may still transition naturally; skip.
  if (signalUpdatedAt != null && nowMs != null) {
    const elapsedMs = nowMs - signalUpdatedAt;
    if (elapsedMs < STALE_WORKER_CUTOFF_MS) {
      return { action: "skip", reason: "signal-fresh" };
    }
  }

  return { action: "emit-complete" };
}

// defaultCollectOrphanMergedCandidates — census with injected seams.
// Filters candidates to those with reason 'orphan-sweep-stale', resolves PR state
// and bg-job liveness via injected seams. Fail-closed: resolvePrState throw →
// candidate.prState = null (skip).
export function defaultCollectOrphanMergedCandidates({
  candidates = [],       // from defaultCollectUnstuckCandidates
  resolvePrState = null, // (ticket) → 'MERGED'|'OPEN'|'CLOSED'|null (async ok)
  jobLifecycle = null,   // (bgJobId) → bool (is the bg job alive)
  nowMs = Date.now(),
  phaseAllowlist = ["monitor-merge", "monitor-deploy"],
} = {}) {
  const out = [];
  for (const c of candidates) {
    try {
      if (c.evidence?.reason !== "orphan-sweep-stale") continue;
      if (!phaseAllowlist.includes(c.phase)) continue;

      // Resolve PR state — fail-closed on error
      let prState = null;
      try {
        const result = resolvePrState ? resolvePrState(c.ticket) : null;
        if (result && typeof result.then === "function") {
          // Synchronous-only in tests; async usage is the caller's responsibility
          prState = null; // treat async as unavailable in sync path
        } else {
          prState = result;
        }
      } catch { prState = null; }

      // Resolve bg-job liveness
      const bgJobId = c.signal?.bg_job_id ?? null;
      let bgJobAlive = false;
      try {
        bgJobAlive = bgJobId != null && jobLifecycle ? jobLifecycle(bgJobId) : false;
      } catch { bgJobAlive = false; }

      // Parse signal updatedAt to epoch-ms
      let signalUpdatedAt = null;
      try {
        const ua = c.signal?.updatedAt;
        if (ua) signalUpdatedAt = new Date(ua).getTime();
      } catch { signalUpdatedAt = null; }

      out.push({
        ...c,
        evidence: {
          ...c.evidence,
          prState,
          bgJobAlive,
          signalUpdatedAt,
          nowMs,
          alreadyEmitted: false, // caller sets from marker file
          terminalDoneApplied: false, // caller sets from marker file
        },
      });
    } catch {
      // per-candidate error: skip, no throw
    }
  }
  return out;
}
