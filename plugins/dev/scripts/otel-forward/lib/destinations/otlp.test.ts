import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildOtlpPayload } from "./otlp.ts";
import { appendToDlq, dlqDepth, drainDlq } from "../dlq.ts";
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

  test("an unparseable ts never yields a NaN/null timeUnixNano (CTL-1506 Codex P2)", () => {
    const bad = { ...SAMPLE_EVENT, ts: "not-a-date", observedTs: "also-bad" } as unknown as CanonicalEvent;
    const payload = buildOtlpPayload([bad]) as any;
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    // A NaN would JSON-serialize to null and 400 the whole batch (dropping co-riders).
    expect(Number.isFinite(lr.timeUnixNano)).toBe(true);
    expect(lr.timeUnixNano).toBeGreaterThan(0);
    expect(Number.isFinite(lr.observedTimeUnixNano)).toBe(true);
  });

  test("falls back to observedTs when ts is unparseable (CTL-1506)", () => {
    const ev = { ...SAMPLE_EVENT, ts: "garbage" } as unknown as CanonicalEvent; // observedTs valid
    const payload = buildOtlpPayload([ev]) as any;
    const lr = payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(lr.timeUnixNano).toBe(Date.parse(SAMPLE_EVENT.observedTs!) * 1_000_000);
  });
});

// CTL-764 Phase 6: worker.transition attribute pass-through
describe("buildOtlpPayload — worker.transition attributes (CTL-764)", () => {
  function makeTransitionEvent(): CanonicalEvent {
    return {
      ...SAMPLE_EVENT,
      resource: {
        ...SAMPLE_EVENT.resource,
        project: "catalyst-workspace",
        "linear.key": "CTL-764",
        "catalyst.orchestration": "phase-agents",
      },
      attributes: {
        "event.name": "worker.transition.CTL-764",
        "catalyst.worker.ticket": "CTL-764",
        "catalyst.worker.from_disposition": "queued",
        "catalyst.worker.to_disposition": "needs-human",
        "catalyst.worker.from_state": "Research",
        "catalyst.worker.to_state": "Needs You",
        "catalyst.worker.reason": "stall-timeout",
        "phase.attempt": 2,
        "phase.revive_count": 1,
      },
    };
  }

  test("string worker dims map to stringValue", () => {
    const ev = makeTransitionEvent();
    const payload = buildOtlpPayload([ev]) as any;
    const attrs: Array<{ key: string; value: any }> =
      payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const get = (k: string) => attrs.find((a) => a.key === k)?.value?.stringValue;
    expect(get("catalyst.worker.from_disposition")).toBe("queued");
    expect(get("catalyst.worker.to_disposition")).toBe("needs-human");
    expect(get("catalyst.worker.from_state")).toBe("Research");
    expect(get("catalyst.worker.to_state")).toBe("Needs You");
    expect(get("catalyst.worker.reason")).toBe("stall-timeout");
  });

  test("numeric worker dims map to intValue", () => {
    const ev = makeTransitionEvent();
    const payload = buildOtlpPayload([ev]) as any;
    const attrs: Array<{ key: string; value: any }> =
      payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const get = (k: string) => attrs.find((a) => a.key === k)?.value;
    expect(get("phase.attempt")).toEqual({ intValue: 2 });
    expect(get("phase.revive_count")).toEqual({ intValue: 1 });
    expect(get("phase.attempt")?.doubleValue).toBeUndefined();
  });

  test("to_disposition is scalar stringValue (not JSON-array string)", () => {
    const ev = makeTransitionEvent();
    const payload = buildOtlpPayload([ev]) as any;
    const attrs: Array<{ key: string; value: any }> =
      payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const toDisp = attrs.find((a) => a.key === "catalyst.worker.to_disposition")?.value
      ?.stringValue;
    expect(toDisp).toBe("needs-human");
    expect(() => JSON.parse(toDisp ?? "")).toThrow();
  });

  test("resource dims project/linear.key propagate to resourceLogs[0].resource.attributes", () => {
    const ev = makeTransitionEvent();
    const payload = buildOtlpPayload([ev]) as any;
    const resAttrs: Array<{ key: string; value: any }> =
      payload.resourceLogs[0].resource.attributes;
    const get = (k: string) => resAttrs.find((a) => a.key === k)?.value?.stringValue;
    expect(get("project")).toBe("catalyst-workspace");
    expect(get("linear.key")).toBe("CTL-764");
    expect(get("catalyst.orchestration")).toBe("phase-agents");
    expect(get("service.name")).toBe("catalyst.session");
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

  // Use a fresh timestamp so age-partitioning (CTL-1506) doesn't drop events
  // before they reach the network path these tests exercise.
  function makeFreshEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
    return makeEvent({ ts: new Date().toISOString(), ...overrides });
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
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
    });
    await sender.flush([makeFreshEvent()]);

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
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
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
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
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

    const sender = new OtlpSender({ endpoint: "http://127.0.0.1:4318", dlqPath, eventLogPath, lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER });
    await sender.flush([makeFreshEvent()]);

    expect(existsSync(eventLogPath)).toBe(false);

    rmSync(dir, { recursive: true });
  });
});

