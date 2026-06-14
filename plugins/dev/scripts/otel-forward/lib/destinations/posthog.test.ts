import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPosthogBatch } from "./posthog.ts";
import { appendToDlq, dlqDepth } from "../dlq.ts";
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

describe("PosthogSender drain-outside-retry (CTL-1060)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "posthog-drain-")); });

  test("primary success + seeded DLQ drains without recursion, no primary re-send", async () => {
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;

    const { PosthogSender } = await import("./posthog.ts");
    const dlqPath = join(dir, "dlq.jsonl");
    appendToDlq(dlqPath, [SAMPLE_EVENT]);

    const sender = new PosthogSender({ apiKey: "phc_k", host: "http://127.0.0.1:9999", dlqPath });
    await sender.flush([SAMPLE_EVENT]);

    // Two calls: primary + one DLQ drain batch
    expect(callCount).toBe(2);
    expect(dlqDepth(dlqPath)).toBe(0);
    rmSync(dir, { recursive: true });
  });

  test("no drain when primary fails: DLQ grows by 1", async () => {
    global.fetch = mock(() =>
      Promise.reject(new Error("down"))
    ) as unknown as typeof fetch;

    const { PosthogSender } = await import("./posthog.ts");
    const dlqPath = join(dir, "dlq2.jsonl");
    appendToDlq(dlqPath, [SAMPLE_EVENT]);

    const sender = new PosthogSender({ apiKey: "phc_k", host: "http://127.0.0.1:1", dlqPath, retryDelaysMs: [0, 0, 0] });
    await sender.flush([SAMPLE_EVENT]);

    expect(dlqDepth(dlqPath)).toBe(2);
    rmSync(dir, { recursive: true });
  });
});
