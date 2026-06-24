// tracing.mjs — CTL-1330 Tier 3: OTLP span export for the catalyst daemons.
//
// WHY: Tier-1 logs (tick timing / event-loop delay / liveness refresh) DETECT and
// LOCALIZE the dispatch wedge ("which pass blocks the loop"). Tier-3 spans EXPLAIN it —
// a flame graph of one tick, root `scheduler.tick` with the offending `scheduler.pass`
// child eating the whole bar. Producer side for the OTL-25 Tempo sink.
//
// HARD RULES (the whole point would be self-defeating otherwise):
//   * OFF by default — CATALYST_TRACING=on per process (off-first rollout). off+restart
//     fully disables it with no code change.
//   * BatchSpanProcessor ONLY. A synchronous exporter on the tick would reintroduce the
//     exact CTL-790 event-loop wedge this instrumentation exists to diagnose.
//   * AlwaysOn SDK sampler (the SDK default) — ALL sampling is deferred to the OTEL
//     collector's tail_sampling (keeps 100% slow>1s + errors, 20% rest). RED metrics come
//     from the unsampled Tier-1 logs, so trace sampling never undercounts them.
//   * Every entry point is wrapped in try/catch — a missing/incompatible SDK (the Bun
//     `monitorEventLoopDelay` lesson) degrades to "no spans", never crashes the daemon.
//
// The tick is SYNCHRONOUS, so its spans are reconstructed POST-HOC from the recorded lap
// timings (explicit start/end timestamps) — no block-wrapping, no per-span work inside the
// hot loop. See emitTickTrace.

