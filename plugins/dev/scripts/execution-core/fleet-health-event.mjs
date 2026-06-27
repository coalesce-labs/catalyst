// fleet-health-event.mjs — CTL-1165 D5. Fleet-health event builder + best-effort
// appender. Mirrors memory-event.mjs / heartbeat-event.mjs's shape (OTel
// envelope, appendFileSync, never throws) so orch-monitor/HUD parsers treat
// these events identically.
//
// One event name:
//   fleet.health.degraded — WARN, emitted once per tick while a steady-state
//   degradation signal (jobs-dir count, live bg-agent count, resident
//   worker-proc count, macOS swap pressure) is over threshold.
//
// The host lives in the `resource` block (host.name / host.id), NOT in the
// dotted event name — the monitor composes `fleet.health.degraded.<host>` by
// reading the resource, exactly as it does for every other execution-core
// emitter. Encoding the host into the event name would fragment the stream.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const FLEET_HEALTH_DEGRADED = "fleet.health.degraded";

/**
 * buildFleetHealthEnvelope — assemble the canonical OTel envelope for a
 * fleet.health.degraded event. Pure (modulo random id + timestamp); no I/O.
 *
 * @param {object} payload  { jobsCount, agentsCount, procsCount, swapUsedMb, tripped, sustained_n }
 * @param {object} [opts]
 * @param {Function} [opts.now]  injectable timestamp fn (returns ISO string)
 * @returns {object} the envelope object
 */
export function buildFleetHealthEnvelope(payload = {}, { now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const {
    jobsCount = null,
    agentsCount = null,
    procsCount = null,
    swapUsedMb = null,
    tripped = [],
    sustained_n = null,
  } = payload;

  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "WARN",
    severityNumber: 13,
    traceId: null,
    spanId: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": FLEET_HEALTH_DEGRADED,
      "event.entity": "fleet",
      "event.action": "degraded",
      "event.label": Array.isArray(tripped) && tripped.length ? tripped.join(",") : "fleet",
    },
    body: {
      payload: {
        jobsCount,
        agentsCount,
        procsCount,
        swapUsedMb,
        tripped,
        sustained_n,
      },
    },
  };
}

/**
 * emitFleetHealthEvent — build + append one envelope line to the event log.
 * Returns true on success, false on any failure (best-effort; NEVER throws — the
 * guardrail must never wedge the daemon). `logPath` is injectable for tests.
 */
export function emitFleetHealthEvent(payload, { logPath = getEventLogPath(), now } = {}) {
  const line = `${JSON.stringify(buildFleetHealthEnvelope(payload, { now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "fleet-health-event: event append failed");
    return false;
  }
}
