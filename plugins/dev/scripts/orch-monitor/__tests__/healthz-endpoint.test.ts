// healthz-endpoint.test.ts — CTL-1272. HTTP route-plumbing tests for the NEW
// read-only GET /healthz endpoint the peer-HTTP liveness probe (node-presence.mjs)
// hits over the tailnet. Validates the server.ts wiring — the route is mounted,
// returns the { host, daemonAlive, lastTickAgeMs } HealthSnapshot from the
// injected healthReader, and stays a 200 read-only health REPORT (never a 5xx)
// even when it reports an unhealthy/offline daemon. The production health logic
// (daemon-heartbeat freshness → daemonAlive) is exercised by the existing
// daemon-health path; these prove the route is mounted, shaped, and hermetic via
// the injected reader so it never touches the live event log/roster.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

type ServerHandle = ReturnType<typeof createServer>;

function isHealthSnapshot(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.host === "string" &&
    typeof s.daemonAlive === "boolean" &&
    (s.lastTickAgeMs === null || typeof s.lastTickAgeMs === "number")
  );
}

function makeTmpServer(opts: Parameters<typeof createServer>[0] extends infer T ? Partial<T> : never) {
  const tmpDir = mkdtempSync(join(tmpdir(), "healthz-endpoint-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  const server = createServer({
    port: 0,
    wtDir,
    catalystDir: tmpDir,
    startWatcher: false,
    ...opts,
  });
  return { server, tmpDir, baseUrl: `http://localhost:${server.port}` };
}

describe("GET /healthz (CTL-1272 — injected healthReader)", () => {
  let server: ServerHandle;
  let tmpDir: string;
  let baseUrl: string;

  beforeAll(() => {
    ({ server, tmpDir, baseUrl } = makeTmpServer({
      healthReader: () => ({ host: "mini", daemonAlive: true, lastTickAgeMs: 4_200 }),
    }));
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

  it("returns 200 with the { host, daemonAlive, lastTickAgeMs } shape", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(isHealthSnapshot(body)).toBe(true);
  });

  it("flows the injected reader's daemonAlive + small lastTickAgeMs through verbatim", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    const body = (await res.json()) as { host: string; daemonAlive: boolean; lastTickAgeMs: number | null };
    expect(body.host).toBe("mini");
    expect(body.daemonAlive).toBe(true);
    expect(body.lastTickAgeMs).toBe(4_200);
  });
});

describe("GET /healthz — reports an unhealthy daemon as 200, not 5xx", () => {
  let server: ServerHandle;
  let tmpDir: string;
  let baseUrl: string;

  beforeAll(() => {
    ({ server, tmpDir, baseUrl } = makeTmpServer({
      healthReader: () => ({ host: "mini", daemonAlive: false, lastTickAgeMs: null }),
    }));
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

  it("a reader reporting daemonAlive:false still returns 200 (read-only health report)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { daemonAlive: boolean };
    expect(body.daemonAlive).toBe(false);
  });
});

describe("GET /healthz — production default (no healthReader injected)", () => {
  let server: ServerHandle;
  let tmpDir: string;
  let baseUrl: string;

  beforeAll(() => {
    ({ server, tmpDir, baseUrl } = makeTmpServer({}));
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

  it("route is still mounted and returns the production-shaped object without throwing (fail-open)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(isHealthSnapshot(body)).toBe(true);
  });
});
