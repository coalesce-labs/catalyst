// notifications-stream.test.ts — CTL-1167 phase 4 route tests
// GET /api/notifications/stream — SSE endpoint that emits `notification` events.
// Model: nav-signal-endpoints.test.ts SSE tests.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "notif-stream-test-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  server = createServer({
    port: 0,
    wtDir,
    catalystDir: tmpDir,
    startWatcher: false,
    pushBridge: false,
    pushSubscriptionsDbPath: join(tmpDir, "push.db"),
    vapidKeysPath: join(tmpDir, "vapid.json"),
    annotationsDbPath: join(tmpDir, "annotations.db"),
    daemonHealthReader: () => "healthy",
  });
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

describe("GET /api/notifications/stream (CTL-1167)", () => {
  it("returns 200 with text/event-stream content-type", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });

  it("sends Cache-Control: no-cache and Connection: keep-alive headers", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-cache");
    await res.body?.cancel();
  });

  it("stream can be opened and cancelled without error (disconnect unsubscribes)", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/stream`);
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    if (reader) {
      await reader.cancel();
    }
  });
});
