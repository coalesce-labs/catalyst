// drain-event.mjs — CTL-1095. Node drain event builder + best-effort appender.
//
// Mirrors heartbeat-event.mjs: OTel envelope, appendFileSync, never throws.
// Two event types:
//   node.drain.changed — operator toggled the drain flag (on or off)
//   node.drain.drained — last in-flight ticket landed while draining
//
// Both are best-effort: a write failure returns false and logs a warning;
// callers never branch on the return value for correctness.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, getHostName, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const DRAIN_CHANGED_EVENT = "node.drain.changed";
export const DRAINED_EVENT = "node.drain.drained";

/**
 * buildDrainChangedEnvelope — pure OTel envelope for a drain toggle.
 */
export function buildDrainChangedEnvelope({ draining, inFlightCount, now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const host = getHostName();
  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": DRAIN_CHANGED_EVENT,
      "event.entity": "node",
      "event.action": "drain.changed",
      "event.label": host,
    },
    body: {
      payload: {
        "host.name": host,
        draining: Boolean(draining),
        inFlightCount: inFlightCount ?? 0,
      },
    },
  };
}

/**
 * buildDrainedEnvelope — pure OTel envelope for the drained sentinel.
 */
export function buildDrainedEnvelope({ inFlightCount = 0, now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const host = getHostName();
  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": DRAINED_EVENT,
      "event.entity": "node",
      "event.action": "drain.drained",
      "event.label": host,
    },
    body: {
      payload: {
        "host.name": host,
        draining: true,
        inFlightCount: 0,
      },
    },
  };
}

/**
 * emitDrainChangedEvent — append one drain.changed envelope line. Returns true
 * on success, false on any failure (best-effort; never throws).
 */
export function emitDrainChangedEvent({
  draining,
  inFlightCount = 0,
  logPath = getEventLogPath(),
  now,
} = {}) {
  const line = `${JSON.stringify(buildDrainChangedEnvelope({ draining, inFlightCount, now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "drain-event: event append failed");
    return false;
  }
}

/**
 * emitDrainedEvent — append one drain.drained envelope line. Returns true on
 * success, false on any failure (best-effort; never throws).
 */
export function emitDrainedEvent({ logPath = getEventLogPath(), now } = {}) {
  const line = `${JSON.stringify(buildDrainedEnvelope({ now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "drain-event: event append failed");
    return false;
  }
}
