// capacity-event.mjs — CTL-1092. Node capacity event builder + best-effort appender.
//
// Mirrors drain-event.mjs: OTel envelope, appendFileSync, never throws.
// Emitted on every autotune maxParallel change (alongside parallelism-adjusted).

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, getHostName, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const CAPACITY_CHANGED_EVENT = "node.capacity.changed";

/**
 * buildCapacityChangedEnvelope — pure OTel envelope for a capacity change.
 */
export function buildCapacityChangedEnvelope({ oldMaxParallel, newMaxParallel, reason, now } = {}) {
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
      "event.name": CAPACITY_CHANGED_EVENT,
      "event.entity": "node",
      "event.action": "capacity.changed",
      "event.label": host,
    },
    body: {
      payload: {
        "host.name": host,
        old_maxParallel: oldMaxParallel,
        new_maxParallel: newMaxParallel,
        reason,
      },
    },
  };
}

/**
 * emitCapacityChangedEvent — append one capacity.changed envelope line. Returns
 * true on success, false on any failure (best-effort; never throws).
 */
export function emitCapacityChangedEvent({
  oldMaxParallel,
  newMaxParallel,
  reason,
  logPath = getEventLogPath(),
  now,
} = {}) {
  const line = `${JSON.stringify(buildCapacityChangedEnvelope({ oldMaxParallel, newMaxParallel, reason, now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "capacity-event: event append failed");
    return false;
  }
}
