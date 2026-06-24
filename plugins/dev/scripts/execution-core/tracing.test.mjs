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
