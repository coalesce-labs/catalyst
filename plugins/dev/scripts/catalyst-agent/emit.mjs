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
import { hostName, hostId } from "../execution-core/lib/host-identity.mjs";

// shortHostname — os.hostname() with the macOS-appended ".local" suffix
// stripped, matching the hostname Claude Code's native OTel emits
// ("Ryans-MacBook-Pro-2", not "Ryans-MacBook-Pro-2.local") — so the
// dashboard's hostname labels, template variable, and filters see exactly ONE
// identity per machine (CTL-812 multi-host finding).
export function shortHostname() {
  return hostname().replace(/\.local$/, "");
}

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
      hostname: shortHostname(),
      "host.name": hostName(),
      "host.id": hostId(),
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
// (typeof true === "boolean"); everything else stringifies. Null/undefined never
// reach here (filtered by the put() pattern upstream) but are coerced to an empty
// string defensively.
//
// NUMERIC TYPE CHOICE (CTL-812 review): every number maps to doubleValue, never
// intValue. The samplers round metrics to 1-3 decimals, so the SAME attribute key
// (e.g. host.cpu_pct) would otherwise oscillate between intValue (when it rounds
// to a whole number like 50) and doubleValue (50.5) across ticks — an int/double
// type oscillation per key that strict OTLP consumers can reject. doubleValue is
// a valid representation for every JS number (an integer-valued double is still a
// number to Loki / the catalyst-otel collector), so pinning one type per key is
// the safe, deterministic choice. (The sibling otel-forward collector forces
// intValue even for fractional values, which is technically invalid OTLP; we go
// the other, always-valid way.)
function otlpAnyValue(value) {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") return { doubleValue: value };
  return { stringValue: value == null ? "" : String(value) };
}

// otlpAttributes — map a flat { key: scalar } object to the OTLP KeyValue[] shape.
function otlpAttributes(obj) {
  return Object.entries(obj).map(([key, value]) => ({ key, value: otlpAnyValue(value) }));
}

