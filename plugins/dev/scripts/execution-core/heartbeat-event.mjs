// heartbeat-event.mjs — CTL-859. Node-heartbeat event builder + best-effort
// appender, plus a small periodic emitter the daemon arms.
//
// PR1 of the distributed-coordination epic. Each daemon appends a
// `node.heartbeat` canonical event to the unified event log every
// HEARTBEAT_INTERVAL_MS so a future liveness reader (readClusterHeartbeats,
// recovery.mjs) can detect a dead node by heartbeat silence. ADDITIVE/dormant:
// emitting a heartbeat changes no dispatch/claim/eligible-query behavior — it is
// pure observability data on the shared log.
//
// Shape mirrors memory-event.mjs (OTel envelope, appendFileSync, never throws)
// so the orch-monitor/HUD/broker parsers treat the line identically. The
// resource block carries host.name + host.id from lib/host-identity.mjs, the
// same primitives every other execution-core MJS emitter uses.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, getHostName, HEARTBEAT_INTERVAL_MS, log } from "./config.mjs";
import { hostName, hostId } from "./lib/host-identity.mjs";

export const HEARTBEAT_EVENT = "node.heartbeat";

/**
 * buildHeartbeatEnvelope — assemble the canonical OTel envelope for a heartbeat.
 * Pure (modulo random ids + timestamp); no I/O.
 *
 * The payload carries the host name and an epoch (ms) so a reader can compute
 * liveness without re-parsing the ISO ts. `host` in the payload is resolved via
 * getHostName() (Layer-2 config aware), while the resource block uses the
 * lib/host-identity.mjs primitives shared across all three runtimes.
 *
 * @param {object} [opts]
 * @param {Function} [opts.now]  injectable timestamp fn (returns ISO string)
 * @param {Function} [opts.epochFn]  injectable epoch fn (returns ms number)
 * @returns {object} the envelope object
 */
export function buildHeartbeatEnvelope({ now, epochFn } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const epoch = epochFn ? epochFn() : Date.now();
  const host = getHostName();

  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: {
      "service.name": "catalyst.execution-core",
      "service.namespace": "catalyst",
      "host.name": hostName(),
      "host.id": hostId(),
    },
    attributes: {
      "event.name": HEARTBEAT_EVENT,
      "event.entity": "node",
      "event.action": "heartbeat",
      "event.label": host,
    },
    body: {
      payload: {
        "host.name": host,
        epoch,
      },
    },
  };
}

/**
 * emitHeartbeatEvent — build + append one heartbeat envelope line to the unified
 * event log. Returns true on success, false on any failure (best-effort; never
 * throws). `logPath` is injectable for tests; defaults to the same
 * getEventLogPath() every other emitter uses (no new log path).
 */
export function emitHeartbeatEvent({ logPath = getEventLogPath(), now, epochFn } = {}) {
  const line = `${JSON.stringify(buildHeartbeatEnvelope({ now, epochFn }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "heartbeat-event: event append failed");
    return false;
  }
}

/**
 * startHeartbeat — arm a periodic heartbeat emitter. Fires one heartbeat
 * immediately, then every intervalMs. Returns a stop handle ({ stop() }) so the
 * daemon can tear it down symmetrically with its other timers. The interval is
 * unref'd so it never holds the process open.
 *
 * @param {object} [opts]
 * @param {number} [opts.intervalMs]  cadence; defaults to HEARTBEAT_INTERVAL_MS
 * @param {string} [opts.logPath]     event-log path (injectable for tests)
 */
export function startHeartbeat({ intervalMs = HEARTBEAT_INTERVAL_MS, logPath } = {}) {
  const tick = () => emitHeartbeatEvent({ logPath });
  tick(); // emit once at boot so liveness is visible immediately
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
