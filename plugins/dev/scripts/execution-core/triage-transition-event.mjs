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
import { hostName, hostId } from "./lib/host-identity.mjs";

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
      resource: {
        "service.name": "catalyst.execution-core",
        "service.namespace": "catalyst",
        "host.name": hostName(),
        "host.id": hostId(),
      },
      attributes: {
        "event.name": `phase.triage.linear-transition.${ticket}`,
        "event.entity": "phase",
        "event.action": "linear-transition",
        "event.label": ticket,
        "catalyst.orchestration": orchId ?? ticket,
        "linear.issue.identifier": ticket,
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
