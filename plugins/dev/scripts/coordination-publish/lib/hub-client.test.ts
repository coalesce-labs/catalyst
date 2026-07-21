import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "./hub-client.ts";

function rec(seq: number): Record<string, unknown> {
  return { local_seq: seq, id: `id-${seq}`, attributes: { "event.name": `phase.plan.complete.CTL-${seq}` } };
}

function okFetch() {
  const calls: unknown[] = [];
  const fetchImpl = async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200 } as Response;
  };
  return { fetchImpl, calls };
}

function failFetch() {
  const fetchImpl = async () => ({ ok: false, status: 503 } as Response);
  return { fetchImpl };
}

describe("HubClient (CTL-1488 Phase 3)", () => {
  let dir: string, dlqPath: string, eventLogPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ctl1488-hub-"));
    dlqPath = join(dir, "coordination-publish-dlq.jsonl");
    eventLogPath = join(dir, "events.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("successful POST hits <hubUrl>/coordination/publish and advances lastPublishedSeq", async () => {
    const { fetchImpl, calls } = okFetch();
    let url = "";
    const client = new HubClient({
      hubUrl: "https://hub.example",
      dlqPath,
      retryDelaysMs: [0, 0, 0],
      fetchImpl: async (u: string, init: { body: string }) => { url = u; return fetchImpl(u, init); },
    });
    await client.publish([rec(1), rec(2)]);
    expect(url).toBe("https://hub.example/coordination/publish");
    expect(client.lastPublishedSeq).toBe(2);
    expect(calls.length).toBe(1);
    expect(existsSync(dlqPath)).toBe(false);
  });

  test("failed POST appends the batch to the DLQ and does NOT throw (local-first mirror already happened)", async () => {
    const { fetchImpl } = failFetch();
    const client = new HubClient({ hubUrl: "https://hub.example", dlqPath, retryDelaysMs: [0, 0, 0], fetchImpl });
    await client.publish([rec(1)]); // must not throw
    expect(existsSync(dlqPath)).toBe(true);
    expect(client.lastPublishedSeq).toBe(0); // never advanced on failure
  });

  test("a later successful flush drains the DLQ bounded", async () => {
    // First: two failed publishes queue two DLQ batches.
    const failing = new HubClient({ hubUrl: "https://hub.example", dlqPath, retryDelaysMs: [0, 0, 0], fetchImpl: failFetch().fetchImpl });
    await failing.publish([rec(1)]);
    await failing.publish([rec(2)]);
    expect(readFileSync(dlqPath, "utf8").split("\n").filter(Boolean).length).toBe(2);

    // Then: a healthy client publishes a new batch → primary succeeds AND the DLQ drains.
    const { fetchImpl, calls } = okFetch();
    const healthy = new HubClient({ hubUrl: "https://hub.example", dlqPath, retryDelaysMs: [0, 0, 0], fetchImpl });
    await healthy.publish([rec(3)]);
    // 1 primary + 2 drained
    expect(calls.length).toBe(3);
    expect(existsSync(dlqPath)).toBe(false);
  });

  test("drainDlq() clears a queued backlog independently of a fresh publish, and is failure-isolated while the hub is still down (Codex P1)", async () => {
    // A prior outage queues one DLQ batch.
    const failing = new HubClient({ hubUrl: "https://hub.example", dlqPath, retryDelaysMs: [0, 0, 0], fetchImpl: failFetch().fetchImpl });
    await failing.publish([rec(1)]);
    expect(existsSync(dlqPath)).toBe(true);

    // Hub STILL down: an independent drain must not throw and must leave the backlog requeued.
    await failing.drainDlq();
    expect(existsSync(dlqPath)).toBe(true); // backlog survives a still-down hub

    // Hub recovers: drainDlq with NO new publish still clears the backlog and advances the seq —
    // this is the path that was previously unreachable (publish() only drained after a new batch).
    const { fetchImpl, calls } = okFetch();
    const healthy = new HubClient({ hubUrl: "https://hub.example", dlqPath, retryDelaysMs: [0, 0, 0], fetchImpl });
    await healthy.drainDlq();
    expect(calls.length).toBe(1); // the queued batch delivered without any fresh publish()
    expect(existsSync(dlqPath)).toBe(false);
    expect(healthy.lastPublishedSeq).toBe(1);
  });

  test("after N consecutive failures a coordination_publish_degraded event is appended locally (never silent)", async () => {
    const client = new HubClient({
      hubUrl: "https://hub.example",
      dlqPath,
      eventLogPath,
      degradedThreshold: 2,
      retryDelaysMs: [0, 0, 0],
      fetchImpl: failFetch().fetchImpl,
    });
    await client.publish([rec(1)]);
    expect(existsSync(eventLogPath)).toBe(false); // 1 failure < threshold
    await client.publish([rec(2)]);
    expect(existsSync(eventLogPath)).toBe(true);
    const lines = readFileSync(eventLogPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((e) => e.attributes["event.name"] === "catalyst.observability.coordination_publish_degraded")).toBe(true);
  });

  test("a success resets the consecutive-failure counter", async () => {
    let mode: "fail" | "ok" = "fail";
    const fetchImpl = async () => (mode === "ok" ? ({ ok: true, status: 200 } as Response) : ({ ok: false, status: 503 } as Response));
    const client = new HubClient({ hubUrl: "https://hub.example", dlqPath, eventLogPath, degradedThreshold: 2, retryDelaysMs: [0, 0, 0], fetchImpl });
    await client.publish([rec(1)]); // fail 1
    mode = "ok";
    await client.publish([rec(2)]); // success → resets
    mode = "fail";
    await client.publish([rec(3)]); // fail 1 again (not 2) → no degraded event
    expect(existsSync(eventLogPath)).toBe(false);
  });
});
