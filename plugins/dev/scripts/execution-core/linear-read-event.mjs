// linear-read-event.mjs — CTL-1403. Reads-by-source telemetry for the Linear
// read path: one canonical `catalyst.linear.read` event per read outcome
// (success AND failure), appended fire-and-forget to the unified event log that
// otel-forward ships. The OTel Collector derives `catalyst_linear_read_total`
// {source,result} and `catalyst_linear_read_age_seconds` from these log records
// (a single Collector connector owns both metrics — there is NO native in-process
// MeterProvider anywhere in this tree, by house rule: health metrics derive from
// the unsampled log stream).
//
// WHY a dedicated node-safe module (not a reuse of config.mjs's getEventLogPath):
// `linear-cli.mjs` is under a `bun build --target=node` node-loadability CI gate
// and deliberately imports only node builtins. config.mjs drags dynamic pino, so
// importing it would break that gate. This module therefore imports only node
// builtins + two confirmed leaves: catalyst-resource.mjs (host-identity +
// node-class) and, since CTL-1216, lib/event-log-paths.mjs.
//
// That second one used to be an INLINED copy of config.mjs's path arithmetic,
// held "byte-identical" by hand for exactly this reason. lib/ is the
// zero-npm-import zone, so the resolver can now be SHARED without costing this
// module its node-loadability — the constraint that forced the copy is the one
// the leaf was designed around.
//
// SAFETY (CTL-988): a diagnostic tap in the Linear read critical path with no
// fallback once froze the fleet 17-37h. Every function here is best-effort and
// NEVER throws into the caller — the read result is always already in hand before
// emit runs, and emit swallows all its own errors.
//
// ATTRIBUTE CONTRACT (ratified with OTEL, CTL-1403 comms channel):
//   attributes = {
//     "event.name":  "catalyst.linear.read",
//     "event.entity":"linear",
//     "event.action":"read",
//     "event.label": <entity_id>,          // high-card, never a metric label
//     "linear.read.source": <source>,      // Collector normalizes → bare `source`
//     "linear.read.result": <result>,      // Collector normalizes → bare `result`
//     "linear.read.op":     <op>,          // structured metadata only (not a label)
//     "linear.read.age_ms": <number>,      // VALUE (→ age histogram); omitted when null
//   }
// source ∈ {replica, linearis, linearis_miss, linearis_exception}; result ∈ {ok, failed}.
// Everything queryable is a flat top-level attribute — otel-forward STRIPS body.payload.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";
// CTL-1216: THE event-log path resolver. Safe under this module's
// `bun build --target=node` node-loadability gate for the same reason
// catalyst-resource.mjs is: it is a confirmed leaf, importing only
// node:fs/os/path — no config, no pino, no sqlite.
import { getEventLogPath } from "../lib/event-log-paths.mjs";

export const LINEAR_READ_EVENT = "catalyst.linear.read";

// The four mutually-exclusive, closed `source` values (mirrors linear-cli.mjs's
// _meta.source enum). All non-`replica` values start "linearis" so the collector's
// bypass alert (`source=~"linearis.*"`) holds.
export const LINEAR_READ_SOURCES = Object.freeze([
  "replica",
  "linearis",
  "linearis_miss",
  "linearis_exception",
]);

// CTL-1216: this was an INLINED copy of config.mjs's getEventLogPath, kept
// "byte-identical" by hand so the module carried no heavy import. That is
// exactly the trade lib/event-log-paths.mjs removes: it is a zero-npm-import
// leaf, so sharing the resolver costs nothing here and "byte-identical" stops
// being a promise someone has to keep. Still re-resolved per call, so tests
// redirect via CATALYST_DIR.
function eventLogPath() {
  return getEventLogPath({ env: process.env });
}

/**
 * buildLinearReadEnvelope — assemble the canonical OTel envelope for one read.
 * Pure (modulo random ids + timestamp); no I/O.
 *
 * @param {object} fields
 * @param {string} fields.source  one of LINEAR_READ_SOURCES
 * @param {string} fields.result  "ok" | "failed"
 * @param {string} [fields.op]    "read_ticket" | "list" | "search" | … (structured metadata)
 * @param {string|null} [fields.entity]  the ticket id (event.label); null for list/search
 * @param {number|null} [fields.ageMs]   read_time − entity backend_ts; omitted when null/non-finite
 * @param {string} [fields.serviceName]  emitting binary's service.name (default catalyst.linear-read)
 * @param {Function} [opts.now]  injectable ISO-timestamp fn (tests)
 * @returns {object} the envelope object
 */
export function buildLinearReadEnvelope(fields = {}, { now } = {}) {
  const {
    source,
    result,
    op = null,
    entity = null,
    ageMs = null,
    serviceName = "catalyst.linear-read",
  } = fields;

  const failed = result === "failed";
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  const attributes = {
    "event.name": LINEAR_READ_EVENT,
    "event.entity": "linear",
    "event.action": "read",
  };
  // event.label = the entity id (high-cardinality; never promoted to a metric label).
  if (entity !== null && entity !== undefined && entity !== "") {
    attributes["event.label"] = entity;
  }
  // Low-cardinality metric dimensions — the collector normalizes the dotted keys
  // to bare `source`/`result` labels.
  attributes["linear.read.source"] = source;
  attributes["linear.read.result"] = result;
  if (op !== null && op !== undefined && op !== "") {
    attributes["linear.read.op"] = op;
  }
  // age_ms is a VALUE (feeds the staleness histogram). Emit ONLY when finite —
  // never faked to 0 (per the ratified contract).
  if (typeof ageMs === "number" && Number.isFinite(ageMs)) {
    attributes["linear.read.age_ms"] = ageMs;
  }

  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    // Severity stamped in-envelope (otel-forward passes a canonical record's
    // severity through unchanged): ok → INFO/9, failed → WARN/13.
    severityText: failed ? "WARN" : "INFO",
    severityNumber: failed ? 13 : 9,
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    resource: buildCatalystResource({ serviceName }),
    attributes,
    body: {
      message: `linear read ${entity ?? op ?? "?"} source=${source} result=${result}`,
    },
  };
}

/**
 * emitLinearReadEvent — build + append one envelope line to the event log.
 * Best-effort: returns true on success, false on ANY failure, and NEVER throws
 * (CTL-988 — must not be able to fail the read that called it). `logPath` and
 * `now` are injectable for tests.
 *
 * @returns {boolean}
 */
export function emitLinearReadEvent(fields, { logPath, now } = {}) {
  try {
    const path = logPath ?? eventLogPath();
    const line = `${JSON.stringify(buildLinearReadEnvelope(fields, { now }))}\n`;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, line);
    return true;
  } catch {
    // Swallow — a telemetry append must never break a Linear read. No log.warn
    // here on purpose: this module stays free of config.mjs/pino to keep
    // linear-cli.mjs node-loadable.
    return false;
  }
}
