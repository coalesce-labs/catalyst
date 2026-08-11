import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const TRIAGE_CAP_EVENT_PREFIX = "triage.redispatch.capped";

function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

export function buildTriageCapEvent(fields = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return JSON.stringify({
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "WARN",
    severityNumber: 13,
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    resource: buildCatalystResource({ serviceName: "catalyst.monitor" }),
    attributes: {
      "event.name": `${TRIAGE_CAP_EVENT_PREFIX}.${fields.ticket}`,
      "event.entity": "ticket",
      "event.action": "triage-redispatch-capped",
      "event.label": fields.ticket,
      "linear.issue.identifier": fields.ticket,
    },
    body: { payload: fields },
  }) + "\n";
}

export function appendTriageCapEvent({ append = defaultAppend, ...fields } = {}) {
  try {
    append(buildTriageCapEvent(fields));
    return true;
  } catch (err) {
    log.error({ err: err.message }, "triage-cap-event: append failed");
    return false;
  }
}
