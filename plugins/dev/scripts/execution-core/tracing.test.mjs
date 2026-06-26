// tracing.test.mjs — CTL-1330 Tier 3: span-tree shape + the OFF-by-default / no-crash
// invariants. Uses an in-memory exporter so nothing hits a real OTLP collector.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  tracingEnabled,
  getTracer,
  emitTickTrace,
  emitLivenessRefreshSpan,
  buildTracingResource,
  initTracing,
  shutdownTracing,
  __setTracerForTest,
} from "./tracing.mjs";
import { schedulerTick } from "./scheduler.mjs";
import { dispatchModeForExecutor } from "./config.mjs";

describe("tracingEnabled (CTL-1330 Tier 3 — OFF by default)", () => {
  test("OFF unless CATALYST_TRACING=on", () => {
    expect(tracingEnabled({})).toBe(false);
    expect(tracingEnabled({ CATALYST_TRACING: "off" })).toBe(false);
    expect(tracingEnabled({ CATALYST_TRACING: "1" })).toBe(false);
    expect(tracingEnabled({ CATALYST_TRACING: "on" })).toBe(true);
  });
});

describe("span helpers are safe no-ops when tracing is disabled", () => {
  beforeEach(() => __setTracerForTest(null));
  test("getTracer() is null and emit helpers never throw", () => {
    expect(getTracer()).toBeNull();
    expect(() => emitTickTrace({ tickId: 1, startEpochMs: 0, endEpochMs: 10, laps: [] })).not.toThrow();
    expect(() => emitLivenessRefreshSpan({ outcome: "timeout", startEpochMs: 0, endEpochMs: 3000, deadlineMs: 3000 })).not.toThrow();
  });
});

