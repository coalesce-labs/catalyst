// linear-state-write-event.mjs — canonical linear.state.write audit event (CTL-757).
//
// Emits an INFO observability event whenever the execution-core daemon writes a
// Linear workflow STATE (status) for a ticket. The keystone of JOB2 PR1: it makes
// every daemon-initiated Linear state-write observable in the unified event log,
// distinct from the inbound `state_changed` webhook echoes (channel "webhook").
//
// Cloned from triage-transition-event.mjs (CTL-704) — same OTLP envelope, same
// injectable append seam, same swallow-on-error contract. Kept a separate module
// because it is a DIFFERENT event family: triage's auto Todo→Triage transition
// keeps its own phase.triage.linear-transition.<T> event (CTL-704); this one
// covers the FOUR scheduler write sites (scheduler-advance, preemption-resume,
// terminal-sweep, reconcile-backstop — CTL-758). (`parked-redispatch` is not a
// distinct source tag — it reuses the advance / preemption-resume write sites.)
//
// CALLER-EMITS: the helper is invoked from each scheduler write site (where the
// source/phase/reason are known), NOT from inside runTransition — emitting inside
// runTransition would double-audit the triage path.
//
// channel="execution-core" (NOT "webhook"): the jq separator the broker/wait-for
// predicates use to tell inbound state_changed echoes apart from daemon writes.
// actor="catalyst.execution-core": the human-vs-daemon discriminator the inbound
// webhook echo lacks.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";

// defaultAppend — writes a JSONL line to the canonical event log.
function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

// buildLinearStateWriteEvent — returns a canonical JSONL line (string + "\n")
// for the linear.state.write.<TICKET> INFO event.
export function buildLinearStateWriteEvent({
  ticket,
  orchId = null,
  from_state = null,
  to_state = null,
  transition_key = null,
  phase = null,
  source = null,
  reason = null,
  applied = false,
  verified = false,
  actor = "catalyst.execution-core",
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
      // channel="execution-core" — NOT "webhook"; the jq separator that tells a
      // daemon-initiated state-write apart from an inbound state_changed echo.
      channel: "execution-core",
      resource: {
        "service.name": "catalyst.execution-core",
        "service.namespace": "catalyst",
      },
      attributes: {
        "event.name": `linear.state.write.${ticket}`,
        "event.entity": "linear",
        "event.action": "state-write",
        "event.label": ticket,
        "event.channel": "execution-core",
        "catalyst.orchestration": orchId ?? ticket,
        "linear.issue.identifier": ticket,
      },
      body: {
        payload: {
          ticket,
          actor,
          source,
          phase,
          transition_key,
          from_state,
          to_state,
          applied,
          verified,
          reason,
        },
      },
    }) + "\n"
  );
}

// appendLinearStateWriteEvent — appends the event to the canonical event log.
// The `append` seam defaults to the real file write; inject a recording function
// in tests. Returns true on success, false on any error (log.error + swallow).
export function appendLinearStateWriteEvent({ append = defaultAppend, ...fields } = {}) {
  try {
    const line = buildLinearStateWriteEvent(fields);
    append(line);
    return true;
  } catch (err) {
    log.error({ err: err.message }, "linear-state-write-event: append failed");
    return false;
  }
}
