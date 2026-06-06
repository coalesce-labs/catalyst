// emit.mjs — catalyst-agent telemetry envelope builder + the two emit
// transports. Mirrors execution-core/ratelimit-event.mjs's envelope shape (OTel
// log record: ts/id/observedTs/severityText INFO/severityNumber 9/traceId/
// spanId/resource/attributes/body.payload) so orch-monitor / catalyst-otel
// parsers treat agent events identically to execution-core events.
//
// SELF-CONTAINED: zero npm deps, node:* builtins only; runs under node>=18 and
// bun. The standalone agent does NOT import from execution-core.
//
// Two transports, both best-effort and NEVER-throw:
//   emitEventLog(envelope) — Approach A: append the envelope as one JSONL line
//     to ~/catalyst/events/<YYYY-MM UTC>.jsonl (logPath injectable for tests).
//   sendOtlp(envelopes)    — Approach B: POST OTLP/HTTP JSON logs to
//     <endpoint>/v1/logs, mapping each envelope to an OTLP logRecord.
//
// CRITICAL (telemetry contract): numeric/string value attributes are placed as
// LOG-RECORD attributes in DOT form (e.g. host.cpu_pct, ratelimit.five_hour_pct)
// so the catalyst-otel collector renames dot→underscore and Loki promotes them
// to labels. A body.payload mirror keeps the high-cardinality / human-readable
// fields. An attribute is included ONLY when its value is non-null/defined (the
// put() pattern) so the collector never promotes an empty label.

import { mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { getEventLogPath, log } from "./config.mjs";

/**
 * buildAgentEnvelope — assemble the canonical OTel envelope for a catalyst-agent
 * event. Pure (modulo random ids + timestamp); no I/O.
 *
 * @param {string} name  e.g. "account.ratelimit.sampled", "host.metrics.sampled"
 * @param {object} spec
 * @param {string}  spec.entity   event.entity — "account" | "host" | …
 * @param {string} [spec.label]   event.label  — defaults to "unknown"
 * @param {object} [spec.attrs]   dot-form value attributes; null/undefined entries are dropped
 * @param {object} [spec.payload] body.payload mirror (kept verbatim, may hold high-cardinality fields)
 * @param {object} [opts]
 * @param {Function} [opts.now]   injectable timestamp fn (returns ISO string)
 * @returns {object} the envelope object
 */
export function buildAgentEnvelope(name, { entity, label, attrs = {}, payload = {} } = {}, { now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  // event.action is the name with its leading "<entity>." segment stripped,
  // matching ratelimit-event's `name.replace(/^account\./, "")` convention.
  const action = entity ? name.replace(new RegExp(`^${entity}\\.`), "") : name;

  const attributes = {
    "event.name": name,
    "event.entity": entity,
    "event.action": action,
    "event.label": label ?? "unknown",
  };
  // Only include a value attribute when it is non-null/defined so the collector
  // never promotes an empty label (and zero is preserved, not dropped as falsy).
  const put = (key, value) => {
    if (value !== null && value !== undefined) attributes[key] = value;
  };
  for (const [key, value] of Object.entries(attrs)) put(key, value);

  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: "INFO",
    severityNumber: 9,
    traceId: randomBytes(16).toString("hex"),
    spanId: randomBytes(8).toString("hex"),
    resource: {
      "service.name": "catalyst.agent",
      "service.namespace": "catalyst",
      hostname: hostname(),
    },
    body: { payload },
    attributes,
  };
}

/**
 * emitEventLog — append one envelope as a JSONL line to the unified event log.
 * Best-effort: returns true on success, false on any failure; NEVER throws.
 * `logPath` is injectable for tests (defaults to the current monthly log).
 */
export function emitEventLog(envelope, { logPath = getEventLogPath() } = {}) {
  const line = `${JSON.stringify(envelope)}\n`;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.warn({ err: err?.message }, "emit: event-log append failed");
    return false;
  }
}

// otlpAnyValue — map a JS scalar to an OTLP AnyValue. Booleans before numbers
// (typeof true === "boolean"); integers use intValue, other numbers doubleValue;
// everything else stringifies. Null/undefined never reach here (filtered by the
// put() pattern upstream) but are coerced to an empty string defensively.
function otlpAnyValue(value) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { intValue: value } : { doubleValue: value };
  }
  return { stringValue: value == null ? "" : String(value) };
}

