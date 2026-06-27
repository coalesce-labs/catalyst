// updater-tracing.test.mjs — CTL-1350 Tier 3: the updater.refresh span tree shape +
// the OFF-by-default / no-crash invariants. In-memory exporter; nothing hits a real
// collector. Mirrors tracing.test.mjs (the scheduler.tick equivalent).
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { getTracer, emitUpdaterRefreshSpan, __setTracerForTest } from "../tracing.mjs";

describe("emitUpdaterRefreshSpan is a safe no-op when tracing is disabled", () => {
  beforeEach(() => __setTracerForTest(null));
  test("getTracer() null → emit never throws", () => {
    expect(getTracer()).toBeNull();
    expect(() => emitUpdaterRefreshSpan({ reason: "poll", startEpochMs: 0, endEpochMs: 10, roots: 1, results: [] })).not.toThrow();
  });
});

describe("emitUpdaterRefreshSpan span tree (in-memory exporter)", () => {
  let exporter;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    __setTracerForTest(provider.getTracer("test"));
  });
  afterEach(() => __setTracerForTest(null));

  test("a clean refresh (nothing changed/failed) is exactly ONE root span", () => {
    emitUpdaterRefreshSpan({
      reason: "poll",
      startEpochMs: 1000,
      endEpochMs: 1040,
      roots: 2,
      pulled: 2,
      changed: 0,
      failed: 0,
      results: [
        { root: "/r/a", changed: false, failed: false, oldSha: "s", newSha: "s" },
        { root: "/r/b", changed: false, failed: false, oldSha: "t", newSha: "t" },
      ],
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toEqual(["updater.refresh"]);
    const root = spans[0];
    expect(root.kind).toBe(SpanKind.INTERNAL);
    expect(root.attributes["catalyst.updater.reason"]).toBe("poll");
    expect(root.attributes["catalyst.updater.roots"]).toBe(2);
    expect(root.attributes["catalyst.updater.changed"]).toBe(0);
    expect(root.status.code).toBe(SpanStatusCode.UNSET);
  });

  test("a child updater.checkout span ONLY for checkouts that changed or failed", () => {
    emitUpdaterRefreshSpan({
      reason: "event",
      startEpochMs: 2000,
      endEpochMs: 2100,
      roots: 3,
      pulled: 2,
      changed: 1,
      failed: 1,
      results: [
        { root: "/r/clean", changed: false, failed: false, oldSha: "s", newSha: "s" }, // no child
        { root: "/r/changed", changed: true, failed: false, oldSha: "old", newSha: "new" }, // child
        { root: "/r/failed", changed: false, failed: true, oldSha: "h", newSha: null }, // child (ERROR)
      ],
    });
    const spans = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name).sort();
    expect(names).toEqual(["updater.checkout", "updater.checkout", "updater.refresh"]);

    const root = spans.find((s) => s.name === "updater.refresh");
    expect(root.status.code).toBe(SpanStatusCode.ERROR); // failed > 0

    const checkouts = spans.filter((s) => s.name === "updater.checkout");
    const changedSpan = checkouts.find((s) => s.attributes["catalyst.updater.checkout"] === "/r/changed");
    expect(changedSpan.attributes["catalyst.updater.old_sha"]).toBe("old");
    expect(changedSpan.attributes["catalyst.updater.new_sha"]).toBe("new");
    expect(changedSpan.attributes["catalyst.updater.checkout.changed"]).toBe(true);
    expect(changedSpan.status.code).toBe(SpanStatusCode.UNSET);

    const failedSpan = checkouts.find((s) => s.attributes["catalyst.updater.checkout"] === "/r/failed");
    expect(failedSpan.status.code).toBe(SpanStatusCode.ERROR);
    // every checkout child parents to the refresh root (one trace)
    expect(changedSpan.parentSpanContext?.spanId ?? changedSpan.parentSpanId).toBe(root.spanContext().spanId);
  });

  test("seeded traceId/spanId → the root span inherits the trace_id (log↔trace join)", () => {
    const traceId = "abcdef01234567890abcdef012345678";
    const spanId = "1122334455667788";
    emitUpdaterRefreshSpan({ reason: "poll", startEpochMs: 0, endEpochMs: 5, roots: 1, results: [], traceId, spanId });
    const root = exporter.getFinishedSpans()[0];
    expect(root.spanContext().traceId).toBe(traceId);
  });
});
