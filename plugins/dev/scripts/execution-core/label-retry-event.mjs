// label-retry-event.mjs — CTL-2052 (AC3). The "stopped after N and said so" event.
//
// After N cool-down cycles for the same (ticket, label) the converger STOPS
// re-issuing (long back-off) and emits ONE `linear.label.retry-exhausted` — the
// operator-visible record that a genuinely stuck label was bounded rather than
// retried once-per-window forever. Edge-triggered (one per cap crossing), same
// discipline as CTL-1817's sparse-warn.
//
// The `linear.label.*` prefix is UNPROTECTED under the CTL-1142 namespace contract
// (not filter.* / broker.daemon.* / session.heartbeat / phase.<name>.<terminal>),
// so it routes through shouldSkipEvent normally and carries no phase slot — asserted
// in broker/namespace-parity.test.mjs, which imports THIS constant rather than a
// re-typed literal (the CTL-1659/CTL-1889/CTL-2076 discipline).
//
// Mirrors capacity-event.mjs: a pure OTel envelope builder + a best-effort appender
// that never throws.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { getEventLogPath, getHostName, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

export const LABEL_RETRY_EXHAUSTED_EVENT = "linear.label.retry-exhausted";

/**
 * buildLabelRetryExhaustedEnvelope — pure OTel envelope for the retry-exhausted
 * escalation. `reason` is the normalized failure class that drove the back-off
 * (e.g. cloud:label-rejected), surfaced verbatim so AC2's "with the reason" survives.
 */
export function buildLabelRetryExhaustedEnvelope({ ticket, label, attempts, reason, now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const host = getHostName();
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
      "event.name": LABEL_RETRY_EXHAUSTED_EVENT,
      "event.entity": "label",
      "event.action": "retry.exhausted",
      "event.label": ticket,
    },
    body: {
      payload: {
        "host.name": host,
        ticket,
        label,
        attempts,
        reason,
      },
    },
  };
}

/**
 * emitLabelRetryExhaustedEvent — append one retry-exhausted envelope line. Returns
 * true on success, false on any failure (best-effort; never throws — AC3's operator
 * "says so" also rides the daemon log.error, so a lost event never blocks the stop).
 */
export function emitLabelRetryExhaustedEvent({
  ticket,
  label,
  attempts,
  reason,
  logPath = getEventLogPath(),
  now,
} = {}) {
  const line = `${JSON.stringify(buildLabelRetryExhaustedEnvelope({ ticket, label, attempts, reason, now }))}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "label-retry-event: event append failed");
    return false;
  }
}