describe("OtlpSender DLQ drain — outside withRetry (CTL-1060)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otlp-drain-test-"));
  });

  function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
    return { ...SAMPLE_EVENT, ...overrides };
  }

  // Fresh ts so age-partition (CTL-1506) doesn't drop events before reaching the network path.
  function makeFreshEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
    return makeEvent({ ts: new Date().toISOString(), ...overrides });
  }

  test("drain failure does not re-dead-letter the primary (drain is outside withRetry)", async () => {
    // Primary fetch succeeds; all subsequent calls (drain) fail.
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.reject(new Error("drain network failure"));
    }) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "drain-dlq.jsonl");
    const eventLogPath = join(dir, "drain-events.jsonl");

    // Seed DLQ with a known batch (fresh ts so age-partition doesn't drop it)
    appendToDlq(dlqPath, [makeFreshEvent({ attributes: { "event.name": "queued.event" } })]);

    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
    });
    await sender.flush([makeFreshEvent({ attributes: { "event.name": "primary.event" } })]);

    // Primary was delivered successfully — it must NOT be in the DLQ.
    // Only the original queued.event batch should remain (drain failed).
    const remaining = drainDlq(dlqPath);
    expect(remaining.length).toBe(1);
    expect((remaining[0][0] as any).attributes["event.name"]).toBe("queued.event");
    // Drain was attempted (fetch called > 1 time)
    expect(callCount).toBeGreaterThan(1);

    rmSync(dir, { recursive: true });
  });

  test("no drain when primary fails: DLQ grows by primary, drain never attempted", async () => {
    global.fetch = mock(() => Promise.reject(new Error("always fail"))) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "nofail-dlq.jsonl");

    // Seed DLQ with one existing batch (fresh ts so age-partition doesn't drop it)
    appendToDlq(dlqPath, [makeFreshEvent({ attributes: { "event.name": "existing.batch" } })]);
    expect(dlqDepth(dlqPath)).toBe(1);

    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:1",
      dlqPath,
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
    });
    await sender.flush([makeFreshEvent({ attributes: { "event.name": "primary.event" } })]);

    // DLQ now has both: original batch + newly dead-lettered primary
    expect(dlqDepth(dlqPath)).toBe(2);

    rmSync(dir, { recursive: true });
  });

  test("bounded drain across cycles: 60 batches → 10 remain after first flush, 0 after second", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 }))
    ) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "bounded-dlq.jsonl");

    // Seed DLQ with 60 batches (fresh ts so age-partition doesn't drop them)
    for (let i = 0; i < 60; i++) {
      appendToDlq(dlqPath, [makeFreshEvent({ attributes: { "event.name": `batch.${i}` } })]);
    }
    expect(dlqDepth(dlqPath)).toBe(60);

    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
      maxDrainBatches: 50,
    });

    // First flush: drains 50, leaves 10
    await sender.flush([makeFreshEvent()]);
    expect(dlqDepth(dlqPath)).toBe(10);

    // Second flush: drains remaining 10
    await sender.flush([makeFreshEvent()]);
    expect(dlqDepth(dlqPath)).toBe(0);

    rmSync(dir, { recursive: true });
  });

  test("onBatchDelivered is called for primary + each drained batch on success (CTL-1060 Phase 3)", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 200 }))
    ) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "obd-dlq.jsonl");
    appendToDlq(dlqPath, [makeFreshEvent()]);
    appendToDlq(dlqPath, [makeFreshEvent()]);

    let deliveredCount = 0;
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
      onBatchDelivered: () => {
        deliveredCount++;
      },
    });

    await sender.flush([makeFreshEvent()]);
    // 1 primary + 2 DLQ batches = 3 calls to onBatchDelivered
    expect(deliveredCount).toBe(3);
    rmSync(dir, { recursive: true });
  });

  test("onBatchDelivered is NOT called when primary flush fails (CTL-1060 Phase 3)", async () => {
    global.fetch = mock(() => Promise.reject(new Error("down"))) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "obd-fail-dlq.jsonl");

    let deliveredCount = 0;
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:1",
      dlqPath,
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
      onBatchDelivered: () => {
        deliveredCount++;
      },
    });

    await sender.flush([makeFreshEvent()]);
    expect(deliveredCount).toBe(0);
    rmSync(dir, { recursive: true });
  });
});

