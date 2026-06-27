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
import { createRequire } from "node:module";
import { nodeClass } from "./lib/node-class.mjs";

// CTL-1338: load @opentelemetry/api via createRequire (synchronous — the emit helpers
// below use trace/context/SpanKind/SpanStatusCode on the sync tick path) wrapped in
// try/catch so a MISSING dep degrades to no-op instead of crashing on module load. This
// honors the "missing SDK → no spans, never crash" invariant above — a STATIC
// `import ... from "@opentelemetry/api"` violated it: any importer of scheduler.mjs (e.g.
// orch-monitor's quality `bun test`, which uses scheduler.mjs's pure helpers but does NOT
// install the OTel deps) crashed on module load. The other four OTel packages are already
// lazy-loaded inside initTracing; only `api` was static, inconsistently.
let trace, context, SpanKind, SpanStatusCode, TraceFlags;
try {
  // CTL-1337: TraceFlags joins the lazy-loaded set — emitTickTrace seeds the root
  // scheduler.tick span with a deterministic per-tick parent SpanContext
  // ({traceId, spanId, traceFlags: SAMPLED, isRemote}) so the span's trace_id
  // equals the one stamped on the Tier-1 tick-timing log line (exact per-tick
  // trace↔logs round-trip). Loaded the SAME try/catch way as the rest so a missing
  // api degrades to the existing random-id behavior, never crashes.
  ({ trace, context, SpanKind, SpanStatusCode, TraceFlags } = createRequire(import.meta.url)("@opentelemetry/api"));
} catch {
  // @opentelemetry/api not installed in this consumer's context — tracing stays a no-op.
}

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

// buildTracingResource — CTL-1365a: the trace RESOURCE attribute object, factored
// out so the dispatch-mode dimension is unit-testable WITHOUT standing up an OTLP
// provider. service.name / service.namespace + the SHORT host.name are the
// canonical cross-signal join keys (CTL data-quality finding). catalyst.dispatch.mode
// rides the resource so Tempo splits traces via resource.catalyst.dispatch.mode —
// deliberately NOT promoted onto metrics (the tick-timing log field is the metric
// source; promoting the resource attr too re-triggers the OTL-20 duplicate-label
// collision that silently drops the metric). Pure; never throws. ATTR_SERVICE_NAME /
// ATTR_SERVICE_NAMESPACE are literally "service.name" / "service.namespace".
export function buildTracingResource({ serviceName, dispatchMode = "phase-agents", env = process.env } = {}) {
  return {
    "service.name": serviceName,
    "service.namespace": "catalyst",
    "host.name": shortHostName(),
    "catalyst.node.name": resolveNodeName(env),
    "catalyst.dispatch.mode": dispatchMode,
    "catalyst.node.class": nodeClass(),
  };
}

