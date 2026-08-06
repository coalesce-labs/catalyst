// triage-transition-event.mjs — canonical phase.triage.linear-transition event (CTL-704).
//
// Emits an INFO observability event when the daemon auto-transitions a ticket
// from Todo→Triage on first dispatch. Separate from recovery.mjs's WARN-coded
// audit events (reclaim/revive/escalated) — different family, different severity,
// different action verb — so they stay independent modules.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";
import { UNKNOWN_TICKET_TYPE } from "./ticket-type.mjs"; // CTL-1023: work-type dimension

// defaultAppend — writes a JSONL line to the canonical event log.
function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

// buildTriageTransitionEvent — returns a canonical JSONL line (string + "\n")
// for the phase.triage.linear-transition.<TICKET> INFO event.
export function buildTriageTransitionEvent({
  ticket,
  orchId,
  from_state = null,
  to_state = null,
  verified = false,
  applied = false,
  reason = null,
  // CTL-1023: this IS the triage phase — classification is still being decided,
  // so the work-type dimension is "unknown" here by design. Param kept for shape
  // parity with the other emitters; callers normally omit it.
  ticketType = UNKNOWN_TICKET_TYPE,
} = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: "INFO",
      severityNumber: 9,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes: {
        "event.name": `phase.triage.linear-transition.${ticket}`,
        // CTL-1488: this name is unconditionally coordination (phase.triage. prefix),
        // so the coordination-publish tailer's fail-closed filter would drop it
        // unstamped. Stamp it like the other coordination producers (worker.transition).
        "event.stream_class": "coordination",
        "event.entity": "phase",
        "event.action": "linear-transition",
        "event.label": ticket,
        "catalyst.orchestration": orchId ?? ticket,
        "linear.issue.identifier": ticket,
        "catalyst.ticket.type": ticketType ?? UNKNOWN_TICKET_TYPE, // CTL-1023
      },
      body: {
        payload: { phase: "triage", ticket, from_state, to_state, verified, applied, reason },
      },
    }) + "\n"
  );
}

// appendTriageTransitionEvent — appends the event to the canonical event log.
// The `append` seam defaults to the real file write; inject a recording function
// in tests. Returns true on success, false on any error (log.error + swallow).
export function appendTriageTransitionEvent({ append = defaultAppend, ...fields } = {}) {
  try {
    const line = buildTriageTransitionEvent(fields);
    append(line);
    return true;
  } catch (err) {
    log.error({ err: err.message }, "triage-transition-event: append failed");
    return false;
  }
}
