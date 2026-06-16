// namespace-contract.mjs — single source of truth for the lifecycle-event
// namespace contract (CTL-1142).
//
// INVARIANT: the broker owns four protected event-name spaces. Only
// `service.name = "catalyst.broker"` may emit in them; producers in other
// services (exec-core, orch-monitor) must never collide with these spaces.
//
//   1. filter.*           — broker interest-management events. Re-ingesting them
//                           would create filter-wake feedback loops.
//   2. broker.daemon.*    — broker operational heartbeats / startup / shutdown.
//   3. session.heartbeat  — exact match; special-cased liveness ping (CTL-401).
//   4. phase.<name>.<complete|failed|turn-cap-exhausted|skipped>.<ticket>
//                         — routing namespace matched by PHASE_EVENT_PATTERN;
//                           only KNOWN_PHASES (+ INTENTIONAL_PHASE_SLOT_EXCEPTIONS)
//                           may occupy the <name> slot.
//
// Enforcement surfaces:
//   - plugins/dev/scripts/broker/router.mjs imports PHASE_EVENT_PATTERN,
//     FORBIDDEN_PREFIXES, and PROTECTED_EXACT_NAMES from here (runtime).
//   - plugins/dev/scripts/broker/namespace-parity.test.mjs (exec-core producers).
//   - plugins/dev/scripts/orch-monitor/__tests__/namespace-parity.test.ts
//     (orch-monitor producers).
//
// See docs/architecture.md §"Lifecycle-event namespace contract" for prose.

// Protected-prefix spaces. Any name that starts with one of these strings is
// reserved for broker-internal use (shouldSkipEvent guard in router.mjs).
export const FORBIDDEN_PREFIXES = Object.freeze(["filter.", "broker.daemon"]);

// Protected exact-match names.
export const PROTECTED_EXACT_NAMES = Object.freeze(["session.heartbeat"]);

// The canonical 10-phase pipeline, in pipeline order.
// CLAUDE.md §Orchestration and the phase-agent-dispatch scripts are authoritative
// for the pipeline definition; this constant is the single machine-readable home.
export const KNOWN_PHASES = Object.freeze([
  "triage",
  "research",
  "plan",
  "implement",
  "verify",
  "review",
  "pr",
  "monitor-merge",
  "monitor-deploy",
  "teardown",
]);

// Documented exceptions: phase-slot strings that match PHASE_EVENT_PATTERN but
// are NOT in KNOWN_PHASES. Each exception MUST be listed here with its rationale.
//
//   "dispatch" — recovery.mjs:805 emits `phase.dispatch.failed.<ticket>` to mark
//     a dispatch-level failure before a real phase worker starts. The real phase
//     rides payload.target_phase. No broker phase_lifecycle interest lists
//     "dispatch" as a phase name, so it is harmless; but it must be an explicit,
//     auditable entry rather than a silent tolerance.
export const INTENTIONAL_PHASE_SLOT_EXCEPTIONS = Object.freeze(["dispatch"]);

// CTL-484: turn-cap-exhausted is routed alongside complete/failed so the
// orchestrator can dispatch a continuation worker (separate budget from the
// error-revive path) without an event-name namespace collision.
// CTL-512: skipped is the monitor-deploy terminal-no-deploy status. Routed
// the same as complete (phase-advance is a no-op for monitor-deploy) so the
// scheduler frees the wave slot.
export const PHASE_EVENT_PATTERN =
  /^phase\.([^.]+)\.(complete|failed|turn-cap-exhausted|skipped)\.([A-Za-z][A-Za-z0-9_]*-\d+)$/;

// isBrokerProtectedName — true if `name` falls in any broker-protected space.
// Callers: shouldSkipEvent (router.mjs), parity tests.
export function isBrokerProtectedName(name) {
  return (
    FORBIDDEN_PREFIXES.some((p) => name.startsWith(p)) ||
    PROTECTED_EXACT_NAMES.includes(name)
  );
}

// phaseSlotOf — returns the <name> capture group if `name` matches
// PHASE_EVENT_PATTERN, otherwise null.
export function phaseSlotOf(name) {
  const m = PHASE_EVENT_PATTERN.exec(name);
  return m ? m[1] : null;
}

// isAllowedPhaseSlot — true if `slot` is a known pipeline phase or a
// documented exception. Use after phaseSlotOf returns non-null.
export function isAllowedPhaseSlot(slot) {
  return KNOWN_PHASES.includes(slot) || INTENTIONAL_PHASE_SLOT_EXCEPTIONS.includes(slot);
}
