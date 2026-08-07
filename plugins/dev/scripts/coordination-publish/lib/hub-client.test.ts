import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HubClient } from "./hub-client.ts";

function rec(seq: number): Record<string, unknown> {
  return { local_seq: seq, id: `id-${seq}`, attributes: { "event.name": `phase.plan.complete.CTL-${seq}` } };
}

function okFetch() {
  const calls: Array<{ records: unknown[] }> = [];
  const fetchImpl = async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body) as { records: unknown[] });
    return { ok: true, status: 200 } as Response;
  };
  return { fetchImpl, calls };
}

function okFetchCapturingHeaders() {
  const calls: Array<{ headers: Record<string, string>; records: unknown[] }> = [];
  const fetchImpl = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    const body = JSON.parse(init.body) as { records: unknown[] };
    calls.push({ headers: { ...init.headers }, records: body.records });
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

  test("re-throws when the hub is down AND the DLQ write also fails, so flushToHub retains the batch (Codex P1)", async () => {
    // A directory at dlqPath makes appendFileSync throw EISDIR — the ENOSPC/EACCES edge where the batch
    // reaches NEITHER the hub nor durable storage. publish() must REJECT (not silently resolve) so
    // flushToHub retains the batch for retry instead of splicing it out of egress.
    mkdirSync(dlqPath);
    const client = new HubClient({
      hubUrl: "https://hub.example",
      dlqPath,
      eventLogPath,
      degradedThreshold: 1,
      retryDelaysMs: [0, 0, 0],
      fetchImpl: failFetch().fetchImpl,
    });
    await expect(client.publish([rec(1)])).rejects.toThrow();
    // ... but the outage is still observable — seq never advanced, degraded event still emitted first.
    expect(client.lastPublishedSeq).toBe(0);
    expect(existsSync(eventLogPath)).toBe(true);
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

  // Phase 1: bearer auth + body.payload stripping (CTL-1668)
  test("sendBatch sets Authorization: Bearer <token> when token configured", async () => {
    const { fetchImpl, calls } = okFetchCapturingHeaders();
    const client = new HubClient({ hubUrl: "https://hub.example", dlqPath, token: "tok-123", retryDelaysMs: [0, 0, 0], fetchImpl });
    await client.publish([rec(1)]);
    expect(calls[0].headers["Authorization"]).toBe("Bearer tok-123");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
  });

  test("sendBatch omits Authorization header when no token", async () => {
    const { fetchImpl, calls } = okFetchCapturingHeaders();
    const client = new HubClient({ hubUrl: "https://hub.example", dlqPath, retryDelaysMs: [0, 0, 0], fetchImpl });
    await client.publish([rec(1)]);
    expect(calls[0].headers["Authorization"]).toBeUndefined();
  });

  test("posted records omit body.payload but keep everything else", async () => {
    const { fetchImpl, calls } = okFetch();
    const client = new HubClient({ hubUrl: "https://hub.example", dlqPath, token: "t", retryDelaysMs: [0, 0, 0], fetchImpl });
    const r = { local_seq: 1, id: "e1", body: { name: "x", payload: { big: "blob" } }, attributes: {} };
    await client.publish([r]);
    const sent = calls[0].records[0] as Record<string, unknown>;
    expect((sent.body as Record<string, unknown>).payload).toBeUndefined();
    expect((sent.body as Record<string, unknown>).name).toBe("x");
    expect(sent.id).toBe("e1");
    expect(sent.local_seq).toBe(1);
  });

  test("stripping does not mutate the caller's record (mirror keeps body.payload)", async () => {
    const { fetchImpl } = okFetch();
    const client = new HubClient({ hubUrl: "https://hub.example", dlqPath, retryDelaysMs: [0, 0, 0], fetchImpl });
    const r = { local_seq: 1, id: "e1", body: { payload: { big: "blob" } }, attributes: {} };
    await client.publish([r]);
    expect((r.body as Record<string, unknown>).payload).toEqual({ big: "blob" });
  });
});
