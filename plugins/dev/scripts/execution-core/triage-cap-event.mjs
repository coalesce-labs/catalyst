// triage-cap-event.mjs — durable triage re-dispatch-cap events (CTL-2111).
//
// Two budget-independent events that surface the triage-cap lifecycle in the
// LOCAL event log, bypassing the per-ticket Linear write budget entirely (the
// budget exhaustion was the root of the CTC-750 invisibility):
//
//   - triage.cap.rearmed.<TICKET>        (INFO) — a human re-queue reset the
//                                         host-local counter + fence, so the next
//                                         sweep re-dispatches triage.
//   - escalation.triage-cap-parked.<T>   (WARN) — the ticket tripped its cap and
//                                         was parked, emitted unconditionally at
//                                         the park site regardless of whether the
//                                         Linear `needs-human` label write landed.
//
// Modeled on triage-transition-event.mjs. Neither name is a
// phase.*/filter.*/broker.daemon.* name, so no coordination stream_class stamp is
// required (CTL-1488) — they route through shouldSkipEvent normally.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

// defaultAppend — writes a JSONL line to the canonical event log.
function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

// buildTriageCapRearmedEvent — canonical JSONL line for the INFO
// triage.cap.rearmed.<TICKET> event (host-local counter + fence reset on a human
// re-queue newer than cappedAt).
export function buildTriageCapRearmedEvent({
  ticket,
  orchId,
  eventTs = null,
  cappedAt = null,
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
        "event.name": `triage.cap.rearmed.${ticket}`,
        "event.entity": "triage",
        "event.action": "cap-rearmed",
        "event.label": ticket,
        "catalyst.orchestration": orchId ?? ticket,
        "linear.issue.identifier": ticket,
      },
      body: {
        payload: { ticket, eventTs, cappedAt },
      },
    }) + "\n"
  );
}

// appendTriageCapRearmedEvent — append the re-arm event to the canonical log.
// The `append` seam defaults to the real file write; inject a recorder in tests.
// Returns true on success, false on any error (log.error + swallow) — this is an
// audit tap and must never be load-bearing.
export function appendTriageCapRearmedEvent({ append = defaultAppend, ...fields } = {}) {
  try {
    const line = buildTriageCapRearmedEvent(fields);
    append(line);
    return true;
  } catch (err) {
    log.error({ err: err.message }, "triage-cap-event: rearmed append failed");
    return false;
  }
}

// buildTriageCapParkedEvent — canonical JSONL line for the WARN
// escalation.triage-cap-parked.<TICKET> event (the ticket tripped its cap and
// was parked). Budget-independent by construction: emitted at the park site
// whether or not the Linear needs-human label write succeeded.
export function buildTriageCapParkedEvent({
  ticket,
  orchId,
  cap = null,
  count = null,
} = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: "WARN",
      severityNumber: 13,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes: {
        "event.name": `escalation.triage-cap-parked.${ticket}`,
        "event.entity": "escalation",
        "event.action": "triage-cap-parked",
        "event.label": ticket,
        "catalyst.orchestration": orchId ?? ticket,
        "linear.issue.identifier": ticket,
      },
      body: {
        payload: { ticket, cap, count },
      },
    }) + "\n"
  );
}

// appendTriageCapParkedEvent — append the park event to the canonical log.
// Fail-open (returns false on any error) — visibility must never wedge admission.
export function appendTriageCapParkedEvent({ append = defaultAppend, ...fields } = {}) {
  try {
    const line = buildTriageCapParkedEvent(fields);
    append(line);
    return true;
  } catch (err) {
    log.error({ err: err.message }, "triage-cap-event: parked append failed");
    return false;
  }
}
