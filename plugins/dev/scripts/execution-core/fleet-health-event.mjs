// fleet-health-event.mjs — CTL-1165 D5. Fleet-health event builder + best-effort
// appender. Mirrors memory-event.mjs / heartbeat-event.mjs's shape (OTel
// envelope, appendFileSync, never throws) so orch-monitor/HUD parsers treat
// these events identically.
//
// Two event names, one shared builder (CTL-1503 — edge-triggered pair):
//   fleet.health.degraded  — WARN (severityNumber 13), emitted ONCE on the
//     healthy→degraded edge (was: once per tick, which flapped ~57×/3h).
//   fleet.health.recovered — INFO (severityNumber 9), emitted ONCE on the
//     degraded→healthy edge when every signal has dropped below its clear
//     threshold (hysteresis band). Carries the last tripped set for forensic
//     parity. Mirrors the ingestion-recency stale/recovered severity convention.
// The probe (fleet-health-probe.mjs) owns the edge/latch state machine; this
// module only shapes + appends the envelope. `action` ("degraded" | "recovered")
// switches severity + name, exactly as buildIngestionRecencyEnvelope does.
//
// The host lives in the `resource` block (host.name / host.id), NOT in the
// dotted event name — the monitor composes `fleet.health.<action>.<host>` by
// reading the resource, exactly as it does for every other execution-core
// emitter. Encoding the host into the event name would fragment the stream.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const FLEET_HEALTH_DEGRADED = "fleet.health.degraded";
export const FLEET_HEALTH_RECOVERED = "fleet.health.recovered";

/**
 * buildFleetHealthEnvelope — assemble the canonical OTel envelope for a
 * fleet.health.{degraded,recovered} event. Pure (modulo random id + timestamp);
 * no I/O. `action` switches the event name + severity (mirrors
 * buildIngestionRecencyEnvelope's stale/recovered switch).
 *
 * @param {object} payload  { jobsCount, agentsCount, procsCount, swapUsedMb, tripped, sustained_n }
 * @param {object} [opts]
 * @param {Function} [opts.now]  injectable timestamp fn (returns ISO string)
 * @param {("degraded"|"recovered")} [opts.action="degraded"]  edge selector
 * @returns {object} the envelope object
 */
export function buildFleetHealthEnvelope(payload = {}, { now, action = "degraded" } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const recovered = action === "recovered";
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
    severityText: recovered ? "INFO" : "WARN",
    severityNumber: recovered ? 9 : 13,
    traceId: null,
    spanId: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      "event.name": recovered ? FLEET_HEALTH_RECOVERED : FLEET_HEALTH_DEGRADED,
      "event.entity": "fleet",
      "event.action": action,
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
export function emitFleetHealthEvent(payload, { logPath = getEventLogPath(), now, action } = {}) {
  const line = `${JSON.stringify(buildFleetHealthEnvelope(payload, { now, action }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "fleet-health-event: event append failed");
    return false;
  }
}