describe("emitTickTrace span tree (in-memory exporter)", () => {
  let exporter;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    __setTracerForTest(provider.getTracer("test"));
  });
  afterEach(() => __setTracerForTest(null));

  test("root scheduler.tick + a scheduler.pass child ONLY for passes over the threshold", () => {
    emitTickTrace({
      tickId: 42,
      startEpochMs: 1000,
      endEpochMs: 2940,
      slowPassThresholdMs: 50,
      laps: [
        { name: "eligible-read", durationMs: 0.2, startEpochMs: 1000, endEpochMs: 1000 },
        { name: "recovery-pass", durationMs: 1897, startEpochMs: 1001, endEpochMs: 2898 },
        { name: "new-work-pull", durationMs: 40, startEpochMs: 2898, endEpochMs: 2938 }, // under threshold
      ],
      attrs: { "catalyst.scheduler.slowest_pass": "recovery-pass" },
    });
    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name).sort();
    expect(names).toEqual(["scheduler.pass", "scheduler.tick"]); // exactly one pass child (the slow one)

    const root = spans.find((s) => s.name === "scheduler.tick");
    expect(root.kind).toBe(SpanKind.INTERNAL);
    expect(root.attributes["catalyst.scheduler.tick_id"]).toBe(42);
    expect(root.attributes["catalyst.scheduler.slowest_pass"]).toBe("recovery-pass");

    const child = spans.find((s) => s.name === "scheduler.pass");
    expect(child.attributes["catalyst.scheduler.pass"]).toBe("recovery-pass");
    expect(child.attributes["catalyst.scheduler.pass.duration_ms"]).toBe(1897);
    // child is parented to the root
    expect(child.parentSpanContext?.spanId ?? child.parentSpanId).toBe(root.spanContext().spanId);
  });

  test("a healthy tick (all passes under threshold) emits ONLY the root span", () => {
    emitTickTrace({
      tickId: 7,
      startEpochMs: 0,
      endEpochMs: 3,
      laps: [
        { name: "phantom-sweep", durationMs: 0.2, startEpochMs: 0, endEpochMs: 0 },
        { name: "advancement", durationMs: 0.3, startEpochMs: 1, endEpochMs: 1 },
      ],
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["scheduler.tick"]);
  });

  // CTL-1337: the per-tick trace↔logs round-trip contract.
  test("the root scheduler.tick span adopts the passed per-tick traceId", () => {
    const traceId = "0123456789abcdef0123456789abcdef"; // 32 hex
    const spanId = "fedcba9876543210"; //                 16 hex
    emitTickTrace({
      tickId: 99,
      traceId,
      spanId,
      startEpochMs: 1000,
      endEpochMs: 1005,
      laps: [{ name: "advancement", durationMs: 0.3, startEpochMs: 1000, endEpochMs: 1001 }],
    });
    const root = exporter.getFinishedSpans().find((s) => s.name === "scheduler.tick");
    expect(root.spanContext().traceId).toBe(traceId);
  });

  test("a slow pass child inherits the root's per-tick traceId (whole tick is one trace)", () => {
    const traceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const spanId = "bbbbbbbbbbbbbbbb";
    emitTickTrace({
      tickId: 100,
      traceId,
      spanId,
      slowPassThresholdMs: 50,
      startEpochMs: 1000,
      endEpochMs: 3000,
      laps: [{ name: "recovery-pass", durationMs: 1900, startEpochMs: 1001, endEpochMs: 2901 }],
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual(["scheduler.pass", "scheduler.tick"]);
    for (const s of spans) expect(s.spanContext().traceId).toBe(traceId);
  });

  test("two different ticks yield two different trace_ids (no per-orchestrator collapse)", () => {
    const a = { traceId: "11111111111111111111111111111111", spanId: "1111111111111111" };
    const b = { traceId: "22222222222222222222222222222222", spanId: "2222222222222222" };
    emitTickTrace({ tickId: 1, ...a, startEpochMs: 0, endEpochMs: 2, laps: [] });
    emitTickTrace({ tickId: 2, ...b, startEpochMs: 10, endEpochMs: 12, laps: [] });
    const roots = exporter.getFinishedSpans().filter((s) => s.name === "scheduler.tick");
    expect(roots).toHaveLength(2);
    const traceIds = roots.map((s) => s.spanContext().traceId);
    expect(new Set(traceIds).size).toBe(2);
    expect(traceIds).toContain(a.traceId);
    expect(traceIds).toContain(b.traceId);
  });

  test("omitting traceId/spanId still emits a span with an SDK-random trace_id (degrade, never crash)", () => {
    emitTickTrace({ tickId: 5, startEpochMs: 0, endEpochMs: 1, laps: [] });
    const root = exporter.getFinishedSpans().find((s) => s.name === "scheduler.tick");
    expect(root).toBeDefined();
    expect(root.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});

// CTL-1337: the deterministic per-tick id derivation that BOTH the Tier-1 log line and
// the Tier-3 span seed off of. Imported from scheduler.mjs (its owner) so the test pins
// the exact contract: same inputs → same ids; different tick → different trace_id.
describe("deriveTickTraceContext (CTL-1337 — deterministic per-tick id)", () => {
  test("32-hex traceId / 16-hex spanId, deterministic for the same inputs", async () => {
    const { deriveTickTraceContext } = await import("./scheduler.mjs");
    const args = { orchestratorId: "catalyst.execution-core", tickId: 42, node: "mini" };
    const first = deriveTickTraceContext(args);
    const second = deriveTickTraceContext(args);
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(first).toEqual(second);
    // span_id is NOT the traceId prefix — it is a distinct sha256(seed + ":span")
    expect(first.spanId).not.toBe(first.traceId.slice(0, 16));
  });

  test("a different tick_id yields a different trace_id (per-tick, not per-orchestrator)", async () => {
    const { deriveTickTraceContext } = await import("./scheduler.mjs");
    const base = { orchestratorId: "catalyst.execution-core", node: "mini" };
    const t1 = deriveTickTraceContext({ ...base, tickId: 1 });
    const t2 = deriveTickTraceContext({ ...base, tickId: 2 });
    expect(t1.traceId).not.toBe(t2.traceId);
  });

  // CTL-1362: tick_id resets to 1 on every daemon restart, so the same tick_id across two
  // boots must NOT collide — the per-boot nonce makes the id unique per (boot, tick).
  test("the same tick_id across two boots yields DIFFERENT trace_ids (boot-nonce dedupe)", async () => {
    const { deriveTickTraceContext } = await import("./scheduler.mjs");
    const base = { orchestratorId: "catalyst.execution-core", node: "mini", tickId: 171 };
    const bootA = deriveTickTraceContext({ ...base, bootNonce: "boot-a" });
    const bootB = deriveTickTraceContext({ ...base, bootNonce: "boot-b" });
    expect(bootA.traceId).not.toBe(bootB.traceId);
    expect(bootA.spanId).not.toBe(bootB.spanId);
  });

  test("same (boot, tick) is reproducible — log line and span derive the SAME id", async () => {
    const { deriveTickTraceContext } = await import("./scheduler.mjs");
    const args = { orchestratorId: "catalyst.execution-core", node: "mini", tickId: 171, bootNonce: "boot-a" };
    expect(deriveTickTraceContext(args)).toEqual(deriveTickTraceContext(args));
  });

  test("SCHEDULER_BOOT_NONCE is a non-empty per-boot constant", async () => {
    const { SCHEDULER_BOOT_NONCE } = await import("./scheduler.mjs");
    expect(typeof SCHEDULER_BOOT_NONCE).toBe("string");
    expect(SCHEDULER_BOOT_NONCE.length).toBeGreaterThan(0);
  });
});

// CTL-1364: the scheduler.op grandchild tier — scheduler.tick → scheduler.pass →
// scheduler.op. Threshold-gated; op identity rides ATTRIBUTES (3 span names total).
describe("emitTickTrace scheduler.op tier (CTL-1364)", () => {
  let exporter;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    __setTracerForTest(provider.getTracer("test"));
    delete process.env.CATALYST_TRACING_OP_THRESHOLD_MS;
  });
  afterEach(() => {
    __setTracerForTest(null);
    delete process.env.CATALYST_TRACING_OP_THRESHOLD_MS;
  });

  test("a slow op nests scheduler.op under its scheduler.pass under scheduler.tick", () => {
    emitTickTrace({
      tickId: 1,
      startEpochMs: 1000,
      endEpochMs: 4000,
      slowPassThresholdMs: 50,
      opThresholdMs: 50,
      laps: [{ name: "recovery-pass", durationMs: 2000, startEpochMs: 1000, endEpochMs: 3000 }],
      ops: [
        {
          pass: "recovery-pass",
          name: "terminal-read",
          startEpochMs: 1100,
          endEpochMs: 2700,
          durationMs: 1600,
          attrs: {
            "op.sweep": "recovery-filter",
            "catalyst.ticket": "CTL-9",
            "recovery.terminal.source": "live",
            "recovery.terminal.cache_hit": false,
            "op.exec_ms": 1600,
            "recovery.terminal.result": "In Progress",
            "op.timed_out": false,
          },
        },
      ],
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual(["scheduler.op", "scheduler.pass", "scheduler.tick"]);
    const root = spans.find((s) => s.name === "scheduler.tick");
    const pass = spans.find((s) => s.name === "scheduler.pass");
    const op = spans.find((s) => s.name === "scheduler.op");
    // chain: op → pass → tick
    expect((pass.parentSpanContext?.spanId ?? pass.parentSpanId)).toBe(root.spanContext().spanId);
    expect((op.parentSpanContext?.spanId ?? op.parentSpanId)).toBe(pass.spanContext().spanId);
    // op attributes (op identity lives in attrs, not the name)
    expect(op.attributes["catalyst.scheduler.op"]).toBe("terminal-read");
    expect(op.attributes["catalyst.scheduler.pass"]).toBe("recovery-pass");
    expect(op.attributes["catalyst.scheduler.op.duration_ms"]).toBe(1600);
    expect(op.attributes["op.sweep"]).toBe("recovery-filter");
    expect(op.attributes["catalyst.ticket"]).toBe("CTL-9");
    expect(op.attributes["recovery.terminal.source"]).toBe("live");
    expect(op.attributes["recovery.terminal.result"]).toBe("In Progress");
    expect(op.status.code).toBe(SpanStatusCode.UNSET);
  });

  test("an op >= opThresholdMs inside a SUB-threshold pass creates the pass parent on-demand", () => {
    emitTickTrace({
      tickId: 2,
      startEpochMs: 1000,
      endEpochMs: 2000,
      slowPassThresholdMs: 500, // the pass (120ms) is UNDER this — no pass span by the lap loop
      opThresholdMs: 50,
      laps: [{ name: "reclaim", durationMs: 120, startEpochMs: 1000, endEpochMs: 1120 }],
      ops: [
        {
          pass: "reclaim",
          name: "terminal-read",
          startEpochMs: 1010,
          endEpochMs: 1110,
          durationMs: 100, // >= opThresholdMs → forces the on-demand pass parent
          attrs: { "op.sweep": "reclaim-sweep", "catalyst.ticket": "ADV-1", "recovery.reclaim.outcome": "noop" },
        },
      ],
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual(["scheduler.op", "scheduler.pass", "scheduler.tick"]);
    const root = spans.find((s) => s.name === "scheduler.tick");
    const pass = spans.find((s) => s.name === "scheduler.pass");
    const op = spans.find((s) => s.name === "scheduler.op");
    expect(pass.attributes["catalyst.scheduler.pass"]).toBe("reclaim");
    expect((pass.parentSpanContext?.spanId ?? pass.parentSpanId)).toBe(root.spanContext().spanId);
    expect((op.parentSpanContext?.spanId ?? op.parentSpanId)).toBe(pass.spanContext().spanId);
    expect(op.attributes["op.sweep"]).toBe("reclaim-sweep");
    expect(op.attributes["recovery.reclaim.outcome"]).toBe("noop");
  });

  test("an op BELOW opThresholdMs emits no op span (cache hits / fast ops stay silent)", () => {
    emitTickTrace({
      tickId: 3,
      startEpochMs: 1000,
      endEpochMs: 1100,
      slowPassThresholdMs: 50,
      opThresholdMs: 50,
      laps: [{ name: "reclaim", durationMs: 60, startEpochMs: 1000, endEpochMs: 1060 }],
      ops: [
        { pass: "reclaim", name: "terminal-read", startEpochMs: 1001, endEpochMs: 1011, durationMs: 10, attrs: {} },
      ],
    });
    const names = exporter.getFinishedSpans().map((s) => s.name).sort();
    expect(names).toEqual(["scheduler.pass", "scheduler.tick"]); // pass slow, op fast → no op span
  });

  test("op.timed_out:true sets the op span status to ERROR", () => {
    emitTickTrace({
      tickId: 4,
      startEpochMs: 1000,
      endEpochMs: 20000,
      slowPassThresholdMs: 50,
      opThresholdMs: 50,
      laps: [{ name: "recovery-pass", durationMs: 15000, startEpochMs: 1000, endEpochMs: 16000 }],
      ops: [
        {
          pass: "recovery-pass",
          name: "terminal-read",
          startEpochMs: 1000,
          endEpochMs: 9000,
          durationMs: 8000,
          attrs: { "op.sweep": "recovery-filter", "catalyst.ticket": "CTL-9", "op.timed_out": true },
        },
      ],
    });
    const op = exporter.getFinishedSpans().find((s) => s.name === "scheduler.op");
    expect(op.status.code).toBe(SpanStatusCode.ERROR);
    expect(op.attributes["op.timed_out"]).toBe(true);
  });

  test("ops=[] is byte-identical to today (no op spans, pass behavior unchanged)", () => {
    emitTickTrace({
      tickId: 5,
      startEpochMs: 1000,
      endEpochMs: 2940,
      slowPassThresholdMs: 50,
      laps: [
        { name: "eligible-read", durationMs: 0.2, startEpochMs: 1000, endEpochMs: 1000 },
        { name: "recovery-pass", durationMs: 1897, startEpochMs: 1001, endEpochMs: 2898 },
      ],
      ops: [],
    });
    const names = exporter.getFinishedSpans().map((s) => s.name).sort();
    expect(names).toEqual(["scheduler.pass", "scheduler.tick"]);
  });

  test("CATALYST_TRACING_OP_THRESHOLD_MS overrides the default floor", () => {
    process.env.CATALYST_TRACING_OP_THRESHOLD_MS = "5";
    emitTickTrace({
      tickId: 6,
      startEpochMs: 1000,
      endEpochMs: 1100,
      slowPassThresholdMs: 50,
      // opThresholdMs default 50 — env lowers it to 5, so a 10ms op now crosses
      laps: [{ name: "reclaim", durationMs: 60, startEpochMs: 1000, endEpochMs: 1060 }],
      ops: [
        { pass: "reclaim", name: "terminal-read", startEpochMs: 1001, endEpochMs: 1011, durationMs: 10, attrs: {} },
      ],
    });
    const names = exporter.getFinishedSpans().map((s) => s.name).sort();
    expect(names).toEqual(["scheduler.op", "scheduler.pass", "scheduler.tick"]);
  });

  test("a throwing tracer never escapes emitTickTrace (op loop inside the try/catch)", () => {
    __setTracerForTest({
      startSpan() {
        throw new Error("boom");
      },
    });
    expect(() =>
      emitTickTrace({
        tickId: 7,
        startEpochMs: 0,
        endEpochMs: 100,
        laps: [{ name: "recovery-pass", durationMs: 99, startEpochMs: 0, endEpochMs: 99 }],
        ops: [{ pass: "recovery-pass", name: "terminal-read", startEpochMs: 1, endEpochMs: 99, durationMs: 98, attrs: {} }],
      })
    ).not.toThrow();
  });
});

// CTL-1364 — end-to-end through the REAL makeTickTimer op() recorder + the
// fetchTicketState onExec seam: the exact wiring the scheduler uses for the
// recovery-filter terminal-read op (highest-value span). Proves a slow terminal-read
// on a cache+gateway miss yields exactly one scheduler.op[terminal-read,
// recovery-filter] chaining op → scheduler.pass[recovery-pass] → scheduler.tick, while
// a cache hit (no onExec) yields no op span.
describe("makeTickTimer.op + onExec → emitTickTrace wiring (CTL-1364)", () => {
  let exporter;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    __setTracerForTest(provider.getTracer("test"));
  });
  afterEach(() => __setTracerForTest(null));

  test("a >50ms terminal-read on a cache+gateway MISS produces op→pass[recovery-pass]→tick", async () => {
    const { makeTickTimer } = await import("./scheduler.mjs");
    const { fetchTicketState } = await import("./linear-query.mjs");
    // Controllable clock: 0ms (tick start) → recovery-pass lap closes at 2000ms; the
    // terminal-read op spans 100→1700 (1600ms, well over the 50ms op floor).
    let t = 0;
    const tick = makeTickTimer(() => t, () => 1_700_000_000_000);

    // Mirror the scheduler's recovery-filter wiring exactly:
    const done = tick.op("recovery-pass", "terminal-read", {
      "op.sweep": "recovery-filter",
      "catalyst.ticket": "CTL-9",
    });
    t = 100; // op start was captured at t=0 inside op(); advance to the exec window
    // A cache+gateway+replica MISS → the live exec fires → onExec runs → done() closes.
    const exec = () => ({
      code: 0,
      stdout: JSON.stringify({ identifier: "CTL-9", state: { name: "In Progress" } }),
    });
    t = 1700; // exec completes here (the op's end timestamp)
    const state = fetchTicketState("CTL-9", {
      exec,
      onExec: ({ source, execMs, result, timedOut }) =>
        done({
          "recovery.terminal.source": source,
          "recovery.terminal.cache_hit": false,
          "op.exec_ms": execMs,
          "recovery.terminal.result": result ?? "null",
          "op.timed_out": timedOut === true,
        }),
    });
    expect(state).toBe("In Progress");
    t = 2000;
    tick.lap("recovery-pass"); // pass spans 0→2000 (slow)

    emitTickTrace({
      tickId: tick.tickId,
      startEpochMs: tick.startEpochMs,
      endEpochMs: tick.endEpochMs(),
      slowPassThresholdMs: 50,
      opThresholdMs: 50,
      laps: tick.spanLaps,
      ops: tick.spanOps,
    });

    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual(["scheduler.op", "scheduler.pass", "scheduler.tick"]);
    const root = spans.find((s) => s.name === "scheduler.tick");
    const pass = spans.find((s) => s.name === "scheduler.pass");
    const op = spans.find((s) => s.name === "scheduler.op");
    expect(pass.attributes["catalyst.scheduler.pass"]).toBe("recovery-pass");
    expect((pass.parentSpanContext?.spanId ?? pass.parentSpanId)).toBe(root.spanContext().spanId);
    expect((op.parentSpanContext?.spanId ?? op.parentSpanId)).toBe(pass.spanContext().spanId);
    expect(op.attributes["catalyst.scheduler.op"]).toBe("terminal-read");
    expect(op.attributes["op.sweep"]).toBe("recovery-filter");
    expect(op.attributes["catalyst.ticket"]).toBe("CTL-9");
    expect(op.attributes["recovery.terminal.source"]).toBe("live");
    expect(op.attributes["recovery.terminal.cache_hit"]).toBe(false);
    expect(op.attributes["recovery.terminal.result"]).toBe("In Progress");
    expect(op.attributes["catalyst.scheduler.op.duration_ms"]).toBeGreaterThanOrEqual(50);
  });

  test("a cache HIT records no op (done never called) → no op span", async () => {
    const { makeTickTimer } = await import("./scheduler.mjs");
    const { fetchTicketState } = await import("./linear-query.mjs");
    const { createTicketStateCache } = await import("./linear-cache.mjs");
    let t = 0;
    const tick = makeTickTimer(() => t, () => 1_700_000_000_000);
    const cache = createTicketStateCache({ now: () => 0 });
    cache.set("CTL-1", "Done");

    const done = tick.op("recovery-pass", "terminal-read", { "op.sweep": "recovery-filter", "catalyst.ticket": "CTL-1" });
    const exec = () => ({ code: 0, stdout: "{}" });
    // cache hit → onExec never fires → done is never called → op not recorded
    const state = fetchTicketState("CTL-1", {
      exec,
      cache,
      onExec: () => done({ "recovery.terminal.cache_hit": false }),
    });
    expect(state).toBe("Done");
    t = 2000;
    tick.lap("recovery-pass");
    expect(tick.spanOps.length).toBe(0); // no op recorded

    emitTickTrace({
      tickId: tick.tickId,
      startEpochMs: tick.startEpochMs,
      endEpochMs: tick.endEpochMs(),
      laps: tick.spanLaps,
      ops: tick.spanOps,
    });
    const names = exporter.getFinishedSpans().map((s) => s.name).sort();
    expect(names).toEqual(["scheduler.pass", "scheduler.tick"]); // pass slow, no op span
  });
});

describe("emitLivenessRefreshSpan (in-memory exporter)", () => {
  let exporter;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    __setTracerForTest(provider.getTracer("test"));
  });
  afterEach(() => __setTracerForTest(null));

  test("timeout outcome sets ERROR status + the outcome attribute", () => {
    emitLivenessRefreshSpan({ outcome: "timeout", startEpochMs: 1000, endEpochMs: 4000, deadlineMs: 3000, populated: true, ageMs: 5000 });
    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe("liveness.refresh");
    expect(span.attributes["catalyst.liveness.outcome"]).toBe("timeout");
    expect(span.attributes["catalyst.liveness.deadline_ms"]).toBe(3000);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toContain("3000ms");
  });

  test("resolved outcome leaves status UNSET (no error)", () => {
    emitLivenessRefreshSpan({ outcome: "resolved", startEpochMs: 1000, endEpochMs: 1211, deadlineMs: 3000, populated: true, ageMs: 0 });
    const [span] = exporter.getFinishedSpans();
    expect(span.attributes["catalyst.liveness.outcome"]).toBe("resolved");
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });
});

// CTL-1365a: the catalyst.dispatch.mode telemetry dimension (OTEL #43/#44, frozen).
// Resource attr for traces; log field for metrics — each sourced its own way.
describe("buildTracingResource — catalyst.dispatch.mode (CTL-1365a)", () => {
  test("defaults to phase-agents (today's bg substrate) when no mode passed", () => {
    const r = buildTracingResource({ serviceName: "catalyst.execution-core", env: {} });
    expect(r["catalyst.dispatch.mode"]).toBe("phase-agents");
    expect(r["service.name"]).toBe("catalyst.execution-core");
    expect(r["service.namespace"]).toBe("catalyst");
    expect(typeof r["host.name"]).toBe("string");
    expect("catalyst.node.name" in r).toBe(true);
  });

  test("carries the passed mode (sdk) verbatim", () => {
    const r = buildTracingResource({ serviceName: "x", dispatchMode: "sdk", env: {} });
    expect(r["catalyst.dispatch.mode"]).toBe("sdk");
  });

  test("the executor→mode mapping flows through (bg→phase-agents)", () => {
    const r = buildTracingResource({
      serviceName: "x",
      dispatchMode: dispatchModeForExecutor("bg"),
      env: {},
    });
    expect(r["catalyst.dispatch.mode"]).toBe("phase-agents");
  });
});

describe("initTracing tags the trace resource with catalyst.dispatch.mode (CTL-1365a)", () => {
  afterEach(async () => {
    await shutdownTracing();
    __setTracerForTest(null);
  });

  test("OFF (CATALYST_TRACING unset) → returns false, no tracer, no SDK work", async () => {
    const on = await initTracing({ serviceName: "catalyst.execution-core", dispatchMode: "sdk", env: {} });
    expect(on).toBe(false);
    expect(getTracer()).toBeNull();
  });

  test("ON → the resource on emitted spans carries the resolved dispatch mode", async () => {
    const on = await initTracing({
      serviceName: "catalyst.execution-core",
      dispatchMode: "sdk",
      env: { CATALYST_TRACING: "on" },
    });
    expect(on).toBe(true);
    const span = getTracer().startSpan("ctl1365a-probe");
    // SDK ReadableSpan carries the provider resource.
    expect(span.resource.attributes["catalyst.dispatch.mode"]).toBe("sdk");
    expect(span.resource.attributes["service.name"]).toBe("catalyst.execution-core");
    span.end();
  });
});

// CTL-1365a: the metric leg — the CTL-1330 tick-timing log line carries the
// dispatch-mode field (OTEL ParseJSON(body)→signaltometrics labels metrics from it).
// Drives a real (empty-board) schedulerTick under a temp CATALYST_DIR and captures
// the pino line off stderr.
describe("tick-timing log line carries catalyst.dispatch.mode (CTL-1365a)", () => {
  let prevCatalystDir, catalystDir, orchDir;

  beforeEach(() => {
    prevCatalystDir = process.env.CATALYST_DIR;
    catalystDir = mkdtempSync(join(tmpdir(), "ctl1365a-tick-"));
    if (!catalystDir.startsWith(tmpdir())) {
      throw new Error(`refused: catalystDir not under tmpdir: ${catalystDir}`);
    }
    process.env.CATALYST_DIR = catalystDir;
    mkdirSync(join(catalystDir, "events"), { recursive: true });
    orchDir = join(catalystDir, "orch");
    mkdirSync(join(orchDir, "workers"), { recursive: true });
  });

  afterEach(() => {
    if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevCatalystDir;
    rmSync(catalystDir, { recursive: true, force: true });
  });

  // Run one empty-board tick, capturing stderr (pino → process.stderr), and return
  // the parsed "scheduler: tick timing" log object.
  const captureTickTimingLine = (opts) => {
    const lines = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      lines.push(String(chunk));
      return true;
    };
    try {
      schedulerTick(orchDir, {
        readEligible: () => [],
        dispatch: () => ({ code: 0 }),
        writeStatus: {
          applyPhaseStatus: () => {},
          applyTerminalDone: () => {},
          applyLabel: () => ({ applied: true }),
        },
        ...opts,
      });
    } finally {
      process.stderr.write = orig;
    }
    const raw = lines.join("").split("\n").filter(Boolean).find((l) => l.includes("scheduler: tick timing"));
    return raw ? JSON.parse(raw) : null;
  };

  test("stamps the threaded dispatch mode (sdk)", () => {
    const line = captureTickTimingLine({ dispatchMode: "sdk" });
    expect(line).not.toBeNull();
    expect(line["catalyst.dispatch.mode"]).toBe("sdk");
  });

  test("defaults to phase-agents (bg substrate) when no mode threaded", () => {
    const line = captureTickTimingLine({});
    expect(line).not.toBeNull();
    expect(line["catalyst.dispatch.mode"]).toBe("phase-agents");
  });
});
