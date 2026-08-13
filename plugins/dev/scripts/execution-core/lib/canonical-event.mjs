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
export function buildCanonicalEventLine(spec, seams) {
  return JSON.stringify(buildCanonicalEvent(spec, seams)) + "\n";
}

/**
 * buildCanonicalEvent — the same envelope as an OBJECT, before serialization.
 *
 * Extracted from buildCanonicalEventLine (CTL-1795) so the dual-envelope builder below can
 * merge the v1 fields into it without a JSON.parse round-trip. buildCanonicalEventLine is
 * now a one-line wrapper, so the two can never describe different shapes.
 *
 * @param {import("./canonical-event.d.mts").CanonicalEventSpec} spec
 * @param {import("./canonical-event.d.mts").CanonicalEventSeams} [seams]
 * @returns {object} the envelope object
 */
export function buildCanonicalEvent(
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
  return {
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
  };
}

// ─── CTL-1795: the v1→superset dual envelope ────────────────────────────────────────────
//
// A SECOND shape is still live on the log alongside v3's now-fixed producers: **v1**, the flat
// `{ts, event, ...snake_case fields}` envelope. Measured on mini over 2026-08 (2,544,842 events):
// v2 2,384,622 · **v1 159,009 across 31 distinct names** · v3 1,006. Every one of those 159k is
// invisible to a consumer that reads `attributes["event.name"]`, with no error — which is how the
// design audit that produced this project missed 27 names on its own first pass.
//
// THE WIRE SHAPE IS ONE SUPERSET LINE, NOT TWO LINES. The line carries BOTH the top-level v1
// `event` and a full v2 `attributes`/`body`/`resource` block. Two separate lines would be a
// correctness bug, not merely wasteful: three readers extract the name **v1-first** —
//   broker/event-name.mjs:16 · broker/projection.mjs:305 · broker/router.mjs (re-export)
//     getEventName = event.event ?? event.attributes?.["event.name"]
// so a v1 line and its v2 twin BOTH resolve to the same name and BOTH get routed. For
// `agent.checkin`/`agent.checkout` that means `handleAgentCheckin`/`handleAgentCheckout` run
// `upsertAgent` and `_autoRegisterPrLifecycle` twice per real event.
//
// The superset line is safe against every shape discriminator that reads this log, each verified
// against the tree rather than assumed:
//   · otel-forward `isFlatEvent` (lib/normalize.ts:20) requires `!("attributes" in o)`, so a
//     superset line is NOT claimed by it and forwards as already-canonical — no re-normalization,
//     and the producer's attributes reach OTLP intact.
//   · `canonical_jsonl_append`'s legacy rotation (lib/canonical-event.sh) and orch-monitor's
//     `event-writer.ts:136` both key on `has("attributes")`, so a superset line does NOT rotate
//     the live month file aside.
//   · `catalyst-state.sh:193` passes an attributes-bearing line straight through, untranslated.
//
// PHASE 1 IS ADDITIVE. v1 emission is NOT removed here and `catalyst-events tail`/`wait-for` are
// NOT narrowed to v2 — that is an explicit follow-up one release later, once consumers are
// confirmed reading v2. Re-emitting the plain v1 line is the revert.

/**
 * FLAT_ATTRIBUTE_MAP — which v1 flat fields are promoted to first-class OTel attributes.
 *
 * Deliberately byte-identical to otel-forward's `ATTR_MAP` (lib/normalize.ts:8-15), because
 * that is what the forwarder produces for these events TODAY. Once a producer emits the
 * superset shape the forwarder stops normalizing it (`isFlatEvent` no longer matches), so any
 * divergence here would silently change the attribute set of 159k events/month arriving in
 * Loki — a dashboard break landing at the same moment as a shape change, which is exactly the
 * kind of coupled failure this ticket exists to prevent. Keep the two in lockstep; the
 * dual-envelope test asserts the table contents literally.
 */
export const FLAT_ATTRIBUTE_MAP = Object.freeze({
  ticket: "catalyst.worker.ticket",
  phase: "catalyst.worker.phase",
  bg_job_id: "catalyst.worker.bg_job_id",
  branch: "catalyst.worker.branch",
  orch_id: "catalyst.orchestrator.id",
  dominant_phase: "catalyst.worker.dominant_phase",
});

/**
 * buildDualEnvelopeLine — one JSONL line carrying BOTH envelope shapes for the same event.
 *
 * @param {object} flat  the v1 record the caller already builds: `{ts, event, ...fields}`.
 *   `event` is the event NAME (required, non-empty string); `ts` is adopted verbatim by the
 *   canonical half so the line can never carry two disagreeing timestamps. Every other key is
 *   split by FLAT_ATTRIBUTE_MAP into attributes (mapped) or body.payload (everything else), so
 *   nothing is dropped — and every key ALSO survives at the top level, untouched, for the
 *   existing v1 readers (the reaper reads `e.event`/`e.bg_job_id`/`e.worktree_path` directly).
 * @param {object} [opts] `{serviceName, severityText, severityNumber}` — same defaults as the
 *   canonical builder.
 * @param {import("./canonical-event.d.mts").CanonicalEventSeams} [seams]
 * @returns {string} the JSONL line, newline-terminated
 * @throws {Error} when `flat.event` is missing/not a non-empty string, or when `flat` ALREADY
 *   carries an `attributes` block. Both fail CLOSED: the first is the nameless degenerate
 *   record the canonical builder exists to prevent, and the second means the caller handed us
 *   something already canonical, which we must not double-wrap. Callers keep their existing
 *   try/catch and fall back to the plain v1 line, so a throw here degrades to today's behavior
 *   rather than losing an event — losing a `*.reap-requested` means a worker is never reaped.
 */
export function buildDualEnvelopeLine(flat, opts = {}, seams = undefined) {
  if (flat === null || typeof flat !== "object" || Array.isArray(flat)) {
    throw new Error("buildDualEnvelopeLine: flat.event is required");
  }
  const name = flat.event;
  if (typeof name !== "string" || name === "") {
    throw new Error("buildDualEnvelopeLine: flat.event is required");
  }
  if ("attributes" in flat) {
    throw new Error("buildDualEnvelopeLine: record is already canonical — refusing to double-wrap");
  }

  const attributes = {};
  const payload = {};
  for (const [key, value] of Object.entries(flat)) {
    if (key === "ts" || key === "event") continue; // envelope fields, never payload
    const mapped = FLAT_ATTRIBUTE_MAP[key];
    if (mapped) attributes[mapped] = value;
    else payload[key] = value;
  }

  const canonical = buildCanonicalEvent(
    {
      name,
      attributes,
      payload: Object.keys(payload).length > 0 ? payload : undefined,
      serviceName: opts.serviceName,
      severityText: opts.severityText,
      severityNumber: opts.severityNumber,
    },
    seams,
  );

  // ONE timestamp, adopted verbatim rather than re-derived. Round-tripping `flat.ts` through
  // `new Date()` would throw on an unparseable value (and silently re-render a non-ISO one), so
  // the string is copied as-is: the two halves of a superset line must never disagree about when
  // the event happened.
  if (typeof flat.ts === "string" && flat.ts !== "") {
    canonical.ts = flat.ts;
    canonical.observedTs = flat.ts;
  }

  // v1 keys FIRST so the line still reads as a v1 record at a glance and `event` stays early;
  // canonical keys win any collision (only `ts` can collide, and it was just unified above).
  return JSON.stringify({ ...flat, ...canonical }) + "\n";
}
