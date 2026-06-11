import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOtlpPayload } from "./otlp.ts";
import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";

const SAMPLE_EVENT: CanonicalEvent = {
  ts: "2026-05-08T04:34:45Z",
  id: "11111111-2222-4333-8444-555555555555",
  observedTs: "2026-05-08T04:34:45Z",
  severityText: "INFO",
  severityNumber: 9,
  traceId: "3c9646213b6ef69ae96bf35ac676db11",
  spanId: "e63ffe96eec0a8ae",
  resource: {
    "service.name": "catalyst.session",
    "service.namespace": "catalyst" as const,
    "service.version": "8.2.0",
    "host.name": "test-host",
    "host.id": "test-id-0000",
  },
  attributes: { "event.name": "session.heartbeat", "catalyst.session.id": "sess_123" },
  body: { message: "heartbeat", payload: null },
};

describe("buildOtlpPayload", () => {
  test("wraps events in resourceLogs structure", () => {
    const payload = buildOtlpPayload([SAMPLE_EVENT]) as any;
    expect(payload.resourceLogs).toHaveLength(1);
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(lr.severityNumber).toBe(9);
    expect(lr.severityText).toBe("INFO");
    expect(lr.traceId).toBe("3c9646213b6ef69ae96bf35ac676db11");
  });

  test("converts ts ISO to timeUnixNano", () => {
    const payload = buildOtlpPayload([SAMPLE_EVENT]) as any;
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    const expectedNs = Date.parse("2026-05-08T04:34:45Z") * 1_000_000;
    expect(lr.timeUnixNano).toBe(expectedNs);
  });

  test("maps resource fields to OTLP attributes array", () => {
    const payload = buildOtlpPayload([SAMPLE_EVENT]) as any;
    const resAttrs = payload.resourceLogs[0].resource.attributes;
    const svcName = resAttrs.find((a: any) => a.key === "service.name");
    expect(svcName?.value?.stringValue).toBe("catalyst.session");
  });

  test("propagates CTL-636 resource keys to OTLP resource.attributes", () => {
    const event: CanonicalEvent = {
      ...SAMPLE_EVENT,
      resource: {
        ...SAMPLE_EVENT.resource,
        project: "catalyst-workspace",
        "linear.key": "CTL-636",
        "catalyst.orchestration": "CTL-636",
      },
    };
    const payload = buildOtlpPayload([event]) as any;
    const resAttrs = payload.resourceLogs[0].resource.attributes;
    const get = (k: string) => resAttrs.find((a: any) => a.key === k)?.value?.stringValue;
    expect(get("project")).toBe("catalyst-workspace");
    expect(get("linear.key")).toBe("CTL-636");
    expect(get("catalyst.orchestration")).toBe("CTL-636");
    // base key still present
    expect(get("service.name")).toBe("catalyst.session");
  });

  test("maps string attributes to stringValue", () => {
    const payload = buildOtlpPayload([SAMPLE_EVENT]) as any;
    const logAttrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const evName = logAttrs.find((a: any) => a.key === "event.name");
    expect(evName?.value?.stringValue).toBe("session.heartbeat");
  });

  test("maps integer attributes to intValue", () => {
    const event: CanonicalEvent = {
      ...SAMPLE_EVENT,
      attributes: { "event.name": "test", "vcs.pr.number": 42 },
    };
    const payload = buildOtlpPayload([event]) as any;
    const attrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const prNum = attrs.find((a: any) => a.key === "vcs.pr.number");
    expect(prNum?.value?.intValue).toBe(42);
  });

  test("maps fractional attributes to doubleValue, never intValue (CTL-812)", () => {
    // The collector's OTLP/JSON decoder rejects a float inside intValue
    // ("assertInteger: can not decode float as int" → HTTP 400) and the whole
    // batch dead-letters. catalyst-agent metrics (host.cpu_pct, ratelimit
    // paces) are fractional, so they MUST ride as doubleValue.
    const event = {
      ...SAMPLE_EVENT,
      attributes: {
        "event.name": "host.metrics.sampled",
        "host.cpu_pct": 30.3,
        "host.load1": 6.02,
        "ratelimit.seven_day_pace": -0.344,
      },
    } as unknown as CanonicalEvent;
    const payload = buildOtlpPayload([event]) as any;
    const attrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const get = (k: string) => attrs.find((a: any) => a.key === k)?.value;
    expect(get("host.cpu_pct")).toEqual({ doubleValue: 30.3 });
    expect(get("host.load1")).toEqual({ doubleValue: 6.02 });
    expect(get("ratelimit.seven_day_pace")).toEqual({ doubleValue: -0.344 });
    for (const k of ["host.cpu_pct", "host.load1", "ratelimit.seven_day_pace"]) {
      expect(get(k)?.intValue).toBeUndefined();
    }
  });

  test("maps event.id to OTLP logRecordUid (CTL-344)", () => {
    const payload = buildOtlpPayload([SAMPLE_EVENT]) as any;
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(lr.logRecordUid).toBe(SAMPLE_EVENT.id);
  });

  test("omits logRecordUid when event has no id (legacy events)", () => {
    const legacy = { ...SAMPLE_EVENT };
    delete (legacy as { id?: string }).id;
    const payload = buildOtlpPayload([legacy as CanonicalEvent]) as any;
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect("logRecordUid" in lr).toBe(false);
  });
});