// otlpAttributes — map a flat { key: scalar } object to the OTLP KeyValue[] shape.
function otlpAttributes(obj) {
  return Object.entries(obj).map(([key, value]) => ({ key, value: otlpAnyValue(value) }));
}

// envelopeToLogRecord — map one catalyst-agent envelope to an OTLP logRecord.
// timeUnixNano is derived from the envelope ts (ms → ns); severity carries
// through as INFO/9; the dot-form attributes become OTLP attributes and the
// body.payload rides as a stringValue body for human readability.
function envelopeToLogRecord(envelope) {
  const ms = Date.parse(envelope.ts);
  const timeUnixNano = String((Number.isFinite(ms) ? ms : Date.now()) * 1_000_000);
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: 9,
    severityText: "INFO",
    body: { stringValue: JSON.stringify(envelope.body?.payload ?? {}) },
    attributes: otlpAttributes(envelope.attributes ?? {}),
  };
}

/**
 * sendOtlp — POST a batch of envelopes to <endpoint>/v1/logs as OTLP/HTTP JSON
 * logs. All envelopes share one resource (they originate from this host), so
 * they are grouped into a single resourceLogs entry. Best-effort: resolves to
 * true on a 2xx response, false on any non-2xx or network error; NEVER throws.
 *
 * @param {object[]} envelopes
 * @param {object}  opts
 * @param {string}  opts.endpoint        base URL; "/v1/logs" is appended
 * @param {object} [opts.headers={}]     extra request headers (k=v map)
 * @param {Function} [opts.fetchImpl=fetch] injectable fetch for tests
 * @returns {Promise<boolean>}
 */
export async function sendOtlp(envelopes, { endpoint, headers = {}, fetchImpl = fetch } = {}) {
  if (!endpoint || !Array.isArray(envelopes) || envelopes.length === 0) return false;
  // Strip any trailing slash so "<endpoint>/" and "<endpoint>" both yield one /v1/logs.
  const url = `${endpoint.replace(/\/+$/, "")}/v1/logs`;

  // The resource is identical across this host's envelopes; take it from the first.
  const resourceAttrs = otlpAttributes(envelopes[0].resource ?? {});
  const body = {
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [
          {
            scope: { name: "catalyst-agent" },
            logRecords: envelopes.map(envelopeToLogRecord),
          },
        ],
      },
    ],
  };

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const ok = res?.status >= 200 && res?.status < 300;
    if (!ok) log.warn({ status: res?.status }, "emit: OTLP POST non-2xx");
    return ok;
  } catch (err) {
    log.warn({ err: err?.message }, "emit: OTLP POST failed");
    return false;
  }
}

/**
 * emitEnvelope — route ONE already-built envelope through the transport(s) that
 * the resolved config selects. The single emit seam every domain sampler shares:
 *   eventlog → append a JSONL line to the monthly event log (Approach A)
 *   otlp     → POST it to <endpoint>/v1/logs (Approach B), fire-and-forget
 *   both     → do both
 * Best-effort: each transport is itself never-throw, and a rejected OTLP POST is
 * swallowed so a flaky collector never disrupts the tick. Returns nothing.
 *
 * @param {object} envelope  a buildAgentEnvelope() result
 * @param {object} config    a readAgentConfig() result (emit/otlpEndpoint/otlpHeaders)
 */
export function emitEnvelope(envelope, config) {
  if (config?.emit === "eventlog" || config?.emit === "both") {
    emitEventLog(envelope);
  }
  if (config?.emit === "otlp" || config?.emit === "both") {
    // Fire-and-forget: the OTLP POST is async and best-effort.
    Promise.resolve(
      sendOtlp([envelope], { endpoint: config.otlpEndpoint, headers: config.otlpHeaders }),
    ).catch(() => {});
  }
}

/**
 * makeBuilderEmit — adapt the config-aware emitEnvelope() to the (name, spec,
 * opts) "builder-style" emit signature that the host and usage samplers expect.
 * It builds the envelope from (name, spec, {now}) and routes it through the
 * configured transport(s), returning the envelope so the caller can inspect it.
 *
 * @param {object} config  a readAgentConfig() result
 * @returns {(name: string, spec: object, opts?: {now?: Function}) => object}
 */
export function makeBuilderEmit(config) {
  return (name, spec, opts) => {
    const envelope = buildAgentEnvelope(name, spec, opts);
    emitEnvelope(envelope, config);
    return envelope;
  };
}