// envelopeToLogRecord — map one catalyst-agent envelope to an OTLP logRecord.
// timeUnixNano is derived from the envelope ts (ms → ns); severity carries
// through as INFO/9; the dot-form attributes become OTLP attributes.
//
// CTL-812 BODY CONVENTION: the body is the bare event name — exactly what
// otel-forward emits for the same envelope (body.message ?? event.name). The
// catalyst-otel dashboards match events with LogQL line filters
// (|= "host.metrics.sampled"), so the direct-OTLP path must produce the same
// line or every panel silently misses Approach-B events. The high-cardinality
// body.payload mirror stays local to the event log on purpose.
function envelopeToLogRecord(envelope) {
  const ms = Date.parse(envelope.ts);
  const timeUnixNano = String((Number.isFinite(ms) ? ms : Date.now()) * 1_000_000);
  return {
    timeUnixNano,
    observedTimeUnixNano: timeUnixNano,
    severityNumber: 9,
    severityText: "INFO",
    body: { stringValue: envelope.attributes?.["event.name"] ?? "" },
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
 *   otlp     → POST it to <endpoint>/v1/logs (Approach B)
 *   both     → do both
 * Best-effort: each transport is itself never-throw, and a rejected OTLP POST is
 * swallowed so a flaky collector never disrupts the tick.
 *
 * RETURNS the pending OTLP POST promise (or null when no POST was issued) so the
 * caller can AWAIT it before the process exits. This is load-bearing for the
 * primary `--once` / launchd path: emit is not fire-and-forget — if the caller
 * exited without awaiting, an in-flight POST would be killed by process.exit()
 * and the telemetry dropped on every tick (CTL-812 review). The promise itself
 * already swallows rejections (resolves to true/false), so awaiting it is safe.
 *
 * @param {object} envelope  a buildAgentEnvelope() result
 * @param {object} config    a readAgentConfig() result (emit/otlpEndpoint/otlpHeaders)
 * @returns {Promise<boolean>|null} the OTLP POST promise, or null for eventlog-only
 */
export function emitEnvelope(envelope, config) {
  if (config?.emit === "eventlog" || config?.emit === "both") {
    emitEventLog(envelope);
  }
  if (config?.emit === "otlp" || config?.emit === "both") {
    // sendOtlp is itself never-throw (resolves true/false), but guard the
    // .catch defensively so a synchronous throw could never escape either.
    return Promise.resolve(
      sendOtlp([envelope], { endpoint: config.otlpEndpoint, headers: config.otlpHeaders }),
    ).catch(() => false);
  }
  return null;
}

/**
 * makeBuilderEmit — adapt the config-aware emitEnvelope() to the (name, spec,
 * opts) "builder-style" emit signature that the host and usage samplers expect.
 * It builds the envelope from (name, spec, {now}) and routes it through the
 * configured transport(s), returning the envelope so the caller can inspect it.
 *
 * The pending OTLP POST promise (if any) is collected into `pending` so the
 * caller can drain it before exiting — see drainPending(). Without this, the
 * `--once` path would exit while POSTs are still in flight (CTL-812 review).
 *
 * @param {object}   config           a readAgentConfig() result
 * @param {object}   [opts]
 * @param {Array}    [opts.pending]    array the emit pushes each OTLP promise into
 * @returns {(name: string, spec: object, opts?: {now?: Function}) => object}
 */
export function makeBuilderEmit(config, { pending } = {}) {
  return (name, spec, opts) => {
    const envelope = buildAgentEnvelope(name, spec, opts);
    const posted = emitEnvelope(envelope, config);
    if (posted && Array.isArray(pending)) pending.push(posted);
    return envelope;
  };
}

/**
 * drainPending — await every collected OTLP POST promise so an in-flight POST is
 * never abandoned by process.exit() in the `--once` path. Each promise already
 * resolves (never rejects) to true/false, so Promise.allSettled is belt-and-
 * braces. Returns nothing; NEVER throws.
 *
 * @param {Array<Promise<*>>} [pending]
 */
export async function drainPending(pending) {
  if (!Array.isArray(pending) || pending.length === 0) return;
  try {
    await Promise.allSettled(pending);
  } catch {
    /* never throw — drain is best-effort */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// OTLP METRICS (CTL-1227) — the agent's second transport. Unlike the event/log
// path above (custom catalyst.* attributes → Loki labels), metrics are emitted
// to the collector's METRICS pipeline (OTLP /v1/metrics → Prometheus) using
// OpenTelemetry SEMANTIC CONVENTIONS (system.cpu.*, system.memory.*,
// system.filesystem.*; https://opentelemetry.io/docs/specs/semconv/system/).
// Values are bytes / ratios per semconv (NOT the GB / percent the legacy event
// uses). All best-effort, NEVER-throw — a flaky collector must not sink a tick.
//
// NUMERIC TYPE: every data point uses asDouble (same single-type rationale as the
// log path's otlpAnyValue — a key must not oscillate int/double across ticks).

// metricResource — the same host/service identity the log envelope carries, so
// metrics and events share one resource on the dashboards.
export function metricResource() {
  return {
    "service.name": "catalyst.agent",
    "service.namespace": "catalyst",
    hostname: shortHostname(),
    "host.name": hostName(),
    "host.id": hostId(),
  };
}

// dropNullAttrs — the put() pattern for metric data-point attributes: an attr is
// included ONLY when non-null/defined (so an unknown system.filesystem.type etc.
// is omitted rather than emitted as an empty label).
function dropNullAttrs(attrs = {}) {
  const out = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/**
 * otlpMetric — build ONE OTLP metric JSON object (semconv-shaped).
 * @param {object} m
 * @param {string} m.name        e.g. "system.filesystem.usage"
 * @param {string} [m.unit]      UCUM unit, e.g. "By" (bytes), "1" (ratio)
 * @param {string} [m.description]
 * @param {"gauge"|"sum"} m.kind gauge → Gauge; sum → (UpDown)Counter
 * @param {boolean} [m.monotonic=false] for kind:"sum" (usage/limit are non-monotonic)
 * @param {Array<{value:number, attrs?:object, timeUnixNano:string}>} m.points
 *        points whose value is null/non-finite are dropped; a metric with no
 *        surviving points returns null (and is filtered by build* callers).
 * @returns {object|null}
 */
export function otlpMetric({ name, unit = "", description = "", kind, monotonic = false, points = [] }) {
  const dataPoints = (points ?? [])
    .filter((p) => p && typeof p.value === "number" && Number.isFinite(p.value))
    .map((p) => ({
      timeUnixNano: String(p.timeUnixNano ?? ""),
      asDouble: p.value,
      attributes: otlpAttributes(dropNullAttrs(p.attrs)),
    }));
  if (dataPoints.length === 0) return null;
  const data =
    kind === "sum"
      ? { sum: { dataPoints, aggregationTemporality: 2 /* CUMULATIVE */, isMonotonic: monotonic } }
      : { gauge: { dataPoints } };
  return { name, unit, description, ...data };
}

/**
 * sendOtlpMetrics — POST a batch of OTLP metrics to <endpoint>/v1/metrics as
 * OTLP/HTTP JSON. Best-effort: true on 2xx, false otherwise; NEVER throws.
 * @param {object[]} metrics  otlpMetric() results (nulls are filtered here too)
 */
export async function sendOtlpMetrics(
  metrics,
  { endpoint, headers = {}, fetchImpl = fetch, resource = metricResource() } = {},
) {
  const list = (Array.isArray(metrics) ? metrics : []).filter(Boolean);
  if (!endpoint || list.length === 0) return false;
  const url = `${endpoint.replace(/\/+$/, "")}/v1/metrics`;
  const body = {
    resourceMetrics: [
      {
        resource: { attributes: otlpAttributes(resource) },
        scopeMetrics: [{ scope: { name: "catalyst-agent" }, metrics: list }],
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
    if (!ok) log.warn({ status: res?.status }, "emit: OTLP metrics POST non-2xx");
    return ok;
  } catch (err) {
    log.warn({ err: err?.message }, "emit: OTLP metrics POST failed");
    return false;
  }
}

/**
 * emitMetrics — POST a metric batch to the collector's metrics pipeline whenever a
 * metrics endpoint is resolvable. DECOUPLED from the event `emit` mode (CTL-1227):
 * metrics have no eventlog representation — they only make sense via OTLP /v1/metrics
 * — so unlike events (which can ship to the event log + be forwarded), metrics are
 * gated purely on `config.metricsEndpoint` (falling back to `otlpEndpoint`). Returns
 * the pending POST promise (for drainPending) or null when no endpoint is set. NEVER
 * throws.
 */
export function emitMetrics(metrics, config) {
  const endpoint = config?.metricsEndpoint || config?.otlpEndpoint;
  if (!endpoint) return null;
  return Promise.resolve(
    sendOtlpMetrics(metrics, { endpoint, headers: config?.otlpHeaders }),
  ).catch(() => false);
}
