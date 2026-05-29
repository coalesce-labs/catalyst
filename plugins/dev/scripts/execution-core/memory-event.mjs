// memory-event.mjs — CTL-685. Per-worker memory event builder + best-effort
// appender. Mirrors wait-event.mjs's shape (OTel envelope, appendFileSync,
// never throws) so orch-monitor/HUD parsers treat these events identically.
//
// Three event names:
//   worker.memory.sampled — INFO, emitted every tick per live worker
//   worker.memory.warn    — WARN, RSS >= warnThreshold or killThreshold
//   worker.memory.killed  — WARN, worker was claude-stop'd after sustained breach

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, log } from "./config.mjs";

export const MEMORY_EVENT_SAMPLED = "worker.memory.sampled";
export const MEMORY_EVENT_WARN = "worker.memory.warn";
export const MEMORY_EVENT_KILLED = "worker.memory.killed";

/**
 * buildMemoryEnvelope — assemble the canonical OTel envelope for a memory
 * event. Pure (modulo random ids + timestamp); no I/O.
 *
 * @param {string} name   MEMORY_EVENT_SAMPLED | MEMORY_EVENT_WARN | MEMORY_EVENT_KILLED
 * @param {object} payload
 * @param {object} [opts]
 * @param {Function} [opts.now]  injectable timestamp fn (returns ISO string)
 * @returns {object} the envelope object
 */
export function buildMemoryEnvelope(name, payload = {}, { now } = {}) {
  const ts = now
    ? now()
    : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const severityText = name === MEMORY_EVENT_SAMPLED ? "INFO" : "WARN";
  const severityNumber = severityText === "INFO" ? 9 : 13;
  const {
    sessionId = null,
    shortId = null,
    ticket = null,
    phase = null,
    rss_mb = null,
    swap_mb = null,
    threshold_mb = null,
    sample_count = null,
  } = payload;
  const action = name.replace(/^worker\./, "");

  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText,
    severityNumber,
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    resource: {
      "service.name": "catalyst.execution-core",
      "service.namespace": "catalyst",
    },
    attributes: {
      "event.name": name,
      "event.entity": "worker",
      "event.action": action,
      "event.label": ticket ?? shortId ?? sessionId ?? "unknown",
      ...(ticket ? { "linear.issue.identifier": ticket } : {}),
    },
    body: {
      payload: {
        sessionId,
        shortId,
        ticket,
        phase,
        rss_mb,
        swap_mb,
        threshold_mb,
        sample_count,
      },
    },
  };
}

/**
 * emitMemoryEvent — build + append one envelope line to the event log. Returns
 * true on success, false on any failure (best-effort; never throws). `logPath`
 * is injectable for tests.
 */
export function emitMemoryEvent(name, payload, { logPath = getEventLogPath() } = {}) {
  const line = `${JSON.stringify(buildMemoryEnvelope(name, payload))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message, name }, "memory-event: event append failed");
    return false;
  }
}
