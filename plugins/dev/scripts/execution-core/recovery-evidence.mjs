// recovery-evidence.mjs — CTL-1241: pure, injectable helper for building the
// recovery evidence items the scheduler passes to reasoningRecoveryPass.
//
// Extracted from the inline .map() in scheduler.mjs so the belief-attachment
// logic is unit-testable without spinning a full tick.

// buildRecoveryItems — maps filtered signals to recovery item objects.
//
// Parameters:
//   signals   — array of signal objects from readWorkerSignals (already filtered
//               to stalled/failed/needs-human/unknown). Each has .ticket,
//               .phase, .raw (the raw JSON of the signal file or null).
//   opts      — {
//     db        : the current-tick beliefs.db handle (or null/undefined when
//                 beliefs are disabled — believers-disabled path is a no-op)
//     getBeliefs: (db, ticket) => belief | null  — injectable for tests;
//                 defaults to the live getEscalateHumanBelief from collector.mjs
//   }
//
// Returns an array of { ticket, phase, bgJobId, evidence } objects suitable
// for reasoningRecoveryPass.
export function buildRecoveryItems(signals, { db = null, getBeliefs = null } = {}) {
  return signals.map((sig) => {
    const raw = sig.raw ?? {};
    const bgJobId = raw.bg_job_id ?? null;
    // CTL-1299: expose the raw signal under `.signal` as well as the existing
    // top-level spread. classifyTicket / checkBoundedLlmFixes read
    // `evidence.signal.{failureReason,stalledReason}` (recovery-reasoning.mjs:416,
    // 528,534,590) — without this `.signal` is always undefined, the bounded-LLM
    // FIX rung is structurally dead, and every stalled ticket collapses to
    // escalate-only. The top-level spread is retained so the deterministic-reason
    // path (checkDeterministicErrors reads top-level evidence.failureReason) and
    // the existing linearTerminal/beliefState readers keep working. `signal` is
    // null (not {}) when there is no signal file, so an absent signal stays falsy
    // for the classifier's early-return guard.
    let evidence = { ...raw, signal: sig.raw ?? null };
    if (typeof getBeliefs === "function") {
      const beliefState = getBeliefs(db, sig.ticket);
      if (beliefState != null) {
        evidence = { ...evidence, beliefState };
      }
    }
    return {
      ticket: sig.ticket,
      phase: sig.phase,
      bgJobId,
      evidence,
    };
  });
}
