// CTL-914 (DETAIL3): HTTP route-plumbing tests for the worker-page [history]
// tail endpoint `GET /api/ec-worker-history/<sessionId>`. The conversion LOGIC
// (LogQL shape, line parsing, newest-first) is covered by the injectable unit
// tests in otel-queries.test.ts; these prove the route is mounted, matched,
// sessionId-validated (400, no LogQL injection / path traversal), 503 when Loki
// is absent, and returns parsed rows when a mock Loki streams claude-code lines.
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";
import type { LokiFetcher, LokiQueryResult } from "../lib/loki";

const UUID = "11111111-2222-3333-4444-555555555555";

const historyStream: LokiQueryResult = {
  data: {
    resultType: "streams",
    result: [
      {
        stream: { service_name: "claude-code" },
        values: [
          [
            "1713100000000000000",
            JSON.stringify({
              event_name: "claude_code.tool_result",
              tool_name: "Read",
              tool_input: "types.ts",
              duration_ms: 200,
              model: "claude-opus-4-8",
              success: true,
            }),
          ],
          [
            "1713100005000000000",
            JSON.stringify({
              event_name: "claude_code.tool_result",
              tool_name: "Edit",
              tool_input: "board-data.mjs",
              duration_ms: 1100,
              cost_usd: 0.0042,
              tokens: 318,
              model: "claude-opus-4-8",
              success: true,
            }),
          ],
        ],
      },
    ],
  },
};

let mockLoki: LokiFetcher;
let lokiQueries: string[];

function makeMockLoki(): LokiFetcher {
  return {
    queryRange: (logql: string) => {
      lokiQueries.push(logql);
      return Promise.resolve(historyStream);
    },
    isAvailable: () => true,
  };
}

describe("GET /api/ec-worker-history/:sessionId (CTL-914) — Loki configured", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(() => {
    lokiQueries = [];
    mockLoki = makeMockLoki();
    tmpDir = mkdtempSync(join(tmpdir(), "ec-worker-history-"));
    const wtDir = join(tmpDir, "wt");
    mkdirSync(wtDir, { recursive: true });
    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      lokiFetcher: mockLoki,
      annotationsDbPath: join(tmpDir, "annotations.db"),
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    void server?.stop(true);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("rejects a malformed sessionId with 400 (no injection / traversal)", async () => {
    expect((await fetch(`${baseUrl}/api/ec-worker-history/not a uuid!`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/ec-worker-history/..%2F..%2Fetc`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/ec-worker-history/short`)).status).toBe(400);
  });

  it("returns parsed history rows newest-first for a dead worker's session id", async () => {
    const res = await fetch(`${baseUrl}/api/ec-worker-history/${UUID}?range=24h`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ toolName: string | null; ts: number; durationMs: number | null }>;
    };
    expect(body.data).toHaveLength(2);
    // newest-first
    expect(body.data[0].toolName).toBe("Edit");
    expect(body.data[1].toolName).toBe("Read");
  });

  it("queries Loki with a `| session_id` structured-metadata pipe, never a label matcher", async () => {
    lokiQueries = [];
    await fetch(`${baseUrl}/api/ec-worker-history/${UUID}`);
    expect(lokiQueries.length).toBeGreaterThan(0);
    const q = lokiQueries[lokiQueries.length - 1];
    expect(q).toContain(`| session_id=\`${UUID}\``);
    expect(q).not.toMatch(/\{[^}]*session_id\s*=/);
  });
});

describe("GET /api/ec-worker-history/:sessionId (CTL-914) — Loki absent", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ec-worker-history-noloki-"));
    const wtDir = join(tmpDir, "wt");
    mkdirSync(wtDir, { recursive: true });
    // lokiFetcher: null disables Loki entirely (the createServer contract).
    server = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      lokiFetcher: null,
      annotationsDbPath: join(tmpDir, "annotations.db"),
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    void server?.stop(true);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns 503 (OTel not configured) — the UI degrades to the resident-data page", async () => {
    const res = await fetch(`${baseUrl}/api/ec-worker-history/${UUID}`);
    expect(res.status).toBe(503);
  });

  it("still validates the sessionId first — a bad id is a 400 even without Loki", async () => {
    const res = await fetch(`${baseUrl}/api/ec-worker-history/not a uuid!`);
    expect(res.status).toBe(400);
  });
});
