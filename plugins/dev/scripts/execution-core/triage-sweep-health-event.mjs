// triage-sweep-health-event.mjs — canonical held/recovered sweep events (CAT-82).
// SIBLINGS: replica-health-event.mjs and reconcile-health-event.mjs deliberately
// keep their distinct latch semantics in separate, small modules.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const TRIAGE_HELD_ACTION = "held";
export const TRIAGE_RECOVERED_ACTION = "recovered";

function defaultAppend(line) {
  const path = getEventLogPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line);
}

export function buildTriageSweepHealthEvent({
  team,
  action,
  consecutiveHeld = 0,
  considered = 0,
  heldDelegateUnreadable = 0,
} = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const held = action === TRIAGE_HELD_ACTION;
  return `${JSON.stringify({
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: held ? "WARN" : "INFO",
    severityNumber: held ? 13 : 9,
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": `monitor.triage.${action}.${team}`,
      "event.entity": "monitor",
      "event.action": `triage.${action}`,
      "event.label": team,
      "catalyst.team": team,
      "triage.consecutive_held": consecutiveHeld,
      "triage.considered": considered,
      "triage.held_delegate_unreadable": heldDelegateUnreadable,
    },
    body: { payload: { team, action, consecutiveHeld, considered, heldDelegateUnreadable } },
  })}\n`;
}

export function appendTriageSweepHealthEvent({ append = defaultAppend, ...fields } = {}) {
  try {
    append(buildTriageSweepHealthEvent(fields));
    return true;
  } catch (err) {
    log.error({ team: fields.team, action: fields.action, err: err.message }, "triage-sweep-health-event: append failed");
    return false;
  }
}