// CTL-1506 Phase 4: DLQ drain path — age-drop + terminal-drop
describe("OtlpSender Phase 4 — drain age-drop + terminal-drop", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otlp-p4-test-"));
  });

  function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
    return { ...SAMPLE_EVENT, ...overrides };
  }
  function makeFreshEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
    return makeEvent({ ts: new Date().toISOString(), ...overrides });
  }
  function makeAgedEvent(): CanonicalEvent {
    return makeEvent({ ts: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });
  }
  function readDropEvents(p: string): CanonicalEvent[] {
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as CanonicalEvent)
      .filter((e) => e.attributes["event.name"] === "catalyst.observability.forward_dropped");
  }

  test("age-drop on drain: aged entry discarded-with-counter, fresh delivered; DLQ ends empty", async () => {
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "dlq-p4age.jsonl");
    const eventLogPath = join(dir, "events-p4age.jsonl");

    // Seed DLQ: one aged batch, one fresh batch
    appendToDlq(dlqPath, [makeAgedEvent()]);
    appendToDlq(dlqPath, [makeFreshEvent()]);

    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      lokiAcceptWindowMs: 3_600_000,
    });

    // Primary succeeds → triggers drain
    await sender.flush([makeFreshEvent()]);

    expect(dlqDepth(dlqPath)).toBe(0); // both entries consumed (aged-dropped + fresh delivered)
    const drops = readDropEvents(eventLogPath);
    expect(drops.length).toBe(1);
    expect((drops[0].attributes as unknown as Record<string, unknown>)["catalyst.observability.drop_reason"]).toBe("aged");

    rmSync(dir, { recursive: true });
  });

  test("terminal 4xx on a drained fresh batch → entry dropped (counter), not requeued", async () => {
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(new Response(null, { status: 200 })); // primary
      return Promise.resolve(new Response(null, { status: 400 })); // drain → terminal
    }) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "dlq-p4term.jsonl");
    const eventLogPath = join(dir, "events-p4term.jsonl");

    appendToDlq(dlqPath, [makeFreshEvent()]);

    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
      httpRetryPolicy: { maxElapsedMs: 0 },
    });

    await sender.flush([makeFreshEvent()]);

    expect(dlqDepth(dlqPath)).toBe(0); // entry consumed (terminal-dropped), NOT requeued
    const drops = readDropEvents(eventLogPath);
    expect(drops.length).toBe(1);
    expect((drops[0].attributes as unknown as Record<string, unknown>)["catalyst.observability.drop_reason"]).toBe("terminal_4xx");

    rmSync(dir, { recursive: true });
  });

  test("retryable 503 on drain → drain stops, batch + remainder requeued (backpressure preserved)", async () => {
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve(new Response(null, { status: 200 })); // primary
      return Promise.resolve(new Response(null, { status: 503 })); // drain → retryable
    }) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "dlq-p4retry.jsonl");

    appendToDlq(dlqPath, [makeFreshEvent({ attributes: { "event.name": "q1" } })]);
    appendToDlq(dlqPath, [makeFreshEvent({ attributes: { "event.name": "q2" } })]);

    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
      httpRetryPolicy: { maxElapsedMs: 0 },
    });

    await sender.flush([makeFreshEvent()]);

    // Both DLQ entries remain (drain stopped on first failure, requeued)
    expect(dlqDepth(dlqPath)).toBe(2);

    rmSync(dir, { recursive: true });
  });
});

