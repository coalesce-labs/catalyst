// replica-health-event.mjs — canonical monitor.replica degraded/recovered events (CAT-35).
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const REPLICA_DEGRADED_ACTION = "degraded";
export const REPLICA_RECOVERED_ACTION = "recovered";

function defaultAppend(line) {
  const path = getEventLogPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line);
}

export function buildReplicaHealthEvent({ team, action, source = null, consecutiveDegraded = 0 } = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const degraded = action === REPLICA_DEGRADED_ACTION;
  return `${JSON.stringify({
    ts, id: randomBytes(8).toString("hex"), observedTs: ts,
    severityText: degraded ? "WARN" : "INFO", severityNumber: degraded ? 13 : 9,
    traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"),
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": `monitor.replica.${action}.${team}`,
      "event.entity": "monitor", "event.action": `replica.${action}`,
      "event.label": team, "catalyst.team": team,
      ...(source ? { "replica.source": source } : {}),
    },
    body: { payload: { team, action, source, consecutiveDegraded } },
  })}\n`;
}

export function appendReplicaHealthEvent({ append = defaultAppend, ...fields } = {}) {
  try { append(buildReplicaHealthEvent(fields)); return true; }
  catch (err) {
    log.error({ team: fields.team, action: fields.action, err: err.message }, "replica-health-event: append failed");
    return false;
  }
}
