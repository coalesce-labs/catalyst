// event-stream-class.mjs — single source of truth for the coordination/telemetry
// stream split (CTL-1488 Phase 1, ADR-022/ADR-023).
//
// Coordination = shared cross-host events that (in `enforce`) are published to
// the catalyst-cloud hub and materialized into every host's `coordination.jsonl`
// mirror. Telemetry = everything else (the Loki-only firehose: host metrics,
// session heartbeats, broker-internal namespaces, and any not-yet-allowlisted
// name).
//
// FAIL-CLOSED by design: any event name not explicitly matched by the allowlist
// below classifies as telemetry, so a brand-new event name never leaks
// cross-host until someone deliberately adds it here. This is the second
// consumer of the frozen `KNOWN_PHASES` allowlist from broker/namespace-contract
// — reusing it keeps the phase list from silently drifting between the two.

import { KNOWN_PHASES, INTENTIONAL_PHASE_SLOT_EXCEPTIONS } from "../broker/namespace-contract.mjs";

// Exact-match coordination names. Empty today — every coordination event is
// matched by a prefix below — but kept as the escape hatch for a future
// single-name event that has no shared prefix.
export const COORDINATION_EXACT = Object.freeze([]);

// Prefix allowlist. A name that startsWith any of these is coordination.
export const COORDINATION_PREFIXES = Object.freeze([
  // Every canonical pipeline phase: `phase.<known>.`
  ...KNOWN_PHASES.map((p) => `phase.${p}.`),
  // The recovery.mjs phase-slot exceptions (dispatch/scheduler/advance) — these
  // emit `phase.<slot>.*.<ticket>` observability/failure events that are still
  // cross-host coordination signal.
  ...INTENTIONAL_PHASE_SLOT_EXCEPTIONS.map((slot) => `phase.${slot}.`),
  // Worker two-axis transitions (worker-transition-event.mjs) — hardcoded name
  // `worker.transition`; no trailing dot so both the bare name and
  // `worker.transition.<ticket>` variants match.
  "worker.transition",
  // Reserved for later epic phases (not emitted yet) — allowlisted now so the
  // classifier needs no second edit when Phases 4/5 land.
  "escalation.",
  "resume.",
  // System-of-record mirror events forwarded into the log.
  "linear.",
  "github.",
  // Agent coordination messages.
  "comms.",
]);

/**
 * Classify an event name into its stream class.
 * @param {string|null|undefined} eventName
 * @returns {"coordination"|"telemetry"}
 */
export function classifyEventStream(eventName) {
  const name = eventName ?? "";
  if (COORDINATION_EXACT.includes(name)) return "coordination";
  if (COORDINATION_PREFIXES.some((p) => name.startsWith(p))) return "coordination";
  return "telemetry";
}
