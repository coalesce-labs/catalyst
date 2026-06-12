import { describe, test, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCloudflareAEPayload } from "./cloudflare-ae.ts";
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

describe("CloudflareAESender drain-outside-retry (CTL-1060)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "cae-drain-")); });

  test("primary success + seeded DLQ drains without recursion, no primary re-send", async () => {
    let callCount = 0;
    global.fetch = mock(() => {
      callCount++;
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as unknown as typeof fetch;

    const { CloudflareAESender } = await import("./cloudflare-ae.ts");
    const dlqPath = join(dir, "dlq.jsonl");
    appendToDlq(dlqPath, [SAMPLE_EVENT]);

    const sender = new CloudflareAESender({
      accountId: "acc", apiToken: "tok", dataset: "ds", dlqPath,
    });
    await sender.flush([SAMPLE_EVENT]);

    // fetch called for primary event + one event in the DLQ batch
    expect(callCount).toBe(2);
    expect(dlqDepth(dlqPath)).toBe(0);
    rmSync(dir, { recursive: true });
  });

  test("no drain when primary fails: DLQ grows by 1", async () => {
    global.fetch = mock(() =>
      Promise.reject(new Error("down"))
    ) as unknown as typeof fetch;

    const { CloudflareAESender } = await import("./cloudflare-ae.ts");
    const dlqPath = join(dir, "dlq2.jsonl");
    appendToDlq(dlqPath, [SAMPLE_EVENT]);

    const sender = new CloudflareAESender({
      accountId: "acc", apiToken: "tok", dataset: "ds", dlqPath, retryDelaysMs: [0, 0, 0],
    });
    await sender.flush([SAMPLE_EVENT]);

    expect(dlqDepth(dlqPath)).toBe(2);
    rmSync(dir, { recursive: true });
  });
});