// CTL-1506: HTTP status classification, age-partition, drop counters (Phase 3)
describe("OtlpSender Phase 3 — status classification + age-partition", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otlp-p3-test-"));
  });

  function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
    return { ...SAMPLE_EVENT, ...overrides };
  }

  function makeAgedEvent(): CanonicalEvent {
    // 8 days ago — well outside any Loki accept window
    const ts = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    return makeEvent({ ts });
  }

  function readDropEvents(eventLogPath: string): CanonicalEvent[] {
    if (!existsSync(eventLogPath)) return [];
    return readFileSync(eventLogPath, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as CanonicalEvent)
      .filter((e) => e.attributes["event.name"] === "catalyst.observability.forward_dropped");
  }

  test("503 retryable → fresh batch DLQ'd, forward_failed emitted (fast policy)", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 503 }))
    ) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "dlq-503.jsonl");
    const eventLogPath = join(dir, "events-503.jsonl");
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
    });
    await sender.flush([makeEvent({ ts: new Date().toISOString() })]);
    expect(dlqDepth(dlqPath)).toBe(1);
    const lines = readFileSync(eventLogPath, "utf8").trim().split("\n").filter(Boolean);
    const failed = lines.map((l) => JSON.parse(l) as CanonicalEvent)
      .filter((e) => e.attributes["event.name"] === "catalyst.observability.forward_failed");
    expect(failed.length).toBe(1);
    rmSync(dir, { recursive: true });
  });

  test("400 terminal → dropped, NOT DLQ'd; forward_dropped event emitted", async () => {
    let fetchCalls = 0;
    global.fetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response(null, { status: 400 }));
    }) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "dlq-400.jsonl");
    const eventLogPath = join(dir, "events-400.jsonl");
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
    });
    await sender.flush([makeEvent({ ts: new Date().toISOString() })]);
    expect(dlqDepth(dlqPath)).toBe(0);
    expect(fetchCalls).toBe(1);
    const drops = readDropEvents(eventLogPath);
    expect(drops.length).toBe(1);
    expect((drops[0].attributes as unknown as Record<string, unknown>)["catalyst.observability.drop_reason"]).toBe("terminal_4xx");
    expect((drops[0].body?.payload as Record<string, unknown>)?.count).toBe(1);
    rmSync(dir, { recursive: true });
  });

  test("500 retryable → DLQ'd under fast policy (same as 503)", async () => {
    global.fetch = mock(() =>
      Promise.resolve(new Response(null, { status: 500 }))
    ) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "dlq-500.jsonl");
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
    });
    await sender.flush([makeEvent({ ts: new Date().toISOString() })]);
    expect(dlqDepth(dlqPath)).toBe(1);
    rmSync(dir, { recursive: true });
  });

  test("network error still DLQs fresh batch + emits forward_failed (regression)", async () => {
    global.fetch = mock(() =>
      Promise.reject(new Error("connection refused"))
    ) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "dlq-net.jsonl");
    const eventLogPath = join(dir, "events-net.jsonl");
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:1",
      dlqPath,
      eventLogPath,
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
    });
    await sender.flush([makeEvent({ ts: new Date().toISOString() })]);
    expect(dlqDepth(dlqPath)).toBe(1);
    const lines = readFileSync(eventLogPath, "utf8").trim().split("\n").filter(Boolean);
    const failed = lines.map((l) => JSON.parse(l) as CanonicalEvent)
      .filter((e) => e.attributes["event.name"] === "catalyst.observability.forward_failed");
    expect(failed.length).toBe(1);
    rmSync(dir, { recursive: true });
  });

  test("mixed aged+fresh batch — only fresh POSTed, aged dropped-with-counter, no DLQ", async () => {
    const requestBodies: unknown[] = [];
    global.fetch = mock(async (url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(init.body as string));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "dlq-mixed.jsonl");
    const eventLogPath = join(dir, "events-mixed.jsonl");
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      lokiAcceptWindowMs: 3_600_000,
    });

    const realFresh = makeEvent({ ts: new Date().toISOString() });
    const realAged = makeAgedEvent();

    await sender.flush([realAged, realFresh]);

    // Fetch should be called once with only the fresh record
    expect(requestBodies.length).toBe(1);
    const body = requestBodies[0] as { resourceLogs: unknown[] };
    expect(body.resourceLogs.length).toBe(1); // only the fresh event

    // No DLQ
    expect(dlqDepth(dlqPath)).toBe(0);

    // forward_dropped event with reason="aged" and count=1
    const drops = readDropEvents(eventLogPath);
    expect(drops.length).toBe(1);
    expect((drops[0].attributes as unknown as Record<string, unknown>)["catalyst.observability.drop_reason"]).toBe("aged");
    expect((drops[0].body?.payload as Record<string, unknown>)?.count).toBe(1);

    rmSync(dir, { recursive: true });
  });

  test("fully-aged batch → no send, no DLQ, drop counter emitted", async () => {
    let fetchCalls = 0;
    global.fetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "dlq-allaged.jsonl");
    const eventLogPath = join(dir, "events-allaged.jsonl");
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      lokiAcceptWindowMs: 3_600_000,
    });

    await sender.flush([makeAgedEvent(), makeAgedEvent()]);

    expect(fetchCalls).toBe(0);
    expect(dlqDepth(dlqPath)).toBe(0);
    const drops = readDropEvents(eventLogPath);
    expect(drops.length).toBe(1);
    expect((drops[0].attributes as unknown as Record<string, unknown>)["catalyst.observability.drop_reason"]).toBe("aged");
    expect((drops[0].body?.payload as Record<string, unknown>)?.count).toBe(2);

    rmSync(dir, { recursive: true });
  });

  test("fully-aged primary batch → pre-existing DLQ entries are NOT drained (early-return invariant)", async () => {
    // When all incoming records are aged, flush() returns early before touching the DLQ.
    // This locks in the design: a fully-aged flush is not a trigger for DLQ drainage.
    let fetchCalls = 0;
    global.fetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;

    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "dlq-allaged-withdlq.jsonl");
    const eventLogPath = join(dir, "events-allaged-withdlq.jsonl");

    // Pre-load two DLQ entries
    appendToDlq(dlqPath, [makeEvent({ ts: new Date().toISOString() })]);
    appendToDlq(dlqPath, [makeEvent({ ts: new Date().toISOString() })]);
    expect(dlqDepth(dlqPath)).toBe(2);

    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      lokiAcceptWindowMs: 3_600_000,
    });

    await sender.flush([makeAgedEvent(), makeAgedEvent()]);

    expect(fetchCalls).toBe(0);         // no network calls
    expect(dlqDepth(dlqPath)).toBe(2);  // DLQ untouched — early return before drain
    rmSync(dir, { recursive: true });
  });
});

