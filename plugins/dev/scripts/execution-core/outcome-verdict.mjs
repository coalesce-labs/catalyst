// outcome-verdict.mjs — the three-valued outcome verdict behind CTL-1790.
//
// THE PROBLEM THIS EXISTS TO SOLVE. When a phase worker exits cleanly WITHOUT
// declaring an outcome, the pipeline fabricates a terminal `done` from the clean
// process exit (`sdk-success-flip`). Measured live on host mini after CTL-1789
// shipped: of 31 phase advancements, 16 were `declared` and **15 were
// `fabricated`**. The pipeline was inferring success roughly half the time.
//
// Three prior attempts to simply invert that — treat an undeclared exit as
// `failed` — were each blocked by a real defect. All three died on the SAME
// thing, and it is the reason this module exists:
//
//   **A boolean probe conflates "I checked, the work is absent" with "I could
//   not check."** Every probe in work-done-probes.mjs returns `false` for both.
//   Inverting on `false` therefore manufactures terminal failures out of GitHub
//   outages, unresolvable worktrees, absent probes, and circular probes.
//
// So the verdict is THREE-valued, and the whole safety property is one rule:
//
//   **UNKNOWN NEVER WRITES `failed`.** On UNKNOWN the caller reproduces today's
//   behavior byte-for-byte (the flip still writes `done`) and emits telemetry.
//   An inversion may only fire on a probe that is decisive AND non-circular AND
//   on a phase the allowlist admits.
//
// This mirrors the house rule already stated verbatim at recovery.mjs:3027-3028
// — "STRICTLY gated on snap.isFresh — a stale/cold snapshot skips the
// cross-check and suppresses exactly as before."
//
// Zero imports beyond the probe registry, so a bare-Node caller can load it.

import { hasProbe } from "./work-done-probes.mjs";

export const VERDICT = Object.freeze({
  DONE: "done",
  NOT_DONE: "not-done",
  UNKNOWN: "unknown",
});

// Why a verdict came back UNKNOWN. Every one of these is a case where an
// absence is NOT evidence, and the caller must fall back to today's behavior.
export const UNKNOWN_REASONS = Object.freeze({
  NO_PROBE_FOR_PHASE: "no-probe-for-phase", // hasProbe(phase) === false — teardown
  PHASE_EXEMPT: "phase-exempt", // phase not in INVERTIBLE_PHASES
  CIRCULAR_PROBE: "circular-probe", // probe input === write target (monitor-deploy)
  PROBE_INPUT_MISSING: "probe-input-missing", // worktree unresolvable / signal unreadable
  PROBE_TRANSPORT_FAIL: "probe-transport-fail", // gh/git non-zero, parse failure, timeout
  PROBE_THREW: "probe-threw",
});

// INVERTIBLE_PHASES — the ONLY phases the inversion may act on. The post-PR
// phases are deliberately absent, and their absence is a safety property rather
// than an oversight:
//
//   • `teardown` has NO probe at all (verified by executing hasProbe over the ten
//     canonical phases, with the negative control hasProbe("not-a-phase") ===
//     false). It is also the sole gate for ALL THREE Linear-Done writers — the
//     teardown skill's own `linear-transition.sh --transition done`,
//     `terminalDoneOnce` (gated on `signals[TERMINAL_PHASE] === "done"`), and the
//     CTL-1371 reconciler seeded by that same skill. A fail-closed inversion here
//     writes `failed`, teardown never reads `done`, and all three go dark at once:
//     PR merged, ticket never Done, worktree never removed. The escalation sweep
//     would then likely SUPPRESS the alarm, because isTicketTerminalOrMerged
//     returns `{terminal:true, reason:"pr-merged"}` at teardown. A silent,
//     permanent stall behind green health signals — precisely the round-2 blocker.
//
//   • `monitor-deploy`'s probe reads the SAME INODE its writer writes (the
//     CTL-701 dual-use signal file). No replay can exist in which probe-input and
//     write-target are independent, because they are one file. Circular by
//     construction, not merely weak.
//
// Keeping this an ALLOWLIST (rather than a denylist) makes both hazards
// structurally unreachable: a phase added to the pipeline later is exempt until
// somebody deliberately admits it.
export const INVERTIBLE_PHASES = new Set([
  "triage",
  "research",
  "plan",
  "implement",
  "verify",
  "review",
  "pr",
  "monitor-merge",
]);

// Probe classes. `false` is allowed to mean NOT_DONE only for a probe that is
// decisive and non-circular.
export const PROBE_CLASS = Object.freeze({
  LOCAL_DECISIVE: "local-decisive", // reads local artifacts; false means absent
  NETWORK: "network", // reads GitHub; false means absent ONLY on a successful reply
  CIRCULAR: "circular", // probe input is the write target — never decisive
  NO_PROBE: "no-probe",
});

