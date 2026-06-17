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
    let evidence = { ...raw };
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