// CTL-1506: Codex-review remediation (severity, per-attempt aging, unique ids)
describe("OtlpSender CTL-1506 Codex remediation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otlp-codex-test-"));
  });

  function makeEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
    return { ...SAMPLE_EVENT, ...overrides };
  }
  function makeFreshEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
    return makeEvent({ ts: new Date().toISOString(), ...overrides });
  }
  function makeAgedEvent(): CanonicalEvent {
    return makeEvent({ ts: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString() });
  }
  function readEvents(p: string, name: string): CanonicalEvent[] {
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8").trim().split("\n").filter(Boolean)
      .map((l) => JSON.parse(l) as CanonicalEvent)
      .filter((e) => e.attributes["event.name"] === name);
  }
  const readDrops = (p: string) => readEvents(p, "catalyst.observability.forward_dropped");

  test("forward_failed carries ERROR/17; forward_dropped stays WARN/13 (Codex P2)", async () => {
    // Failure path → ERROR
    global.fetch = mock(() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    const { OtlpSender } = await import("./otlp.ts");
    const failLog = join(dir, "sev-failed.jsonl");
    const failSender = new OtlpSender({
      endpoint: "http://127.0.0.1:1",
      dlqPath: join(dir, "sev-failed-dlq.jsonl"),
      eventLogPath: failLog,
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
    });
    await failSender.flush([makeFreshEvent()]);
    const failed = readEvents(failLog, "catalyst.observability.forward_failed");
    expect(failed.length).toBe(1);
    expect(failed[0].severityText).toBe("ERROR");
    expect(failed[0].severityNumber).toBe(17);

    // Drop path (terminal 4xx) → WARN
    global.fetch = mock(() => Promise.resolve(new Response(null, { status: 400 }))) as unknown as typeof fetch;
    const dropLog = join(dir, "sev-drop.jsonl");
    const dropSender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath: join(dir, "sev-drop-dlq.jsonl"),
      eventLogPath: dropLog,
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
    });
    await dropSender.flush([makeFreshEvent()]);
    const drops = readDrops(dropLog);
    expect(drops.length).toBe(1);
    expect(drops[0].severityText).toBe("WARN");
    expect(drops[0].severityNumber).toBe(13);

    rmSync(dir, { recursive: true });
  });

  test("drop counters emitted in the same second get distinct ids (Codex P2)", async () => {
    global.fetch = mock(() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;
    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "uid-dlq.jsonl");
    const eventLogPath = join(dir, "uid-events.jsonl");
    // Two equally-sized aged DLQ entries → two aged drops (count=1 each) in one drain.
    appendToDlq(dlqPath, [makeAgedEvent()]);
    appendToDlq(dlqPath, [makeAgedEvent()]);
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      lokiAcceptWindowMs: 3_600_000,
    });
    await sender.flush([makeFreshEvent()]);
    const drops = readDrops(eventLogPath);
    expect(drops.length).toBe(2);
    // Identical ts (whole-second), event name, and count — distinct only via the seq.
    expect(new Set(drops.map((d) => d.id)).size).toBe(2);
    rmSync(dir, { recursive: true });
  });

  test("a record that ages out mid-retry is dropped-with-counter, never re-POSTed or DLQ'd (Codex P2)", async () => {
    let fetchCalls = 0;
    global.fetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response(null, { status: 503 })); // retryable
    }) as unknown as typeof fetch;
    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "midage-dlq.jsonl");
    const eventLogPath = join(dir, "midage-events.jsonl");
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      lokiAcceptWindowMs: 20, // 20ms window
      httpRetryPolicy: { baseMs: 80, maxElapsedMs: 10_000 }, // first backoff 80ms > window
    });
    // Fresh at entry; ages past the 20ms window during the 80ms retry backoff.
    await sender.flush([makeEvent({ ts: new Date().toISOString() })]);
    expect(fetchCalls).toBe(1);           // never re-POSTed the now-aged record
    expect(dlqDepth(dlqPath)).toBe(0);    // not dead-lettered
    const drops = readDrops(eventLogPath);
    expect(drops.length).toBe(1);
    expect((drops[0].attributes as unknown as Record<string, unknown>)["catalyst.observability.drop_reason"]).toBe("aged");
    rmSync(dir, { recursive: true });
  });

  test("skips the DLQ drain when the primary ages out mid-retry (no confirmed delivery) (Codex P2)", async () => {
    let fetchCalls = 0;
    global.fetch = mock(() => {
      fetchCalls++;
      return Promise.resolve(new Response(null, { status: 503 })); // retryable, never confirms health
    }) as unknown as typeof fetch;
    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "skipdrain-dlq.jsonl");
    const eventLogPath = join(dir, "skipdrain-events.jsonl");
    // A queued entry that must NOT be drained — the backend health was never confirmed.
    appendToDlq(dlqPath, [makeFreshEvent({ attributes: { "event.name": "queued.event" } })]);
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      lokiAcceptWindowMs: 20,
      httpRetryPolicy: { baseMs: 80, maxElapsedMs: 10_000 },
    });
    await sender.flush([makeEvent({ ts: new Date().toISOString() })]); // fresh, ages out mid-retry
    expect(fetchCalls).toBe(1);          // only the primary attempt; drain never ran
    expect(dlqDepth(dlqPath)).toBe(1);   // seeded entry untouched
    rmSync(dir, { recursive: true });
  });

  test("eventLogPath resolver is evaluated at emission time, not construction (month rollover) (Codex P2)", async () => {
    global.fetch = mock(() => Promise.resolve(new Response(null, { status: 400 }))) as unknown as typeof fetch; // terminal → drop counter
    const { OtlpSender } = await import("./otlp.ts");
    const logPath = join(dir, "resolver-events.jsonl");
    let resolved = 0;
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath: join(dir, "resolver-dlq.jsonl"),
      eventLogPath: () => { resolved++; return logPath; },
      httpRetryPolicy: { maxElapsedMs: 0 },
      lokiAcceptWindowMs: Number.MAX_SAFE_INTEGER,
    });
    await sender.flush([makeFreshEvent()]);
    expect(resolved).toBeGreaterThan(0);    // resolver invoked at emit time
    expect(existsSync(logPath)).toBe(true); // wrote to the resolved path
    expect(readDrops(logPath).length).toBe(1);
    rmSync(dir, { recursive: true });
  });

  test("a record within the delivery margin of the cutoff is held back, not sent (Codex P2)", async () => {
    let fetchCalls = 0;
    global.fetch = mock(() => { fetchCalls++; return Promise.resolve(new Response(null, { status: 200 })); }) as unknown as typeof fetch;
    const { OtlpSender } = await import("./otlp.ts");
    const dlqPath = join(dir, "margin-dlq.jsonl");
    const eventLogPath = join(dir, "margin-events.jsonl");
    const sender = new OtlpSender({
      endpoint: "http://127.0.0.1:4318",
      dlqPath,
      eventLogPath,
      lokiAcceptWindowMs: 10_000, // margin = min(timeoutMs 5000, window/4 = 2500) = 2500 → send-window 7500ms
      timeoutMs: 5000,
    });
    // 8s old: inside the 10s window but inside the 2.5s margin band → held back, never POSTed.
    await sender.flush([makeEvent({ ts: new Date(Date.now() - 8_000).toISOString() })]);
    expect(fetchCalls).toBe(0);
    const drops = readDrops(eventLogPath);
    expect(drops.length).toBe(1);
    expect((drops[0].attributes as unknown as Record<string, unknown>)["catalyst.observability.drop_reason"]).toBe("aged");
    rmSync(dir, { recursive: true });
  });
});
