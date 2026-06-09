// cluster-signal-endpoints.test.ts — HTTP route-plumbing tests for the per-node
// cluster-health projection routes (CTL-898, SHELL8): GET /api/cluster (one-shot)
// and GET /api/cluster/stream (SSE `cluster` frames). Validates the server.ts
// wiring — the routes are mounted, return the projected ClusterSignal shape from
// the injected cluster reader, and the stream emits a `cluster` event on connect.
// The projection LOGIC (cluster-view grouping + the deriveClusterSignal strip) is
// covered exhaustively by the pure unit tests in cluster-view.test.ts /
// cluster-signal.test.ts; these prove the route is mounted, shaped, and rides the
// read-model push transport. Single-host vs multi-host is exercised via the
// injected reader so the routes never touch the live event log/roster.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
import { assembleClusterView } from "../lib/cluster-view.mjs";
import type { ClusterSignal } from "../lib/cluster-signal.mjs";
import type { BoardPayload } from "../lib/board-data.mjs";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

const now = Date.now();
const at = (msAgo: number) => new Date(now - msAgo).toISOString();

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cluster-signal-endpoint-"));
  const wtDir = join(tmpDir, "wt");
  mkdirSync(wtDir, { recursive: true });
  // Inject a deterministic MULTI-HOST cluster view so the routes don't read the
  // live event log/roster — proves the per-node projection flows through intact.
  server = createServer({
    port: 0,
    wtDir,
    catalystDir: tmpDir,
    startWatcher: false,
    clusterReader: (board: BoardPayload) =>
      assembleClusterView({
        board,
        ownerHostById: {},
        hosts: ["mini", "studio"],
        heartbeats: { mini: at(2_000), studio: at(20 * 60_000) },
        now,
      }),
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

function isClusterSignal(v: unknown): v is ClusterSignal {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.singleHost === "boolean" &&
    typeof s.generatedAt === "string" &&
    Array.isArray(s.nodes)
  );
}

describe("GET /api/cluster (CTL-898 one-shot)", () => {
  it("returns the projected per-node ClusterSignal shape", async () => {
    const res = await fetch(`${baseUrl}/api/cluster`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(isClusterSignal(body)).toBe(true);
  });

  it("projects each roster node's host + heartbeat-overlay status (multi-host)", async () => {
    const res = await fetch(`${baseUrl}/api/cluster`);
    const body = (await res.json()) as ClusterSignal;
    expect(body.singleHost).toBe(false);
    expect(body.nodes).toEqual([
      { host: "mini", status: "live" },
      { host: "studio", status: "offline" },
    ]);
  });
});

describe("GET /api/cluster/stream (CTL-898 SSE)", () => {
  it("is a text/event-stream that emits a `cluster` frame on connect", async () => {
    const res = await fetch(`${baseUrl}/api/cluster/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeTruthy();
    const decoder = new TextDecoder();
    let buf = "";
    if (reader) {
      for (let i = 0; i < 5 && !buf.includes("\n\n"); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      await reader.cancel();
    }
    expect(buf).toContain("event: cluster");
    const dataLine = buf.split("\n").find((l) => l.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    const payload: unknown = JSON.parse((dataLine as string).slice("data: ".length));
    expect(isClusterSignal(payload)).toBe(true);
    expect((payload as ClusterSignal).nodes.map((n) => n.host)).toEqual([
      "mini",
      "studio",
    ]);
  });
});

describe("GET /api/cluster — single-host identity no-op", () => {
  it("a single-host reader projects one node + singleHost:true", async () => {
    const tmp2 = mkdtempSync(join(tmpdir(), "cluster-signal-single-"));
    const wt2 = join(tmp2, "wt");
    mkdirSync(wt2, { recursive: true });
    const single = createServer({
      port: 0,
      wtDir: wt2,
      catalystDir: tmp2,
      startWatcher: false,
      clusterReader: (board: BoardPayload) =>
        assembleClusterView({
          board,
          ownerHostById: {},
          hosts: ["mini"],
          heartbeats: { mini: at(2_000) },
          now,
        }),
    });
    try {
      const res = await fetch(`http://localhost:${single.port}/api/cluster`);
      const body = (await res.json()) as ClusterSignal;
      expect(body.singleHost).toBe(true);
      expect(body.nodes).toEqual([{ host: "mini", status: "live" }]);
    } finally {
      void single.stop(true);
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});