describe("OtlpSender flush failure events (CTL-1008 Phase 4)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otlp-fail-test-"));
  });

  function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
    return { ...SAMPLE_EVENT, ...overrides };
  }

  test("appends a forward_failed canonical event after all retries exhausted", async () => {
    global.fetch = mock(() =>
      Promise.reject(new Error("connection refused"))
    ) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const eventLogPath = join(dir, "events.jsonl");
    const dlqPath = join(dir, "dlq.jsonl");

    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:1",
      dlqPath,
      eventLogPath,
      retryDelaysMs: [0, 0, 0],
    });
    await sender.flush([makeEvent()]);

    expect(existsSync(eventLogPath)).toBe(true);
    const lines = readFileSync(eventLogPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const evt = JSON.parse(lines[0]) as CanonicalEvent;
    expect(evt.attributes["event.name"]).toBe("catalyst.observability.forward_failed");
    expect(evt.resource["service.name"]).toBe("catalyst.otel-forward");
    expect((evt.body?.payload as Record<string, unknown>)?.batchSize).toBe(1);

    rmSync(dir, { recursive: true });
  });

  test("does NOT emit failure event for a batch of forward_failed events (loop guard)", async () => {
    global.fetch = mock(() =>
      Promise.reject(new Error("connection refused"))
    ) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const eventLogPath = join(dir, "events2.jsonl");
    const dlqPath = join(dir, "dlq2.jsonl");

    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:1",
      dlqPath,
      eventLogPath,
      retryDelaysMs: [0, 0, 0],
    });

    // Batch that already consists of forward_failed events
    const failureBatch = [
      makeEvent({
        resource: {
          "service.name": "catalyst.otel-forward",
          "service.namespace": "catalyst" as const,
          "service.version": "1.0.0",
          "host.name": "test-host",
          "host.id": "test-id",
        },
        attributes: { "event.name": "catalyst.observability.forward_failed" },
      }),
    ];

    await sender.flush(failureBatch);

    // Loop guard: no forward_failed event appended
    if (existsSync(eventLogPath)) {
      const lines = readFileSync(eventLogPath, "utf8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBe(0);
    }

    rmSync(dir, { recursive: true });
  });

  test("mixed batch (some self, some normal) DOES emit failure event for normal events", async () => {
    global.fetch = mock(() =>
      Promise.reject(new Error("connection refused"))
    ) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const eventLogPath = join(dir, "events-mixed.jsonl");
    const dlqPath = join(dir, "dlq-mixed.jsonl");

    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:1",
      dlqPath,
      eventLogPath,
      retryDelaysMs: [0, 0, 0],
    });

    const mixedBatch = [
      makeEvent({ attributes: { "event.name": "session.heartbeat" } }),
      makeEvent({
        resource: {
          "service.name": "catalyst.otel-forward",
          "service.namespace": "catalyst" as const,
          "service.version": "1.0.0",
          "host.name": "test-host",
          "host.id": "test-id",
        },
        attributes: { "event.name": "catalyst.observability.forward_failed" },
      }),
    ];

    await sender.flush(mixedBatch);

    expect(existsSync(eventLogPath)).toBe(true);
    const lines = readFileSync(eventLogPath, "utf8").trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const evt = JSON.parse(lines[0]) as CanonicalEvent;
    expect(evt.attributes["event.name"]).toBe("catalyst.observability.forward_failed");
    expect((evt.body?.payload as Record<string, unknown>)?.batchSize).toBe(2);

    rmSync(dir, { recursive: true });
  });

  test("successful flush appends no forward_failed event", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 }))
    ) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const eventLogPath = join(dir, "events3.jsonl");
    const dlqPath = join(dir, "dlq3.jsonl");

    const sender = new OtlpSender({ endpoint: "http://127.0.0.1:4318", dlqPath, eventLogPath });
    await sender.flush([makeEvent()]);

    expect(existsSync(eventLogPath)).toBe(false);

    rmSync(dir, { recursive: true });
  });
});
