// tracing.test.mjs — CTL-1330 Tier 3: span-tree shape + the OFF-by-default / no-crash
// invariants. Uses an in-memory exporter so nothing hits a real OTLP collector.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import {
  tracingEnabled,
  getTracer,
  emitTickTrace,
  emitLivenessRefreshSpan,
  __setTracerForTest,
} from "./tracing.mjs";

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
