// escalation-event.mjs — CTL-2056. Needs-human escalation event builder +
// best-effort appender. Mirrors ratelimit-event.mjs's shape (OTel envelope,
// appendFileSync, never throws) so the catalyst-otel count connector picks up
// event.entity="ticket" / event.action="escalated" and the unchanged
// catalyst_recovery_escalation_burst alarm selector matches real escalations.
//
// One event name:
//   ticket.escalated — INFO, emitted at the confirmed-apply chokepoint in
//   label-guard.mjs's labelNeedsHumanUnlessBeliefOwner (one per genuine
//   escalation — the marker guard in labelOnce ensures cardinality = 1).

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const ESCALATION_EVENT_NEEDS_HUMAN = "ticket.escalated";

/**
 * buildEscalationEnvelope — assemble the canonical OTel envelope for a
 * needs-human escalation event. Pure (modulo random ids + timestamp); no I/O.
 *
 * The count connector in catalyst-otel/collector-config.yaml keys on
 * event.entity × event.action, so setting entity="ticket" and action="escalated"
 * makes the UNCHANGED catalyst_recovery_escalation_burst PromQL selector
 * ({event_entity="ticket",event_action="escalated"}) count every genuine
 * escalation without any YAML change.
 *
 * @param {string} ticket
 * @param {object} [meta]
 * @param {string} [meta.site]   short caller id (e.g. "scheduler", "monitor")
 * @param {string} [meta.reason] human-readable reason string or null
 * @param {object} [opts]
 * @param {Function} [opts.now]  injectable timestamp fn (returns ISO string)
 * @returns {object} the envelope object
 */
export function buildEscalationEnvelope(ticket, { site = null, reason = null } = {}, { now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const severityText = "INFO";
  const severityNumber = 9;

  const attributes = {
    "event.name": ESCALATION_EVENT_NEEDS_HUMAN,
    "event.entity": "ticket",
    "event.action": "escalated",
    "event.label": ticket ?? "unknown",
  };
  if (site != null) attributes["escalation.site"] = site;
  if (reason != null) attributes["escalation.reason"] = reason;

  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText,
    severityNumber,
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes,
    body: {
      payload: { ticket, site, reason },
    },
  };
}

/**
 * emitEscalationEvent — build + append one envelope line to the event log.
 * Returns true on success, false on any failure (best-effort; never throws).
 * `logPath` and `now` are injectable for tests.
 */
export function emitEscalationEvent(ticket, meta, { logPath = getEventLogPath(), now } = {}) {
  const line = `${JSON.stringify(buildEscalationEnvelope(ticket, meta, { now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message, ticket }, "escalation-event: event append failed");
    return false;
  }
}
