// delegate-event.mjs — CTL-1774 Phase 2: delegate.* event emitter leaf module.
//
// Builds and appends one delegate.* event to the unified event log.
// Modelled on worker-transition-event.mjs (leaf emitter): imports only
// getEventLogPath + log from config.mjs and buildCatalystResource from
// lib/catalyst-resource.mjs — no heavy execution-core graph.
//
// Dims land in BOTH attributes (otel-forward strips body.payload off-machine)
// and body.payload (broker reads raw JSONL).
//
// The three names — delegate.would-route, delegate.routed, delegate.route-fallback —
// are already registered in broker/namespace-parity.test.mjs:67-70 and are not
// broker-protected (they route through shouldSkipEvent normally).
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getEventLogPath, log } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";

function defaultAppend(line) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, line);
}

/**
 * buildDelegateEvent — returns a canonical JSONL line (string + "\n") for a
 * delegate.* INFO event.
 *
 * @param {object} opts
 * @param {string} opts.name     "delegate.would-route" | "delegate.routed" | "delegate.route-fallback"
 * @param {string} opts.ticket   Linear ticket identifier
 * @param {string|null} [opts.site]     caller site identifier (e.g. "terminal-sweep")
 * @param {string|null} [opts.reason]   short reason string
 * @param {string|null} [opts.orchId]   orchestrator id (falls back to ticket)
 * @param {string|null} [opts.causedBy] triggering event id (ADR-022 absence-detection)
 */
export function buildDelegateEvent({
  name,
  ticket,
  site = null,
  reason = null,
  orchId = null,
  causedBy = null,
} = {}) {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const orchVal = orchId ?? ticket;
  // event.action is the second dot-segment: "would-route", "routed", "route-fallback"
  const action = name.split(".").slice(1).join(".");

  const attributes = {
    "event.name": name,
    "event.entity": "delegate",
    "event.action": action,
    "event.label": ticket,
    "catalyst.orchestration": orchVal,
    "linear.issue.identifier": ticket,
  };
  // omit null dims from attributes (don't send null strings over OTLP)
  if (site != null) attributes["catalyst.delegate.site"] = site;
  if (reason != null) attributes["catalyst.delegate.reason"] = reason;

  return (
    JSON.stringify({
      ts,
      id: randomBytes(8).toString("hex"),
      observedTs: ts,
      severityText: "INFO",
      severityNumber: 9,
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      caused_by: causedBy,
      resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
      attributes,
      body: {
        payload: { ticket, name, site, reason },
      },
    }) + "\n"
  );
}

/**
 * appendDelegateEvent — appends the event to the unified event log.
 *
 * Accepts an optional second argument `append` for test injection (same pattern
 * as appendWorkerTransitionEvent). Returns true on success, false on any error
 * (never throws).
 *
 * @param {object} evt   see buildDelegateEvent params
 * @param {function} [append]  injectable append function (default: real fs append)
 */
export function appendDelegateEvent(evt, append = defaultAppend) {
  try {
    const line = buildDelegateEvent(evt);
    append(line);
    return true;
  } catch (err) {
    log.error({ err: err.message, kind: "delegate-event" }, "delegate: event append failed");
    return false;
  }
}
