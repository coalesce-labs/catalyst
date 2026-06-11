import { describe, test, expect } from "bun:test";
import { buildCloudflareAEPayload } from "./cloudflare-ae.ts";
import type { CanonicalEvent } from "../../../orch-monitor/lib/canonical-event.ts";

const SAMPLE_EVENT: CanonicalEvent = {
  ts: "2026-05-08T04:34:45Z",
  id: "11111111-2222-4333-8444-555555555555",
  severityText: "INFO",
  severityNumber: 9,
  traceId: null,
  spanId: null,
  resource: {
    "service.name": "catalyst.session",
    "service.namespace": "catalyst" as const,
    "service.version": "8.2.0",
    "host.name": "test-host",
    "host.id": "test-id-0000",
  },
  attributes: { "event.name": "session.heartbeat" },
  body: {},
};

describe("buildCloudflareAEPayload", () => {
  test("indexes include event.name and service.name", () => {
    const payload = buildCloudflareAEPayload(SAMPLE_EVENT);
    expect(payload.indexes).toContain("session.heartbeat");
    expect(payload.indexes).toContain("catalyst.session");
  });

  test("blobs contain JSON-encoded full event", () => {
    const payload = buildCloudflareAEPayload(SAMPLE_EVENT);
    expect(payload.blobs).toHaveLength(1);
    const parsed = JSON.parse(payload.blobs[0]);
    expect(parsed.ts).toBe("2026-05-08T04:34:45Z");
  });
});
