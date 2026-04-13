import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "orch-monitor-test-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });

  const orchDir = join(wtDir, "orch-test");
  mkdirSync(join(orchDir, "workers"), { recursive: true });

  writeFileSync(
    join(orchDir, "state.json"),
    JSON.stringify({
      id: "orch-test",
      startedAt: new Date().toISOString(),
      currentWave: 1,
      totalWaves: 1,
      waves: [{ wave: 1, status: "in_progress", tickets: ["TEST-1"] }],
    }),
  );

  writeFileSync(
    join(orchDir, "workers", "TEST-1.json"),
    JSON.stringify({
      ticket: "TEST-1",
      orchestrator: "orch-test",
      workerName: "orch-test-TEST-1",
      status: "in_progress",
      phase: 1,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pid: process.pid,
    }),
  );

  server = createServer({ port: 0, wtDir, startWatcher: false });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  void server?.stop(true);
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("SSE server", () => {
  it("should serve index.html at /", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body.toLowerCase()).toContain("<!doctype html");
  });

  it("should serve current snapshot at /api/snapshot", async () => {
    const res = await fetch(`${baseUrl}/api/snapshot`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      orchestrators: Array<{ id: string }>;
    };
    expect(Array.isArray(data.orchestrators)).toBe(true);
    expect(data.orchestrators.length).toBe(1);
    expect(data.orchestrators[0]?.id).toBe("orch-test");
  });

  it("should serve SSE stream at /events", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Read one SSE chunk (the initial snapshot) then abort.
    const reader = res.body!.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("event: snapshot");
    expect(chunk).toContain("data: ");

    await reader.cancel().catch(() => {});
    controller.abort();
  });

  it("should 404 for unknown paths", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist.xyz`);
    expect(res.status).toBe(404);
    await res.text();
  });

  it("rejects path traversal under /public/", async () => {
    for (const attempt of [
      "/public/../../../etc/passwd",
      "/public/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/public/..%2F..%2Fetc%2Fpasswd",
    ]) {
      const res = await fetch(`${baseUrl}${attempt}`);
      expect([403, 404]).toContain(res.status);
      await res.text();
    }
  });

  it("rejects /public/ access to files with non-whitelisted extensions", async () => {
    const res = await fetch(`${baseUrl}/public/something.sh`);
    expect([403, 404]).toContain(res.status);
    await res.text();
  });
});

describe("SSE integration (file change -> SSE push)", () => {
  let wtDir: string;
  let sseServer: ReturnType<typeof createServer>;
  let sseTmp: string;

  beforeAll(() => {
    sseTmp = mkdtempSync(join(tmpdir(), "orch-monitor-sse-"));
    wtDir = join(sseTmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    const orchDir = join(wtDir, "orch-sse");
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ id: "orch-sse", waves: [] }),
    );
    sseServer = createServer({ port: 0, wtDir, startWatcher: true });
  });

  afterAll(() => {
    void sseServer?.stop(true);
    try {
      rmSync(sseTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("delivers a worker-update SSE event after a signal file is written", async () => {
    const controller = new AbortController();
    const res = await fetch(`http://localhost:${sseServer.port}/events`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // Drain the initial snapshot event
    await reader.read();

    const now = new Date().toISOString();
    writeFileSync(
      join(wtDir, "orch-sse", "workers", "SSE-1.json"),
      JSON.stringify({
        ticket: "SSE-1",
        orchestrator: "orch-sse",
        workerName: "orch-sse-SSE-1",
        status: "in_progress",
        phase: 1,
        startedAt: now,
        updatedAt: now,
      }),
    );

    let received = "";
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !received.includes("worker-update")) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value);
    }

    await reader.cancel().catch(() => {});
    controller.abort();

    expect(received).toContain("event: worker-update");
    expect(received).toContain("SSE-1");
  }, 10000);
});
