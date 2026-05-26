// phase-fsm.mjs — pure transition-table FSM for the 9-phase per-worker pipeline (CTL-531).
//
// CTL-531: collapses the scattered phase-advance control flow — phase_next() in
// orchestrate-phase-advance, the revive decision tree in orchestrate-revive, and the
// stall escalation in orchestrate-healthcheck — into a single pure, zero-dependency
// transition table (NEXT_PHASE) plus a transition(state, event) function. Imports nothing.

// ─── State vocabulary ───
export const PHASES = [
  "triage",
  "research",
  "plan",
  "implement",
  "verify",
  "review",
  "pr",
  "monitor-merge",
  "monitor-deploy",
];
export const PARK_STATE = "needs-input";
export const TERMINAL_SUCCESS = "done";
export const TERMINAL_FAILURE = "stalled";
export const TERMINAL_STATES = new Set([TERMINAL_SUCCESS, TERMINAL_FAILURE]);

// ─── Event vocabulary ───
export const EVENT_TYPES = new Set(["complete", "failed", "turn-cap-exhausted", "park", "resume"]);

// ─── Revive budget (CTL-531: revive once per phase; 2nd failure escalates) ───
export const REVIVE_BUDGET = 1;

// ─── Transition table — the happy path (replaces phase_next()) ───
export const NEXT_PHASE = {
  triage: "research",
  research: "plan",
  plan: "implement",
  implement: "verify",
  verify: "review",
  review: "pr",
  pr: "monitor-merge",
  "monitor-merge": "monitor-deploy",
  "monitor-deploy": TERMINAL_SUCCESS,
};

// ─── Phase → Linear stateMap key — the 9→5 collapse (CTL-558) ───
// Each pipeline phase maps to a `.catalyst.linear.stateMap` key; linear-transition.sh
// resolves that key to a Linear workflow-state name (config stateMap > default_state_for).
// The keys are the legacy stateMap vocabulary — an execution-core repo's stateMap
// re-targets the SAME keys onto the 5 collapsed states (Research/Plan/Implement/
// Validate/PR), see setup-execution-core-states.sh:build_execution_core_state_map.
//   • `triage` → null: the human owns the Triage state; the daemon only tags `triaged`.
//   • verify + review collapse onto `verifying`/`reviewing` (both → Validate).
//   • pr + monitor-merge + monitor-deploy collapse onto `inReview` (→ PR) while in flight;
//     terminal Done is written separately on monitor-deploy completion (TERMINAL_LINEAR_KEY).
export const PHASE_LINEAR_KEY = {
  triage: null,
  research: "research",
  plan: "planning",
  implement: "inProgress",
  verify: "verifying",
  review: "reviewing",
  pr: "inReview",
  "monitor-merge": "inReview",
  "monitor-deploy": "inReview",
};

// The stateMap key for the terminal success state — written when monitor-deploy completes.
export const TERMINAL_LINEAR_KEY = "done";

export class PhaseFsmError extends Error {
  constructor(message) {
    super(message);
    this.name = "PhaseFsmError";
  }
}

// linearKeyForPhase — the stateMap key for a pipeline phase, or null for `triage`.
// Throws PhaseFsmError on an unknown phase so a typo fails loudly, never silently no-ops.
export function linearKeyForPhase(phase) {
  if (!(phase in PHASE_LINEAR_KEY)) {
    throw new PhaseFsmError(`no Linear key for unknown phase '${phase}'`);
  }
  return PHASE_LINEAR_KEY[phase];
}

// phaseIndex — 0-based position of a pipeline phase in the canonical PHASES
// sequence. The missing comparator (CTL-606): lets consumers decide whether a
// phase precedes another without re-deriving the order. Throws PhaseFsmError on
// an unknown phase so a typo fails loudly rather than silently returning -1
// (which would misorder before `triage`).
export function phaseIndex(phase) {
  const idx = PHASES.indexOf(phase);
  if (idx === -1) {
    throw new PhaseFsmError(`unknown phase '${phase}'`);
  }
  return idx;
}

// ─── Validation helpers (private) ───
function assertState(state) {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new PhaseFsmError(`state must be a plain object, got ${describe(state)}`);
  }
  const known =
    PHASES.includes(state.phase) || state.phase === PARK_STATE || TERMINAL_STATES.has(state.phase);
  if (!known) {
    throw new PhaseFsmError(`unknown phase '${state.phase}'`);
  }
  if (!Number.isInteger(state.reviveCount) || state.reviveCount < 0) {
    throw new PhaseFsmError(`reviveCount must be a non-negative integer`);
  }
  if (state.phase === PARK_STATE && !PHASES.includes(state.parkedFrom)) {
    throw new PhaseFsmError(`needs-input state requires parkedFrom to be a pipeline phase`);
  }
}

function assertEvent(event) {
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new PhaseFsmError(`event must be a plain object, got ${describe(event)}`);
  }
  if (!EVENT_TYPES.has(event.type)) {
    throw new PhaseFsmError(`unknown event type '${event.type}'`);
  }
}

function describe(v) {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

// ─── Public API ───
export function initialState() {
  return { phase: PHASES[0], reviveCount: 0, parkedFrom: null };
}

export function isTerminal(state) {
  assertState(state);
  return TERMINAL_STATES.has(state.phase);
}

export function transition(state, event) {
  assertState(state);
  assertEvent(event);

  if (TERMINAL_STATES.has(state.phase)) {
    throw new PhaseFsmError(
      `'${state.phase}' is terminal — no transition for event '${event.type}'`
    );
  }

  // ─── Park state: only 'resume' is legal ───
  if (state.phase === PARK_STATE) {
    if (event.type === "resume") {
      return { phase: state.parkedFrom, reviveCount: state.reviveCount, parkedFrom: null };
    }
    throw new PhaseFsmError(`needs-input only accepts 'resume', got '${event.type}'`);
  }

  // ─── Pipeline phase ───
  switch (event.type) {
    case "complete":
      return { phase: NEXT_PHASE[state.phase], reviveCount: 0, parkedFrom: null };

    case "failed":
      // Revive once per phase; the 2nd failure escalates to the terminal failure sink.
      return state.reviveCount < REVIVE_BUDGET
        ? { phase: state.phase, reviveCount: state.reviveCount + 1, parkedFrom: null }
        : { phase: TERMINAL_FAILURE, reviveCount: state.reviveCount, parkedFrom: null };

    case "turn-cap-exhausted":
      // Continuation self-loop — same phase, revive budget untouched.
      return { phase: state.phase, reviveCount: state.reviveCount, parkedFrom: null };

    case "park":
      return { phase: PARK_STATE, reviveCount: state.reviveCount, parkedFrom: state.phase };

    case "resume":
      throw new PhaseFsmError(`'resume' is only valid from '${PARK_STATE}'`);

    default:
      throw new PhaseFsmError(
        `no transition for event '${event.type}' from phase '${state.phase}'`
      );
  }
}
