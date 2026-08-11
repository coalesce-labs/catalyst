// triage-state-health-event.mjs — canonical CAT-140 missing/recovered events.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const TRIAGE_STATE_MISSING_ACTION = "missing";
export const TRIAGE_STATE_RECOVERED_ACTION = "recovered";

function defaultAppend(line) {
  const path = getEventLogPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line);
}

export function buildTriageStateHealthEvent({ team, action, expectedState = null, ticketsAffected = 0 } = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const missing = action === TRIAGE_STATE_MISSING_ACTION;
  return `${JSON.stringify({
    ts, id: randomBytes(8).toString("hex"), observedTs: ts,
    severityText: missing ? "WARN" : "INFO", severityNumber: missing ? 13 : 9,
    traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"),
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": `monitor.triage_state.${action}.${team}`,
      "event.entity": "monitor", "event.action": `triage_state.${action}`,
      "event.label": team, "catalyst.team": team,
      "triage_state.expected": expectedState,
      "triage_state.tickets_affected": ticketsAffected,
    },
    body: { payload: { team, action, expectedState, ticketsAffected } },
  })}\n`;
}

export function appendTriageStateHealthEvent({ append = defaultAppend, ...fields } = {}) {
  try { append(buildTriageStateHealthEvent(fields)); return true; }
  catch (err) {
    log.error({ team: fields.team, action: fields.action, err: err.message }, "triage-state-health-event: append failed");
    return false;
  }
}