export const PHASE_PROBE_CLASS = Object.freeze({
  triage: PROBE_CLASS.LOCAL_DECISIVE,
  research: PROBE_CLASS.LOCAL_DECISIVE,
  plan: PROBE_CLASS.LOCAL_DECISIVE,
  implement: PROBE_CLASS.LOCAL_DECISIVE,
  verify: PROBE_CLASS.LOCAL_DECISIVE,
  review: PROBE_CLASS.LOCAL_DECISIVE,
  remediate: PROBE_CLASS.LOCAL_DECISIVE,
  pr: PROBE_CLASS.NETWORK,
  "monitor-merge": PROBE_CLASS.NETWORK,
  "monitor-deploy": PROBE_CLASS.CIRCULAR,
  teardown: PROBE_CLASS.NO_PROBE,
});

export function probeClassFor(phase) {
  return PHASE_PROBE_CLASS[phase] ?? PROBE_CLASS.NO_PROBE;
}

function unknown(reason, detail = null) {
  return { verdict: VERDICT.UNKNOWN, reason, detail, invertible: false };
}

// classifyPhase — the cheap, IO-free gate. Answers "may the inversion act on
// this phase at all?" before any probe is spawned, so an exempt phase costs
// nothing and can never reach a probe that would block the daemon's event loop.
export function classifyPhase(phase, { invertible = INVERTIBLE_PHASES } = {}) {
  if (typeof phase !== "string" || phase === "") {
    return unknown(UNKNOWN_REASONS.PHASE_EXEMPT, "phase is not a non-empty string");
  }
  const klass = probeClassFor(phase);
  if (klass === PROBE_CLASS.CIRCULAR) {
    return unknown(UNKNOWN_REASONS.CIRCULAR_PROBE, phase);
  }
  if (!hasProbe(phase)) {
    return unknown(UNKNOWN_REASONS.NO_PROBE_FOR_PHASE, phase);
  }
  if (!invertible.has(phase)) {
    return unknown(UNKNOWN_REASONS.PHASE_EXEMPT, phase);
  }
  return { verdict: null, reason: null, detail: null, invertible: true };
}

// evaluateOutcome — the verdict for one (ticket, phase) whose worker exited
// clean WITHOUT declaring.
//
// `runProbe` is the injected seam: () => boolean. It is invoked ONLY when the
// phase gate admits the phase, so an exempt phase never pays for a probe.
//
//   throws            -> UNKNOWN(probe-threw)        — never a failure
//   non-boolean       -> UNKNOWN(probe-transport-fail) — a probe that cannot say
//   true              -> DONE                        — the flip stands
//   false             -> NOT_DONE                    — the ONLY path to `failed`
//
// A probe that returns a non-boolean is treated as unable to answer rather than
// coerced: `undefined` is falsy, and coercing it would terminally fail work on a
// malformed call — the exact arity-bug shape that produced eleven false
// "not owned" answers elsewhere in this repo (CTL-1801).
export function evaluateOutcome(
  { phase, ticket } = {},
  { runProbe, invertible = INVERTIBLE_PHASES } = {},
) {
  const gate = classifyPhase(phase, { invertible });
  if (!gate.invertible) return { ...gate, phase, ticket };

  if (typeof runProbe !== "function") {
    return { ...unknown(UNKNOWN_REASONS.PROBE_INPUT_MISSING, "no runProbe seam"), phase, ticket };
  }

  let result;
  try {
    result = runProbe();
  } catch (err) {
    return {
      ...unknown(UNKNOWN_REASONS.PROBE_THREW, err?.message ?? String(err)),
      phase,
      ticket,
    };
  }

  if (typeof result !== "boolean") {
    return {
      ...unknown(UNKNOWN_REASONS.PROBE_TRANSPORT_FAIL, `probe returned ${typeof result}`),
      phase,
      ticket,
    };
  }

  return {
    verdict: result ? VERDICT.DONE : VERDICT.NOT_DONE,
    reason: null,
    detail: null,
    invertible: true,
    phase,
    ticket,
  };
}

// shouldWriteFailed — the single predicate a caller acts on. Deliberately narrow:
// ONLY an explicit NOT_DONE, and ONLY in enforce mode. Everything else — UNKNOWN,
// DONE, shadow, off — leaves today's behavior untouched.
//
// Written as a positive test against NOT_DONE rather than `!== DONE`, so a future
// verdict value added to the enum cannot silently become a reason to fail work.
export function shouldWriteFailed(outcome, mode) {
  return mode === "enforce" && outcome?.verdict === VERDICT.NOT_DONE;
}

// describeOutcome — the telemetry payload. Carries the reason on UNKNOWN so a
// shadow window can be read as "how often could we not tell, and why" — which is
// the number the shadow→enforce exit criterion is actually about.
export function describeOutcome(outcome, mode) {
  return {
    phase: outcome?.phase ?? null,
    ticket: outcome?.ticket ?? null,
    verdict: outcome?.verdict ?? VERDICT.UNKNOWN,
    unknown_reason: outcome?.reason ?? null,
    detail: outcome?.detail ?? null,
    probe_class: probeClassFor(outcome?.phase),
    mode: mode ?? "off",
    would_write_failed: shouldWriteFailed(outcome, "enforce"),
  };
}
