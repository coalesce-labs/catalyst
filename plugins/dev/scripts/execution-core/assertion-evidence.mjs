// assertion-evidence.mjs — CTL-1789. Who asserted that a phase finished?
//
// A phase signal reaching a terminal SUCCESS status (`done`, or `skipped` on
// monitor-deploy) is the ONLY input the scheduler's advancement FSM keys off.
// Three structurally different producers can write that terminal, and until this
// module existed they were byte-indistinguishable on disk:
//
//   A. the phase agent ran its own `phase-agent-emit-complete` wrapper
//      → the agent DECLARED it finished.
//   B. `flipSignalDoneOnSuccess` flipped an in-flight signal to `done` because
//      the SDK/codex query exited cleanly — WITHOUT the agent ever declaring
//      anything (sdk-run-phase-agent.mjs). RETIRED as a producer by CTL-1790:
//      that clean-exit-without-declaration case now writes a terminal FAILURE
//      (`ended-without-declaration`), not a fabricated success. The id stays
//      registered because signals written before CTL-1790 still carry it on disk
//      and the classifier must keep answering `fabricated` for them.
//   C. a recovery/revive path inferred completion from a work-done probe and
//      invoked the same wrapper on the dead worker's behalf.
//
// B and C are FABRICATED terminals: infrastructure asserting on the agent's
// behalf. They are legitimate (they are what keeps a pipeline moving past a
// crashed worker) but they are NOT the agent's own claim, and an audit that
// cannot tell them apart cannot answer "how much of this pipeline actually ran".
//
// `assertedBy` is the one-string marker every terminal-success writer now stamps
// onto the signal file. This module owns the vocabulary and the classifier.
//
// ZERO-IMPORT LEAF, deliberately (same discipline as lib/secret-contract.mjs):
// no node builtins, no sibling modules. `catalyst doctor`'s bare-node runtime,
// the bash-adjacent test harness, and the scheduler all consume it without
// dragging in config.mjs's bun:sqlite graph.
//
// SEMANTIC WARNING for downstream consumers: `assertedBy` records WHO WROTE THE
// TERMINAL, not whether the work was really done. A phase agent that runs its
// wrapper without doing anything useful still classifies as `declared`. The axis
// is declared-by-agent vs fabricated-by-infrastructure — nothing more.

// ASSERTED_BY — the registered writer ids. One per terminal-success writer.
export const ASSERTED_BY = Object.freeze({
  // A — the phase skill invoked the wrapper itself. The wrapper's DEFAULT, so a
  // caller that passes no --asserted-by is recorded as the agent's own claim.
  PHASE_AGENT: "phase-agent-emit-complete",
  // C — execution-core recovery reclaim (recovery.mjs defaultEmitComplete):
  // the worker died, a work-done probe said the artifact landed, so the reclaim
  // ran the wrapper on its behalf.
  RECOVERY_RECLAIM: "recovery-reclaim",
  // C (legacy wave orchestration) — orchestrate-revive's synthetic complete.
  REVIVE_SYNTHESIZED: "revive-synthesized",
  // B — sdk-run-phase-agent.mjs flipSignalDoneOnSuccess. HISTORICAL as of
  // CTL-1790: no live writer stamps this any more (that function now writes a
  // terminal failure, stamped SDK_BACKSTOP). Retained so the classifier still
  // resolves `fabricated` — not `absent`/`unknown-writer` — for the pre-CTL-1790
  // signals that carry it, and so the audit's historical series stays readable.
  SDK_SUCCESS_FLIP: "sdk-success-flip",
  // B (non-success) — sdk-run-phase-agent.mjs defaultWriteSignalTerminal, the
  // stalled/failed/turn-cap-exhausted backstop. Never advance-eligible, stamped
  // so the marker's coverage of the SDK writer pair is not half-missing.
  SDK_BACKSTOP: "sdk-backstop",
});

// EVIDENCE — the three-valued advance-evidence contract. Exactly three values,
// forever; diagnosability rides `evidenceReason`, never a fourth value.
export const EVIDENCE = Object.freeze({
  DECLARED: "declared",
  FABRICATED: "fabricated",
  ABSENT: "absent",
});

export const EVIDENCE_VALUES = Object.freeze([
  EVIDENCE.DECLARED,
  EVIDENCE.FABRICATED,
  EVIDENCE.ABSENT,
]);

// EVIDENCE_REASONS — why an `absent` is absent. Null for declared/fabricated.
export const EVIDENCE_REASONS = Object.freeze([
  "no-predecessor", // the FSM advanced off nothing readable (new-work entry, reset cycle)
  "unreadable-signal", // the predecessor signal file was missing or unparseable
  "no-marker", // signal present, but written before this marker shipped (or by an unstamped writer)
  "unknown-writer", // signal carries an assertedBy this contract does not recognize
]);

const DECLARED_WRITERS = new Set([ASSERTED_BY.PHASE_AGENT]);

const FABRICATED_WRITERS = new Set([
  ASSERTED_BY.RECOVERY_RECLAIM,
  ASSERTED_BY.REVIVE_SYNTHESIZED,
  ASSERTED_BY.SDK_SUCCESS_FLIP,
  ASSERTED_BY.SDK_BACKSTOP,
]);

// classifySignal — the single implementation. Returns the full triple so the
// two exported entry points never duplicate the branching.
//
// FAIL DIRECTION: every unrecognized shape resolves to `absent`, never to
// `declared`. An audit that over-reports agent assertions is worse than one that
// under-reports them — `absent` says "I cannot prove who asserted this", which
// is exactly true for a legacy signal, an unreadable file, or a writer that has
// not been folded onto the contract yet.
function classifySignal(sig) {
  if (sig === null || sig === undefined || typeof sig !== "object" || Array.isArray(sig)) {
    return { evidence: EVIDENCE.ABSENT, evidenceReason: "unreadable-signal", assertedBy: null };
  }
  const a = sig.assertedBy;
  if (typeof a !== "string" || a === "") {
    return { evidence: EVIDENCE.ABSENT, evidenceReason: "no-marker", assertedBy: null };
  }
  if (DECLARED_WRITERS.has(a)) {
    return { evidence: EVIDENCE.DECLARED, evidenceReason: null, assertedBy: a };
  }
  if (FABRICATED_WRITERS.has(a)) {
    return { evidence: EVIDENCE.FABRICATED, evidenceReason: null, assertedBy: a };
  }
  return { evidence: EVIDENCE.ABSENT, evidenceReason: "unknown-writer", assertedBy: a };
}

// classifyAdvanceEvidence — pure. Given the PARSED predecessor phase signal (or
// null/undefined when there is none), return one of EVIDENCE_VALUES.
export function classifyAdvanceEvidence(sig) {
  return classifySignal(sig).evidence;
}

// explainAdvanceEvidence — pure. Same classification plus the diagnostic
// `evidenceReason` and the raw `assertedBy` string.
//
// `predecessorPhase` is the phase whose signal `sig` is. Passing null/undefined
// (there was no predecessor to read) short-circuits to the `no-predecessor`
// reason, which is NOT derivable from a signal — it is a caller-side fact.
export function explainAdvanceEvidence(sig, { predecessorPhase = null } = {}) {
  if (typeof predecessorPhase !== "string" || predecessorPhase === "") {
    return { evidence: EVIDENCE.ABSENT, evidenceReason: "no-predecessor", assertedBy: null };
  }
  return classifySignal(sig);
}