import { hostname as osHostname } from "node:os";
import { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";

let _enabled = false;
let _provider = null;
let _tracer = null;

// tracingEnabled — the per-process master switch. OFF unless explicitly "on".
export function tracingEnabled(env = process.env) {
  return env.CATALYST_TRACING === "on";
}

// shortHostName — the OS hostname's first DNS label. CTL data-quality finding: the
// daemon .log path emits FQDN host.name (mini-2.rozich) while metrics/canonical-events use
// the SHORT form (mini-2, the CTL-1252 collapse), so logs↔metrics↔traces won't join on host
// unless every signal uses the SAME canonical short form. Spans use short to join cleanly.
function shortHostName() {
  try {
    return osHostname().split(".")[0];
  } catch {
    return "unknown";
  }
}

// resolveNodeName — match getHostName() in config.mjs so spans tag the SAME stable node
// name as the logs (CATALYST_HOST_NAME, else the short OS hostname).
function resolveNodeName(env) {
  return env.CATALYST_HOST_NAME || shortHostName();
}

// initTracing — construct the provider + OTLP/HTTP exporter + BatchSpanProcessor ONCE.
// Idempotent; a no-op when disabled or already initialized. NEVER throws.
export async function initTracing({ serviceName, env = process.env } = {}) {
  if (_enabled) return true;
  if (!tracingEnabled(env)) return false;
  try {
    const { BasicTracerProvider, BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_NAMESPACE } = await import("@opentelemetry/semantic-conventions");

    // Same collector otel-forward uses. OTEL_EXPORTER_OTLP_ENDPOINT is the base (otel-forward
    // maps :4317->:4318 for HTTP); we append /v1/traces. Traces to this endpoint route to
    // Tempo-only (OTL-25). Default to the shared Tailscale collector.
    const base = (env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://100.65.193.30:4318")
      .replace(/:4317\b/, ":4318")
      .replace(/\/$/, "");
    const exporter = new OTLPTraceExporter({ url: `${base}/v1/traces` });

    _provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        // service.namespace + the SHORT host.name are the canonical cross-signal join keys
        // (CTL data-quality finding) — traces previously carried neither.
        [ATTR_SERVICE_NAMESPACE]: "catalyst",
        "host.name": shortHostName(),
        "catalyst.node.name": resolveNodeName(env),
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(_provider);
    _tracer = trace.getTracer(serviceName);
    _enabled = true;

    // Flush on exit so a wedge tick's spans aren't lost on a restart. Best-effort.
    const flush = () => {
      try {
        _provider?.forceFlush?.();
      } catch {
        /* best-effort */
      }
    };
    process.once("SIGTERM", flush);
    process.once("SIGINT", flush);
    process.once("beforeExit", flush);
    return true;
  } catch {
    _enabled = false;
    _provider = null;
    _tracer = null;
    return false;
  }
}

// shutdownTracing — flush + tear down (test seam + graceful daemon stop).
export async function shutdownTracing() {
  if (!_provider) return;
  try {
    await _provider.forceFlush();
    await _provider.shutdown();
  } catch {
    /* best-effort */
  }
  _enabled = false;
  _provider = null;
  _tracer = null;
}

export function getTracer() {
  return _enabled ? _tracer : null;
}

// __setTracerForTest — inject a tracer (e.g. backed by InMemorySpanExporter) so the
// span-emit helpers can be unit-tested without a real OTLP collector. Pass null to clear.
export function __setTracerForTest(tracer) {
  _tracer = tracer;
  _enabled = tracer != null;
}

// emitTickTrace — build the post-hoc span tree for ONE completed scheduler tick from the
// recorded lap timings. Root `scheduler.tick` (INTERNAL) + a `scheduler.pass` child ONLY
// for passes over slowPassThresholdMs (semconv hygiene: <10 INTERNAL / <20 sub-5ms spans
// per trace — a healthy tick is 1 span; a wedged tick shows exactly the offending passes).
// `laps` = [{name, durationMs, startEpochMs, endEpochMs}]. `attrs` = flat span attributes.
// Never throws.
export function emitTickTrace({ tickId, startEpochMs, endEpochMs, laps = [], attrs = {}, slowPassThresholdMs = 50 } = {}) {
  const tracer = getTracer();
  if (!tracer) return;
  try {
    const root = tracer.startSpan("scheduler.tick", { kind: SpanKind.INTERNAL, startTime: startEpochMs });
    if (tickId != null) root.setAttribute("catalyst.scheduler.tick_id", tickId);
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null) root.setAttribute(k, v);
    }
    const rootCtx = trace.setSpan(context.active(), root);
    for (const lap of laps) {
      if (lap && lap.durationMs >= slowPassThresholdMs) {
        const child = tracer.startSpan(
          "scheduler.pass",
          { kind: SpanKind.INTERNAL, startTime: lap.startEpochMs },
          rootCtx
        );
        child.setAttribute("catalyst.scheduler.pass", lap.name);
        child.setAttribute("catalyst.scheduler.pass.duration_ms", lap.durationMs);
        child.end(lap.endEpochMs);
      }
    }
    root.end(endEpochMs);
  } catch {
    /* observability must never throw out of the tick */
  }
}

// emitLivenessRefreshSpan — a standalone span for one async claude-agents liveness
// refresh. ERROR status on timeout — the span that visually shows "aborted at the
// deadline because the tick blocked the loop". A root span (not a child of the tick:
// the refresh runs in its own async context, fire-and-forget from getAgentsCached;
// cross-process/async parenting is Phase 2). startEpochMs/endEpochMs are epoch ms.
export function emitLivenessRefreshSpan({ outcome, startEpochMs, endEpochMs, deadlineMs, populated, ageMs } = {}) {
  const tracer = getTracer();
  if (!tracer) return;
  try {
    const span = tracer.startSpan("liveness.refresh", { kind: SpanKind.INTERNAL, startTime: startEpochMs });
    if (outcome != null) span.setAttribute("catalyst.liveness.outcome", outcome);
    if (deadlineMs != null) span.setAttribute("catalyst.liveness.deadline_ms", deadlineMs);
    if (populated != null) span.setAttribute("catalyst.liveness.populated", populated);
    if (ageMs != null) span.setAttribute("catalyst.liveness.age_ms", ageMs);
    if (outcome === "timeout") {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: `liveness refresh timed out at ${deadlineMs}ms — the synchronous tick blocked the event loop past the deadline`,
      });
    }
    span.end(endEpochMs);
  } catch {
    /* observability must never throw */
  }
}

// Re-export the api primitives callers need so they don't each import @opentelemetry/api.
export { trace, context, SpanKind, SpanStatusCode };
