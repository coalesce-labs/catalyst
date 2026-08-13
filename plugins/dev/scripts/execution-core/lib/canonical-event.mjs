// lib/canonical-event.mjs — the SINGLE shared builder for a canonical ("v2") event-log
// line emitted by an execution-core timer (CTL-1817).
//
// WHY THIS EXISTS. Three envelope shapes coexist on the event log. Measured on mini over
// 2026-08 (1,119,671 events): v2 (has `attributes`) 1,094,099 · v1 (has `event`) 25,040 ·
// v3 (has a bare top-level `name`) 532. otel-forward maps a log line to an OTLP LogRecord
// assuming v2:
//
//   body:       ev.body?.message ?? ev.attributes?.["event.name"] ?? ""
//   attributes: toAttrArray(ev.attributes ?? {})
//
// A v3 line satisfies NEITHER optional chain, so it is forwarded off-machine with an empty
// body AND empty attributes — the record reaches Loki carrying nothing but a timestamp and a
// severity. The event exists on the host and is destroyed in transit. Both v3 producers
// (stale-pr-rescue-timer, orphan-pr-sweep-timer) had hand-rolled the same bare envelope:
//
//   JSON.stringify({ name, ...payload, ts })     // <- no attributes, no body, no resource
//
// so the identifier (the ticket, or the PR number) survived ONLY inside the event name, and
// the name itself was not on the wire. This module is the one place that shape now lives.
//
// A LEAF, deliberately: it imports node:crypto and lib/catalyst-resource.mjs and NOTHING
// else. No config.mjs (which drags bun:sqlite), no pino. Callers own their own append, so a
// producer that already resolves getEventLogPath() keeps doing so and this stays cheap to
// import from anywhere.
//
// Prior art / shape reference: fence-event.mjs (CTL-863), which this mirrors field for field.
// The ~12 other bespoke build*Event() emitters in execution-core each still inline this same
// envelope; folding them onto this builder is deliberate follow-up, not part of CTL-1817.

import { randomBytes } from "node:crypto";
import { buildCatalystResource } from "./catalyst-resource.mjs";

/**
 * buildCanonicalEventLine — assemble one canonical JSONL event line (string, "\n"-terminated).
 *
 * The two invariants this exists to guarantee, both asserted in canonical-event.test.mjs:
 *   1. `body.message` is ALWAYS non-empty (it defaults to the event name), and
 *   2. `attributes["event.name"]` is ALWAYS present,
 * so the record can never map to the empty OTLP LogRecord described above.
 *
 * @param {object} spec
 * @param {string} spec.name              full event name, e.g. "phase.rescue.escalated.CTL-1832" (required)
 * @param {unknown} [spec.payload]        structured detail → body.payload; omitted entirely when undefined/null
 * @param {string} [spec.serviceName]     resource service.name (default "catalyst.execution-core")
 * @param {object} [spec.attributes]      extra OTel attributes merged AFTER event.name (identifiers belong here)
 * @param {string} [spec.severityText]    default "INFO"
 * @param {number} [spec.severityNumber]  default 9 (INFO)
 * @param {object} [seams]                injectable clock/id seams so tests get a deterministic envelope
 * @returns {string} the JSONL line, newline-terminated
 * @throws {Error} when `name` is missing or not a non-empty string — fail CLOSED. A nameless
 *   event is exactly the degenerate record this module exists to prevent, so it must not be
 *   constructible; the caller's try/catch turns it into a logged best-effort miss.
 */
export function buildCanonicalEventLine(
  {
    name,
    payload = undefined,
    serviceName = "catalyst.execution-core",
    attributes = {},
    severityText = "INFO",
    severityNumber = 9,
  } = {},
  {
    now = () => new Date(),
    newId = () => randomBytes(8).toString("hex"),
    newTrace = () => randomBytes(16).toString("hex"),
    newSpan = () => randomBytes(8).toString("hex"),
  } = {},
) {
  if (typeof name !== "string" || name === "") {
    throw new Error("buildCanonicalEventLine: name is required");
  }
  const ts = now().toISOString().replace(/\.\d{3}Z$/, "Z");
  // event.name FIRST so the wire order matches every other emitter, then caller attributes,
  // then event.name REASSERTED so a caller cannot displace it. Re-assigning an existing key
  // does not move it in JS insertion order, so this keeps position AND wins the conflict —
  // invariant (2) holds even against a careless caller.
  const attrs = { "event.name": name, ...attributes };
  attrs["event.name"] = name;
  return (
    JSON.stringify({
      ts,
      id: newId(),
      observedTs: ts,
      severityText,
      severityNumber,
      traceId: newTrace(),
      spanId: newSpan(),
      resource: buildCatalystResource({ serviceName }),
      attributes: attrs,
      body: {
        // Non-empty by construction — this is invariant (1) above.
        message: name,
        ...(payload !== undefined && payload !== null ? { payload } : {}),
      },
    }) + "\n"
  );
}