// initTracing — construct the provider + OTLP/HTTP exporter + BatchSpanProcessor ONCE.
// Idempotent; a no-op when disabled or already initialized. NEVER throws.
// CTL-1365a: `dispatchMode` is the catalyst.dispatch.mode telemetry vocab
// ({phase-agents | oneshot-legacy | sdk}) the daemon resolves once from the
// executor flag. It rides the trace RESOURCE so Tempo splits traces via
// `resource.catalyst.dispatch.mode` — deliberately NOT promoted onto metrics
// (the log field on the tick line is the metric source; promoting the resource
// attr too re-triggers the OTL-20 duplicate-label collision that drops the
// metric). OFF-safe: reading the string is the only new work when tracing is off;
// the SDK/provider work below still short-circuits on the tracingEnabled gate.
export async function initTracing({ serviceName, dispatchMode = "phase-agents", env = process.env } = {}) {
  if (_enabled) return true;
  if (!tracingEnabled(env)) return false;
  try {
    const { BasicTracerProvider, BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");

    // Same collector otel-forward uses. OTEL_EXPORTER_OTLP_ENDPOINT is the base (otel-forward
    // maps :4317->:4318 for HTTP); we append /v1/traces. Traces to this endpoint route to
    // Tempo-only (OTL-25). Default to the shared Tailscale collector.
    const base = (env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://100.65.193.30:4318")
      .replace(/:4317\b/, ":4318")
      .replace(/\/$/, "");
    const exporter = new OTLPTraceExporter({ url: `${base}/v1/traces` });

    _provider = new BasicTracerProvider({
      // CTL-1365a: resource attrs (incl. catalyst.dispatch.mode) built by the pure,
      // unit-tested buildTracingResource helper. service.namespace + the SHORT
      // host.name are the canonical cross-signal join keys (CTL data-quality finding).
      resource: resourceFromAttributes(buildTracingResource({ serviceName, dispatchMode, env })),
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
//
// CTL-1337: when `traceId` (32 hex) + `spanId` (16 hex) are passed, the root span is
// started in a context whose ACTIVE span is a deterministic per-tick parent SpanContext
// ({traceId, spanId, traceFlags: SAMPLED, isRemote:true}). The SDK then inherits that
// traceId for the root (root.spanContext().traceId === traceId), so the span's trace_id
// equals the per-tick id stamped on the Tier-1 `scheduler: tick timing` log line —
// trace↔logs round-trips both ways. The per-tick id is DISTINCT per tick (it folds in the
// tick_id), so this does NOT collapse the daemon's lifetime into one trace. Omit the ids
// (or run without a usable @opentelemetry/api) and the SDK assigns a random trace_id as
// before — degrade, never crash.
// CTL-1364: `ops` adds the THIRD span tier — scheduler.tick → scheduler.pass →
// scheduler.op — so a slow tick's flame graph auto-attributes its time to the EXACT
// operation (e.g. a recovery-filter terminal-read that shelled out to a 429-stalled
// linearis for 15s). `ops` = [{pass, name, startEpochMs, endEpochMs, durationMs,
// attrs}], each gated by `opThresholdMs` (env CATALYST_TRACING_OP_THRESHOLD_MS, default
// 50ms) — a healthy op (cache/gateway hit, fast exec) emits NO span. Span-name
// cardinality stays flat: exactly 3 names total ("scheduler.tick"/"pass"/"op"); op
// identity (terminal-read / sweep / ticket) rides ATTRIBUTES, never the name.
export function emitTickTrace({ tickId, startEpochMs, endEpochMs, laps = [], attrs = {}, slowPassThresholdMs = 50, opThresholdMs = 50, ops = [], traceId, spanId } = {}) {
  const tracer = getTracer();
  if (!tracer) return;
  try {
    // CTL-1364: CATALYST_TRACING_OP_THRESHOLD_MS overrides the op threshold without a
    // code change (lower it to capture more ops while diagnosing a wedge). The env
    // wins when set to a valid non-negative number; otherwise the param default holds.
    const envOp = Number(process.env.CATALYST_TRACING_OP_THRESHOLD_MS);
    const opFloor =
      Number.isFinite(envOp) && envOp >= 0 && process.env.CATALYST_TRACING_OP_THRESHOLD_MS !== ""
        ? envOp
        : opThresholdMs;
    // CTL-1337: seed the per-tick parent SpanContext so the root inherits `traceId`.
    // Falls back to context.active() (→ SDK-random trace_id) if ids are absent or the
    // api primitives needed for the seed aren't available.
    let startCtx = context.active();
    if (traceId && spanId && TraceFlags && typeof trace.setSpanContext === "function") {
      startCtx = trace.setSpanContext(startCtx, {
        traceId,
        spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      });
    }
    const root = tracer.startSpan("scheduler.tick", { kind: SpanKind.INTERNAL, startTime: startEpochMs }, startCtx);
    if (tickId != null) root.setAttribute("catalyst.scheduler.tick_id", tickId);
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null) root.setAttribute(k, v);
    }
    const rootCtx = trace.setSpan(context.active(), root);
    // CTL-1364: index pass-name → {span, ctx} so op children parent to their pass span.
    // A pass span is created when the pass crosses slowPassThresholdMs (today's behavior);
    // the op loop below ALSO creates it on-demand if an op crosses opFloor inside a pass
    // that was itself below the slow threshold (so the op always has a parent).
    const passIndex = new Map();
    for (const lap of laps) {
      if (lap && lap.durationMs >= slowPassThresholdMs) {
        const child = tracer.startSpan(
          "scheduler.pass",
          { kind: SpanKind.INTERNAL, startTime: lap.startEpochMs },
          rootCtx
        );
        child.setAttribute("catalyst.scheduler.pass", lap.name);
        child.setAttribute("catalyst.scheduler.pass.duration_ms", lap.durationMs);
        passIndex.set(lap.name, { span: child, ctx: trace.setSpan(rootCtx, child) });
      }
    }
    // CTL-1364: scheduler.op grandchildren. One INTERNAL span per op >= opFloor,
    // parented to its pass span (creating that pass span on-demand if the pass itself
    // was sub-threshold). ERROR status when the op timed out. Whole loop is inside the
    // outer try/catch — a throw here never escapes the tick.
    for (const op of ops) {
      if (!op || !(op.durationMs >= opFloor)) continue;
      let parent = passIndex.get(op.pass);
      if (!parent) {
        // EDGE CASE: the parent pass was below the slow-pass threshold (no pass child
        // created) but this op crosses opFloor — create the pass child on-demand so the
        // op nests correctly. Find the lap for timing; fall back to the op's own window.
        const lap = laps.find((l) => l && l.name === op.pass);
        const passSpan = tracer.startSpan(
          "scheduler.pass",
          { kind: SpanKind.INTERNAL, startTime: lap ? lap.startEpochMs : op.startEpochMs },
          rootCtx
        );
        passSpan.setAttribute("catalyst.scheduler.pass", op.pass);
        if (lap) passSpan.setAttribute("catalyst.scheduler.pass.duration_ms", lap.durationMs);
        parent = { span: passSpan, ctx: trace.setSpan(rootCtx, passSpan), onDemand: true, lap };
        passIndex.set(op.pass, parent);
      }
      const opSpan = tracer.startSpan(
        "scheduler.op",
        { kind: SpanKind.INTERNAL, startTime: op.startEpochMs },
        parent.ctx
      );
      opSpan.setAttribute("catalyst.scheduler.op", op.name);
      opSpan.setAttribute("catalyst.scheduler.pass", op.pass);
      opSpan.setAttribute("catalyst.scheduler.op.duration_ms", op.durationMs);
      const opAttrs = op.attrs || {};
      for (const [k, v] of Object.entries(opAttrs)) {
        if (v != null) opSpan.setAttribute(k, v);
      }
      if (opAttrs["op.timed_out"] === true || opAttrs["catalyst.scheduler.op.timed_out"] === true) {
        opSpan.setStatus({
          code: SpanStatusCode.ERROR,
          message: `scheduler op ${op.name} timed out`,
        });
      }
      opSpan.end(op.endEpochMs);
    }
    // CTL-1364: end every pass span (including the on-demand ones). Use the lap's
    // recorded end if known, else the op-derived end already on the on-demand span's
    // start window — close at the latest known boundary.
    for (const [name, entry] of passIndex) {
      const lap = laps.find((l) => l && l.name === name);
      entry.span.end(lap ? lap.endEpochMs : endEpochMs);
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

// emitUpdaterRefreshSpan — CTL-1350 Tier 3: a span tree for ONE catalyst-updater
// refresh cycle (the standalone plugin-pull daemon, CTL-1348). Root `updater.refresh`
// (INTERNAL) with a `updater.checkout` child ONLY for a checkout that changed or failed
// — same span-hygiene rule as emitTickTrace (a clean refresh where everything is already
// up to date is exactly 1 span; a refresh that pulled or failed shows the offending
// checkouts). The git fetch/reset granularity is intentionally NOT a child span here: it
// lives inside refreshPluginCheckout on the shared broker pull path, which this daemon
// must not mutate — so children are reconstructed POST-HOC from the per-root results.
//
// When `traceId` (32 hex) + `spanId` (16 hex) are passed, the root is seeded with a
// deterministic parent SpanContext so the span's trace_id equals the id stamped on the
// updater's refresh log line (trace↔logs round-trip), exactly as emitTickTrace does.
// `results` = the refreshPluginCheckout result array
// ([{root, changed, failed, oldSha, newSha}]). Never throws.
export function emitUpdaterRefreshSpan({ reason, startEpochMs, endEpochMs, roots, pulled, changed, failed, results = [], traceId, spanId } = {}) {
  const tracer = getTracer();
  if (!tracer) return;
  try {
    let startCtx = context.active();
    if (traceId && spanId && TraceFlags && typeof trace.setSpanContext === "function") {
      startCtx = trace.setSpanContext(startCtx, {
        traceId,
        spanId,
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      });
    }
    const root = tracer.startSpan("updater.refresh", { kind: SpanKind.INTERNAL, startTime: startEpochMs }, startCtx);
    if (reason != null) root.setAttribute("catalyst.updater.reason", reason);
    if (roots != null) root.setAttribute("catalyst.updater.roots", roots);
    if (pulled != null) root.setAttribute("catalyst.updater.pulled", pulled);
    if (changed != null) root.setAttribute("catalyst.updater.changed", changed);
    if (failed != null) root.setAttribute("catalyst.updater.failed", failed);
    const rootCtx = trace.setSpan(context.active(), root);
    // Child span only for a checkout that actually changed or failed (hygiene: a
    // no-op refresh stays a single span; a wedged checkout shows exactly itself).
    for (const r of results) {
      if (!r || !(r.changed || r.failed)) continue;
      const child = tracer.startSpan("updater.checkout", { kind: SpanKind.INTERNAL, startTime: startEpochMs }, rootCtx);
      if (r.root != null) child.setAttribute("catalyst.updater.checkout", r.root);
      if (r.oldSha) child.setAttribute("catalyst.updater.old_sha", r.oldSha);
      if (r.newSha) child.setAttribute("catalyst.updater.new_sha", r.newSha);
      child.setAttribute("catalyst.updater.checkout.changed", !!r.changed);
      if (r.failed) {
        child.setStatus({ code: SpanStatusCode.ERROR, message: `plugin checkout refresh failed: ${r.root}` });
      }
      child.end(endEpochMs);
    }
    if (failed > 0) {
      root.setStatus({ code: SpanStatusCode.ERROR, message: `${failed} plugin checkout(s) failed to refresh` });
    }
    root.end(endEpochMs);
  } catch {
    /* observability must never throw */
  }
}

// emitInstallTrace — CTL-1369: one TRACE per `catalyst install|uninstall|reinstall` run.
// Root `catalyst.install` (INTERNAL) + one child span per phase that ran (acquire → backup
// → write-config → install-agents → start-daemons → healthcheck), plus an `install.rollback`
// child on a rolled-back run. The OTEL agent's locked turn-01 lifecycle-trace model. Mirrors
// emitUpdaterRefreshSpan's trace↔log seeding (pass traceId+spanId and the root's trace_id
// equals the id on the install log lines) and its never-throw discipline. The catalyst.install.*
// EVENTS + the InstallRun recorder live in lib/install-telemetry.mjs (events near the caller,
// spans here — the same split as updater.mjs:makeEmitFn + this module's emitUpdaterRefreshSpan).
// `phases` = [{ name, startEpochMs, endEpochMs, ok, error }].
export function emitInstallTrace({
  operation,
  nodeClass,
  phases = [],
  outcome,
  startEpochMs,
  endEpochMs,
  traceId,
  spanId,
  rollback = null,
} = {}) {
  const tracer = getTracer();
  if (!tracer) return;
  try {
    let startCtx = context.active();
    if (traceId && spanId && TraceFlags && typeof trace.setSpanContext === "function") {
      startCtx = trace.setSpanContext(startCtx, { traceId, spanId, traceFlags: TraceFlags.SAMPLED, isRemote: true });
    }
    const root = tracer.startSpan("catalyst.install", { kind: SpanKind.INTERNAL, startTime: startEpochMs }, startCtx);
    if (operation != null) root.setAttribute("catalyst.install.operation", operation);
    if (nodeClass != null) root.setAttribute("catalyst.node.class", nodeClass);
    if (outcome != null) root.setAttribute("catalyst.install.outcome", outcome);
    const rootCtx = trace.setSpan(context.active(), root);
    for (const p of phases) {
      if (!p || !p.name) continue;
      const child = tracer.startSpan(`install.${p.name}`, { kind: SpanKind.INTERNAL, startTime: p.startEpochMs ?? startEpochMs }, rootCtx);
      child.setAttribute("catalyst.install.phase", p.name);
      if (p.ok === false || p.error) {
        child.setStatus({ code: SpanStatusCode.ERROR, message: p.error ? String(p.error) : `install phase failed: ${p.name}` });
      }
      child.end(p.endEpochMs ?? endEpochMs);
    }
    if (rollback) {
      const rb = tracer.startSpan("install.rollback", { kind: SpanKind.INTERNAL, startTime: rollback.startEpochMs ?? startEpochMs }, rootCtx);
      if (rollback.error) rb.setStatus({ code: SpanStatusCode.ERROR, message: String(rollback.error) });
      rb.end(rollback.endEpochMs ?? endEpochMs);
    }
    if (outcome === "failed" || outcome === "rolled_back") {
      root.setStatus({ code: SpanStatusCode.ERROR, message: `install ${operation} ${outcome}` });
    }
    root.end(endEpochMs);
  } catch {
    /* observability must never throw */
  }
}

// Re-export the api primitives callers need so they don't each import @opentelemetry/api.
export { trace, context, SpanKind, SpanStatusCode, TraceFlags };
