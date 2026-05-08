import { describe, test, expect } from "bun:test";
import { buildPosthogBatch } from "./posthog.ts";
import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";

const SAMPLE_EVENT: CanonicalEvent = {
  ts: "2026-05-08T04:34:45Z",
  severityText: "INFO",
  severityNumber: 9,
  traceId: null,
  spanId: null,
  resource: { "service.name": "catalyst.session", "service.namespace": "catalyst", "service.version": "8.2.0" },
  attributes: { "event.name": "session.heartbeat", "catalyst.session.id": "sess_123" },
  body: {},
};

describe("buildPosthogBatch", () => {
  test("maps event.name to event field", () => {
    const batch = buildPosthogBatch([SAMPLE_EVENT], "phc_key") as any;
    expect(batch.api_key).toBe("phc_key");
    expect(batch.batch[0].event).toBe("session.heartbeat");
  });

  test("uses service.name as distinct_id", () => {
    const batch = buildPosthogBatch([SAMPLE_EVENT], "phc_key") as any;
    expect(batch.batch[0].distinct_id).toBe("catalyst.session");
  });

  test("includes all attributes in properties", () => {
    const batch = buildPosthogBatch([SAMPLE_EVENT], "phc_key") as any;
    expect(batch.batch[0].properties["catalyst.session.id"]).toBe("sess_123");
    expect(batch.batch[0].properties["$lib"]).toBe("catalyst-otel-forward");
  });
});
