// process-memory-metric.mjs — CTL-1517. A zero-dep, never-throws OTLP/HTTP metrics
// emitter that makes PER-DAEMON memory attributable. Today only host-aggregate memory
// exists (catalyst-agent's system.memory.* gauges); there is no way to see which of the
// long-lived daemons (execution-core / broker / monitor / otel-forward / cloud-sync /
// updater) is holding the RSS. Each daemon calls emitProcessMemoryMetric() from its
// EXISTING heartbeat tick, fire-and-forget, and the collector fans the three gauges to
// Prometheus keyed by service_name (+ pid), so `sum by (service_name)` localizes a leak.
//
// SELF-CONTAINED: mirrors the hand-built OTLP/HTTP JSON POST in
// catalyst-agent/emit.mjs (sendOtlpMetrics) — NO @opentelemetry SDK / MeterProvider (the
// daemons share no Meter, and a static OTel import would crash consumers that don't
// install the deps, e.g. tracing.mjs's CTL-1338 lesson). node:* + global fetch only.
//
// THREE gauges, all unit "By" (bytes), official OTel semconv names so the collector's
// add_metric_suffixes yields process_memory_usage_bytes / process_memory_heap_used_bytes
// / process_memory_external_bytes in Prometheus:
//   process.memory.usage       ← process.memoryUsage().rss
//   process.memory.heap.used   ← process.memoryUsage().heapUsed
//   process.memory.external    ← process.memoryUsage().external
//
// IDENTITY: the resource is built by the shared buildCatalystResource({serviceName}) so
// service.name / host.name / host.id / catalyst.node.class match EVERY other catalyst
// signal (metrics, events, traces). service.name lives ONLY on the resource; pid lives
// ONLY on the data point (as a stringValue — cross-collector safe, never intValue), so
// there is no dual placement.
//
// NEVER-THROW: the whole emit is wrapped; a flaky/unreachable collector resolves the
// call to false and is swallowed by the fire-and-forget call sites. The no-op is LOUD:
// the daemon's own logger is threaded in and warn-once fires when the endpoint is
// unresolvable or POSTs fail repeatedly, so a dark gauge is never silent.

import { buildCatalystResource } from "../execution-core/lib/catalyst-resource.mjs";

// The shared OTel collector's OTLP/HTTP ingest. Same default tracing.mjs uses (which now
// imports resolveCollectorBase from here so the hardcoded fallback lives in ONE place).
// The shared-collector default, exported so tracing.mjs (which is off-by-default and
// wants to fall back to it) applies it AFTER resolveCollectorBase — while the per-process
// gauge does NOT, so an UNconfigured process (notably a unit test) emits nothing instead
// of posting test-process samples to the production collector (Codex P1 on #2732).
export const DEFAULT_COLLECTOR_BASE = "http://100.65.193.30:4318";

// Warn-once only after this many CONSECUTIVE failed POSTs, so a single transient blip is
// silent (and a genuinely-dark pipe is still loud). A success resets the counter.
const WARN_AFTER_CONSECUTIVE_FAILURES = 3;

// Bound the POST so a wedged/unroutable collector connect can never accumulate against the
// daemon (and can never slow a unit test that transitively fires this). Feature-detected.
const DEFAULT_POST_TIMEOUT_MS = 5_000;

/**
 * resolveCollectorBase — resolve the CONFIGURED OTLP collector base URL from the daemon
 * collector-ingest envs `OTEL_EXPORTER_OTLP_ENDPOINT` then `CATALYST_OTLP_ENDPOINT` (both
 * documented daemon envs per AGENTS.md); map the gRPC :4317 to the HTTP :4318; strip
 * trailing slashes. Returns null when NEITHER is set — the caller decides whether to fall
 * back to a default. The per-process gauge does NOT (an unconfigured process, e.g. a unit
 * test, emits nothing rather than posting test samples to the production collector under a
 * daemon service name — Codex P1 on #2732); tracing.mjs applies DEFAULT_COLLECTOR_BASE.
 * Pure; never throws.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null} configured base URL with no trailing slash, or null if unset
 */
export function resolveCollectorBase(env = process.env) {
  const raw = env && (env.OTEL_EXPORTER_OTLP_ENDPOINT || env.CATALYST_OTLP_ENDPOINT);
  if (!raw) return null;
  return String(raw)
    .replace(/:4317\b/, ":4318")
    .replace(/\/+$/, "");
}

// stringAttrs — map a flat { key: scalar } object (the resource block) to the OTLP
// KeyValue[] shape as stringValue. Resource attributes are all strings; null/undefined
// entries are dropped so the collector never promotes an empty label.
function stringAttrs(obj = {}) {
  const out = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    out.push({ key, value: { stringValue: String(value) } });
  }
  return out;
}

/**
 * buildProcessMemoryMetricsPayload — PURE builder for the OTLP/HTTP metrics request body.
 * Exposed so the shape (resource carries service.name + host; three gauges with the
 * semconv names + unit "By") is unit-testable without a network call. Mirrors emit.mjs's
 * asDouble single-type choice (a key must not oscillate int/double across ticks). Never
 * throws.
 *
 * The data points carry NO pid label: there is exactly one live process per (service_name,
 * host), so keying the series by pid would mint a NEW series on every daemon restart while
 * the dead pid's last-RSS series lingers until Prometheus staleness — and `sum by
 * (service_name)` would then double-count the terminated process during exactly the
 * restart / leak-attribution window (Codex P2 on #2732). Omitting pid makes the restarted
 * process reuse the same (service_name, host) series (last-value wins), so the aggregation
 * always reflects only the running process.
 *
 * @param {object} spec
 * @param {string} spec.serviceName        catalyst.* service name → resource service.name
 * @param {NodeJS.MemoryUsage} spec.memoryUsage  a process.memoryUsage() snapshot
 * @param {string|number} spec.timeUnixNano  data-point timestamp in ns
 * @param {string} [spec.host]             optional host override forwarded to the resource
 * @returns {object} the { resourceMetrics: [...] } OTLP JSON body
 */
