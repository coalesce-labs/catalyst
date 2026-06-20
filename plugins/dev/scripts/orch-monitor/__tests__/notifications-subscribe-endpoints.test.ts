// notifications-subscribe-endpoints.test.ts — CTL-1167 phase 3 route tests
// GET /api/notifications/vapid-public-key and POST /api/notifications/subscribe.
// Model: nav-signal-endpoints.test.ts (createServer integration through port 0).
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "notif-subscribe-test-"));
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

describe("GET /api/notifications/vapid-public-key (CTL-1167)", () => {
  it("returns 200 with text/plain content-type", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/vapid-public-key`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
  });

  it("returns a non-empty base64url public key", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/vapid-public-key`);
    const key = await res.text();
    expect(key.length).toBeGreaterThan(0);
    expect(key).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it("returns the SAME key on repeated calls (idempotent key generation)", async () => {
    const first = await (
      await fetch(`${baseUrl}/api/notifications/vapid-public-key`)
    ).text();
    const second = await (
      await fetch(`${baseUrl}/api/notifications/vapid-public-key`)
    ).text();
    expect(first).toBe(second);
  });
});

describe("POST /api/notifications/subscribe (CTL-1167)", () => {
  const validSub = {
    endpoint: "https://push.example/test",
    keys: { p256dh: "ABC123", auth: "DEF456" },
  };

  it("returns 201 for a valid subscription", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validSub),
    });
    expect(res.status).toBe(201);
  });

  it("returns 400 for a body missing keys.p256dh", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://push.example/bad",
        keys: { auth: "A" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for a body missing endpoint", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keys: { p256dh: "P", auth: "A" } }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await fetch(`${baseUrl}/api/notifications/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("is idempotent — re-subscribing the same endpoint returns 201", async () => {
    const sub = {
      endpoint: "https://push.example/idem",
      keys: { p256dh: "P1", auth: "A1" },
    };
    const first = await fetch(`${baseUrl}/api/notifications/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    const second = await fetch(`${baseUrl}/api/notifications/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });
});
