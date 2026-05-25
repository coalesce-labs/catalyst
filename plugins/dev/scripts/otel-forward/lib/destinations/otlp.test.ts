import { describe, test, expect } from "bun:test";
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
  resource: { "service.name": "catalyst.session", "service.namespace": "catalyst", "service.version": "8.2.0" },
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
        "project": "catalyst-workspace",
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

  test("maps numeric attributes to intValue", () => {
    const event: CanonicalEvent = { ...SAMPLE_EVENT, attributes: { "event.name": "test", "vcs.pr.number": 42 } };
    const payload = buildOtlpPayload([event]) as any;
    const attrs = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const prNum = attrs.find((a: any) => a.key === "vcs.pr.number");
    expect(prNum?.value?.intValue).toBe(42);
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