export function buildProcessMemoryMetricsPayload({ serviceName, memoryUsage, timeUnixNano, host } = {}) {
  const resource = buildCatalystResource(host !== undefined ? { serviceName, host } : { serviceName });
  const t = String(timeUnixNano ?? "");
  const gauge = (name, value) => ({
    name,
    unit: "By",
    gauge: {
      dataPoints: [
        {
          timeUnixNano: t,
          asDouble: typeof value === "number" && Number.isFinite(value) ? value : 0,
        },
      ],
    },
  });
  return {
    resourceMetrics: [
      {
        resource: { attributes: stringAttrs(resource) },
        scopeMetrics: [
          {
            scope: { name: "catalyst-process-memory" },
            metrics: [
              gauge("process.memory.usage", memoryUsage?.rss),
              gauge("process.memory.heap.used", memoryUsage?.heapUsed),
              gauge("process.memory.external", memoryUsage?.external),
            ],
          },
        ],
      },
    ],
  };
}

// Per-serviceName failure/warn state (module scope → per-process; each daemon is its own
// process so the map only ever holds its own key). __resetProcessMemoryMetricState clears
// it for tests.
const _failState = new Map();
const _unresolvableWarned = new Set();

/** __resetProcessMemoryMetricState — test seam; clear the warn-once/failure bookkeeping. */
export function __resetProcessMemoryMetricState() {
  _failState.clear();
  _unresolvableWarned.clear();
}

function warnOnce(log, message, fields) {
  try {
    log?.warn?.({ hb: true, ...fields }, message);
  } catch {
    /* logging must never throw */
  }
}

function noteResult(log, serviceName, ok, reason) {
  const s = _failState.get(serviceName) || { fails: 0, warned: false };
  if (ok) {
    if (s.fails || s.warned) {
      s.fails = 0;
      s.warned = false;
      _failState.set(serviceName, s);
    }
    return;
  }
  s.fails += 1;
  if (s.fails >= WARN_AFTER_CONSECUTIVE_FAILURES && !s.warned) {
    s.warned = true;
    warnOnce(log, "process-memory-metric: OTLP metrics POST failing repeatedly — per-process memory gauge is dark", {
      component: serviceName,
      consecutiveFailures: s.fails,
      reason: reason ?? "unknown",
    });
  }
  _failState.set(serviceName, s);
}

/**
 * emitProcessMemoryMetric — sample process.memoryUsage() and fire ONE OTLP/HTTP metrics
 * POST to <collector>/v1/metrics. Fire-and-forget from a daemon's heartbeat tick: NEVER
 * throws, NEVER blocks (returns a promise the caller ignores). Resolves true on a 2xx,
 * false otherwise.
 *
 * @param {object} opts
 * @param {string}   opts.serviceName        catalyst.* service name (required)
 * @param {{warn?:Function}} [opts.log]      the daemon's logger — threaded so the no-op is loud
 * @param {Record<string,string|undefined>} [opts.env]  endpoint-resolution env (default process.env)
 * @param {Function} [opts.fetchImpl]        injectable fetch (default global fetch)
 * @param {string}   [opts.host]             optional host override for the resource
 * @param {Function} [opts.now]              injectable epoch-ms clock (default Date.now)
 * @param {number}   [opts.timeoutMs]        POST abort budget (default 5s)
 * @returns {Promise<boolean>}
 */
export async function emitProcessMemoryMetric({
  serviceName,
  log,
  env = process.env,
  fetchImpl = globalThis.fetch,
  host,
  now = Date.now,
  timeoutMs = DEFAULT_POST_TIMEOUT_MS,
} = {}) {
  try {
    if (!serviceName || typeof fetchImpl !== "function") return false;
    const base = resolveCollectorBase(env);
    if (!base) {
      // No configured collector endpoint (OTEL_EXPORTER_OTLP_ENDPOINT /
      // CATALYST_OTLP_ENDPOINT). The gauge deliberately has NO live default, so an
      // unconfigured process — notably a unit test that transitively fires this — emits
      // nothing rather than posting test samples to the production collector (Codex P1).
      // Warn once so a genuinely-misconfigured daemon is loud.
      if (!_unresolvableWarned.has(serviceName)) {
        _unresolvableWarned.add(serviceName);
        warnOnce(log, "process-memory-metric: no collector endpoint configured (OTEL_EXPORTER_OTLP_ENDPOINT / CATALYST_OTLP_ENDPOINT) — per-process memory gauge disabled", {
          component: serviceName,
        });
      }
      return false;
    }
    const url = `${base}/v1/metrics`;
    const payload = buildProcessMemoryMetricsPayload({
      serviceName,
      memoryUsage: process.memoryUsage(),
      timeUnixNano: now() * 1_000_000,
      host,
    });
    const opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
    try {
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        opts.signal = AbortSignal.timeout(timeoutMs);
      }
    } catch {
      /* no bounded signal available — proceed unbounded */
    }
    const res = await fetchImpl(url, opts);
    const ok = res?.status >= 200 && res?.status < 300;
    noteResult(log, serviceName, ok, ok ? undefined : `non-2xx status ${res?.status}`);
    return ok;
  } catch (err) {
    noteResult(log, serviceName, false, err?.message);
    return false;
  }
}
