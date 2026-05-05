import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, startTerminalOnly } from "../server";
import type { BriefingProvider } from "../lib/ai-briefing";
import type { MonitorSnapshot } from "../lib/state-reader";
import type { LinearTicket } from "../lib/linear";
import { createPreviewFetcher } from "../lib/preview-status";

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

  const annotationsDbPath = join(tmpDir, "annotations.db");
  server = createServer({ port: 0, wtDir, startWatcher: false, annotationsDbPath });
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

    const reader = res.body!.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("event: snapshot");
    expect(chunk).toContain("data: ");

    await reader.cancel().catch(() => {});
    controller.abort();
  });

  it("should deliver initial snapshot in envelope format", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);

    const dataMatch = chunk.match(/data: (.+)/);
    expect(dataMatch).toBeTruthy();
    const envelope = JSON.parse(dataMatch![1]);
    expect(envelope.type).toBe("snapshot");
    expect(typeof envelope.timestamp).toBe("string");
    expect(envelope.source).toBe("filesystem");
    expect(envelope.data).toBeDefined();
    expect(envelope.data.orchestrators).toBeDefined();

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

  it("should return session detail at /api/session/:orchId/:ticket", async () => {
    const res = await fetch(`${baseUrl}/api/session/orch-test/TEST-1`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      orchId: string;
      worker: { ticket: string; status: string };
    };
    expect(data.orchId).toBe("orch-test");
    expect(data.worker.ticket).toBe("TEST-1");
    expect(data.worker.status).toBe("in_progress");
  });

  it("should 404 for nonexistent session", async () => {
    const res = await fetch(`${baseUrl}/api/session/orch-test/NONEXISTENT`);
    expect(res.status).toBe(404);
    await res.text();
  });

  it("should 404 for nonexistent orchestrator", async () => {
    const res = await fetch(`${baseUrl}/api/session/orch-fake/TEST-1`);
    expect(res.status).toBe(404);
    await res.text();
  });

  it("should 400 for path traversal in ticket", async () => {
    const res = await fetch(
      `${baseUrl}/api/session/orch-test/${encodeURIComponent("../../etc/passwd")}`,
    );
    expect(res.status).toBe(400);
    await res.text();
  });

  it("should 400 for path traversal in orchId", async () => {
    const res = await fetch(
      `${baseUrl}/api/session/${encodeURIComponent("../secret")}/TEST-1`,
    );
    expect(res.status).toBe(400);
    await res.text();
  });

  it("should return null rollup at /api/rollup/:orchId when no PRs exist", async () => {
    const res = await fetch(`${baseUrl}/api/rollup/orch-test`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { orchId: string; rollup: unknown };
    expect(data.orchId).toBe("orch-test");
    expect(data.rollup).toBeNull();
  });

  it("should 404 for nonexistent orchestrator at /api/rollup/:orchId", async () => {
    const res = await fetch(`${baseUrl}/api/rollup/orch-does-not-exist`);
    expect(res.status).toBe(404);
    await res.text();
  });

  it("should 400 for path traversal at /api/rollup/:orchId", async () => {
    const res = await fetch(
      `${baseUrl}/api/rollup/${encodeURIComponent("../secret")}`,
    );
    expect(res.status).toBe(400);
    await res.text();
  });
});

describe("SSE filtering", () => {
  it("delivers all events when no filter is set", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events`, { signal: controller.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("event: snapshot");
    await reader.cancel().catch(() => {});
    controller.abort();
  });

  it("delivers initial snapshot even with a type filter", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/events?filter=worker-update`, {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("event: snapshot");
    await reader.cancel().catch(() => {});
    controller.abort();
  });

  it("accepts valid filter params without error", async () => {
    const controller = new AbortController();
    const res = await fetch(
      `${baseUrl}/events?filter=snapshot,worker-update&session=s1&workspace=ws1`,
      { signal: controller.signal },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.body!.getReader().cancel().catch(() => {});
    controller.abort();
  });
});

describe("Annotation API", () => {
  it("GET /api/annotations returns empty initially", async () => {
    const res = await fetch(`${baseUrl}/api/annotations`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { annotations: Record<string, unknown> };
    expect(data.annotations).toBeDefined();
  });

  it("PUT /api/annotations/:id sets display name", async () => {
    const res = await fetch(`${baseUrl}/api/annotations/TEST-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "my worker" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { annotation: { displayName: string } };
    expect(data.annotation.displayName).toBe("my worker");
  });

  it("PUT /api/annotations/:id adds flags", async () => {
    const res = await fetch(`${baseUrl}/api/annotations/TEST-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addFlags: ["starred"] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { annotation: { flags: string[] } };
    expect(data.annotation.flags).toContain("starred");
  });

  it("PUT /api/annotations/:id adds tags", async () => {
    const res = await fetch(`${baseUrl}/api/annotations/TEST-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addTags: ["refactor"] }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { annotation: { tags: string[] } };
    expect(data.annotation.tags).toContain("refactor");
  });

  it("PUT /api/annotations/:id adds notes", async () => {
    const res = await fetch(`${baseUrl}/api/annotations/TEST-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addNote: "flaky test" }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { annotation: { notes: Array<{ text: string }> } };
    expect(data.annotation.notes.some((n) => n.text === "flaky test")).toBe(true);
  });

  it("DELETE /api/annotations/:id removes annotation", async () => {
    await fetch(`${baseUrl}/api/annotations/TEST-DEL`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "to delete" }),
    });
    const del = await fetch(`${baseUrl}/api/annotations/TEST-DEL`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    const res = await fetch(`${baseUrl}/api/annotations`);
    const data = (await res.json()) as { annotations: Record<string, unknown> };
    expect(data.annotations["TEST-DEL"]).toBeUndefined();
  });

  it("PUT /api/annotations/:id rejects invalid flag values", async () => {
    const res = await fetch(`${baseUrl}/api/annotations/TEST-1`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addFlags: ["invalid-flag"] }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/annotations returns previously set annotations", async () => {
    const res = await fetch(`${baseUrl}/api/annotations`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { annotations: Record<string, { displayName: string }> };
    expect(data.annotations["TEST-1"]?.displayName).toBe("my worker");
  });
});

describe("OTel API endpoints", () => {
  it("returns disabled status when OTel is not configured", async () => {
    const res = await fetch(`${baseUrl}/api/otel/status`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      enabled: boolean;
      prometheus: boolean;
      loki: boolean;
    };
    expect(data.enabled).toBe(false);
    expect(data.prometheus).toBe(false);
    expect(data.loki).toBe(false);
  });

  it("returns 503 for /api/otel/cost when not configured", async () => {
    const res = await fetch(`${baseUrl}/api/otel/cost`);
    expect(res.status).toBe(503);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("OTel not configured");
  });

  it("returns 503 for /api/otel/tokens when not configured", async () => {
    const res = await fetch(`${baseUrl}/api/otel/tokens`);
    expect(res.status).toBe(503);
  });

  it("returns 503 for /api/otel/tools when not configured", async () => {
    const res = await fetch(`${baseUrl}/api/otel/tools`);
    expect(res.status).toBe(503);
  });

  it("returns 503 for /api/otel/errors when not configured", async () => {
    const res = await fetch(`${baseUrl}/api/otel/errors`);
    expect(res.status).toBe(503);
  });

  it("returns 503 for /api/otel/cost-validation when not configured", async () => {
    const res = await fetch(`${baseUrl}/api/otel/cost-validation`);
    expect(res.status).toBe(503);
  });

  it("returns 503 for /api/otel/cost-rate when not configured", async () => {
    const res = await fetch(`${baseUrl}/api/otel/cost-rate`);
    expect(res.status).toBe(503);
  });
});

describe("OTel health endpoint (/api/health/otel)", () => {
  it("returns configured=false when no OTel URLs are set", async () => {
    const res = await fetch(`${baseUrl}/api/health/otel`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      configured: boolean;
      prometheus: { url: string | null; reachable: boolean };
      loki: { url: string | null; reachable: boolean };
    };
    expect(data.configured).toBe(false);
    expect(data.prometheus).toEqual({ url: null, reachable: false });
    expect(data.loki).toEqual({ url: null, reachable: false });
  });

  it("uses the injected otelHealthChecker when provided", async () => {
    let checkCount = 0;
    const customChecker = {
      check: () => {
        checkCount++;
        return Promise.resolve({
          configured: true,
          prometheus: { url: "http://prom.example", reachable: false },
          loki: { url: "http://loki.example", reachable: true },
        });
      },
    };
    const tmp = mkdtempSync(join(tmpdir(), "orch-monitor-health-"));
    const wtDir = join(tmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    const healthServer = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      prStatusFetcher: null,
      linearFetcher: null,
      otelHealthChecker: customChecker,
      annotationsDbPath: join(tmp, "annotations.db"),
    });
    try {
      const res = await fetch(`http://localhost:${healthServer.port}/api/health/otel`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        configured: boolean;
        prometheus: { url: string | null; reachable: boolean };
        loki: { url: string | null; reachable: boolean };
      };
      expect(data.configured).toBe(true);
      expect(data.prometheus).toEqual({ url: "http://prom.example", reachable: false });
      expect(data.loki).toEqual({ url: "http://loki.example", reachable: true });
      expect(checkCount).toBe(1);
    } finally {
      void healthServer.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("OTel API with mock clients", () => {
  let otelServer: ReturnType<typeof createServer>;
  let otelUrl: string;
  let otelTmp: string;

  beforeAll(() => {
    otelTmp = mkdtempSync(join(tmpdir(), "orch-monitor-otel-"));
    const wtDir = join(otelTmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    const orchDir = join(wtDir, "orch-otel");
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ id: "orch-otel", waves: [] }),
    );
    writeFileSync(
      join(orchDir, "workers", "CTL-99.json"),
      JSON.stringify({
        ticket: "CTL-99",
        orchestrator: "orch-otel",
        workerName: "w",
        status: "done",
        phase: 6,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        cost: { costUSD: 1.5, inputTokens: 10000 },
      }),
    );

    const mockProm = {
      query: () =>
        Promise.resolve({
          data: {
            resultType: "vector",
            result: [
              {
                metric: { linear_key: "CTL-99" },
                value: [0, "1.55"] as [number, string],
              },
            ],
          },
        }),
      queryRange: () => Promise.resolve(null),
      isAvailable: () => true,
    };
    const mockLoki = {
      queryRange: () =>
        Promise.resolve({
          data: {
            resultType: "streams",
            result: [
              {
                stream: { service_name: "claude-code.s1" },
                values: [["1713100000000000000", "error line"]] as Array<[string, string]>,
              },
            ],
          },
        }),
      isAvailable: () => true,
    };

    otelServer = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      prStatusFetcher: null,
      linearFetcher: null,
      prometheusFetcher: mockProm,
      lokiFetcher: mockLoki,
      annotationsDbPath: join(otelTmp, "annotations.db"),
    });
    otelUrl = `http://localhost:${otelServer.port}`;
  });

  afterAll(() => {
    void otelServer?.stop(true);
    try {
      rmSync(otelTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns enabled status with mock clients", async () => {
    const res = await fetch(`${otelUrl}/api/otel/status`);
    const data = (await res.json()) as {
      enabled: boolean;
      prometheus: boolean;
      loki: boolean;
    };
    expect(data.enabled).toBe(true);
    expect(data.prometheus).toBe(true);
    expect(data.loki).toBe(true);
  });

  it("returns cost data from /api/otel/cost", async () => {
    const res = await fetch(`${otelUrl}/api/otel/cost?range=1h`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, number> | null };
    expect(body.data).not.toBeNull();
    expect(body.data!["CTL-99"]).toBeCloseTo(1.55);
  });

  it("returns errors from /api/otel/errors", async () => {
    const res = await fetch(`${otelUrl}/api/otel/errors?range=1h&limit=10`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ line: string }> | null;
    };
    expect(body.data).not.toBeNull();
    expect(body.data!.length).toBeGreaterThan(0);
  });

  it("returns cost validation from /api/otel/cost-validation", async () => {
    const res = await fetch(`${otelUrl}/api/otel/cost-validation`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ ticket: string; discrepancy: number }> | null;
    };
    expect(body.data).not.toBeNull();
    const entry = body.data!.find((e) => e.ticket === "CTL-99");
    expect(entry).toBeDefined();
    expect(entry!.discrepancy).toBeCloseTo(0.05);
  });

  it("returns token data from /api/otel/tokens", async () => {
    const res = await fetch(`${otelUrl}/api/otel/tokens?range=1h`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { tokens: Record<string, number> | null; cacheHitRate: number | null };
    };
    expect(body.data).toBeDefined();
  });

  it("returns cost-rate data from /api/otel/cost-rate", async () => {
    const res = await fetch(`${otelUrl}/api/otel/cost-rate?interval=5m`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, number> | null };
    expect(body.data).not.toBeUndefined();
  });
});

describe("PR merge write-through to signal file", () => {
  let mergeServer: ReturnType<typeof createServer>;
  let mergeUrl: string;
  let mergeTmp: string;
  let signalPath: string;

  beforeAll(() => {
    mergeTmp = mkdtempSync(join(tmpdir(), "orch-monitor-merge-"));
    const wtDir = join(mergeTmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    const orchDir = join(wtDir, "orch-merge");
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ id: "orch-merge", waves: [] }),
    );
    signalPath = join(orchDir, "workers", "CTL-WT-1.json");
    writeFileSync(
      signalPath,
      JSON.stringify({
        ticket: "CTL-WT-1",
        orchestrator: "orch-merge",
        workerName: "orch-merge-CTL-WT-1",
        status: "pr-created",
        phase: 5,
        startedAt: "2026-04-16T10:00:00Z",
        updatedAt: "2026-04-16T10:05:00Z",
        pr: {
          number: 42,
          url: "https://github.com/owner/repo/pull/42",
          ciStatus: "pending",
          prOpenedAt: "2026-04-16T10:05:00Z",
        },
      }),
    );

    // Mock fetcher: always returns MERGED for this PR
    const mockPrFetcher = {
      get: () => ({
        number: 42,
        state: "MERGED" as const,
        mergedAt: "2026-04-16T10:30:00Z",
        mergeStateStatus: "UNKNOWN" as const,
        isDraft: false,
        fetchedAt: new Date().toISOString(),
        unknownStreak: 0,
        nextRetryAt: null,
      }),
      refreshAll: () => Promise.resolve(),
      force: () => Promise.resolve(),
      start: () => {},
      stop: () => {},
    };

    mergeServer = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      prStatusFetcher: mockPrFetcher,
      prStatusRefreshMs: 0,
      linearFetcher: null,
      annotationsDbPath: join(mergeTmp, "annotations.db"),
    });
    mergeUrl = `http://localhost:${mergeServer.port}`;
  });

  afterAll(() => {
    void mergeServer?.stop(true);
    try {
      rmSync(mergeTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("writes done/merged/mergedAt to signal file when gh reports MERGED", async () => {
    const res = await fetch(`${mergeUrl}/api/snapshot`);
    expect(res.status).toBe(200);
    await res.json();

    const onDisk = JSON.parse(readFileSync(signalPath, "utf8")) as {
      status: string;
      phase: number;
      pr: { ciStatus: string; mergedAt: string; number: number };
    };
    expect(onDisk.status).toBe("done");
    expect(onDisk.phase).toBe(6);
    expect(onDisk.pr.ciStatus).toBe("merged");
    expect(onDisk.pr.mergedAt).toBe("2026-04-16T10:30:00Z");
    expect(onDisk.pr.number).toBe(42);
  });
});

describe("React UI index.html", () => {
  it("serves React app entry point", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain('id="root"');
    expect(html).toContain('type="module"');
  });

  it("references Vite-built CSS asset", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    expect(html).toContain('rel="stylesheet"');
    expect(html).toContain("/assets/");
  });

  it("serves built JS asset", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    const match = html.match(/src="(\/assets\/index-[^"]+\.js)"/);
    expect(match).toBeTruthy();
    if (match) {
      const jsRes = await fetch(`${baseUrl}${match[1]}`);
      expect(jsRes.status).toBe(200);
      const ct = jsRes.headers.get("content-type") || "";
      expect(ct).toContain("javascript");
    }
  });

  it("serves built CSS asset", async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();
    const match = html.match(/href="(\/assets\/index-[^"]+\.css)"/);
    expect(match).toBeTruthy();
    if (match) {
      const cssRes = await fetch(`${baseUrl}${match[1]}`);
      expect(cssRes.status).toBe(200);
      const ct = cssRes.headers.get("content-type") || "";
      expect(ct).toContain("css");
    }
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
    sseServer = createServer({ port: 0, wtDir, startWatcher: true, annotationsDbPath: join(sseTmp, "annotations.db") });
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

describe("SQLite session endpoints", () => {
  let sessTmp: string;
  let sessServer: ReturnType<typeof createServer>;
  let sessBaseUrl: string;
  let dbPath: string;

  beforeAll(() => {
    sessTmp = mkdtempSync(join(tmpdir(), "orch-monitor-sess-"));
    const wtDir = join(sessTmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    dbPath = join(sessTmp, "catalyst.db");

    const migDir = join(__dirname, "..", "..", "db-migrations");
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA foreign_keys = ON;");
    for (const f of [
      "001_initial_schema.sql",
      "002_session_context.sql",
      "003_archives.sql",
    ]) {
      db.exec(readFileSync(join(migDir, f), "utf8"));
    }
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO sessions (session_id, workflow_id, ticket_key, status, phase, started_at, updated_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?)`,
      ["solo-1", "CTL-40", "researching", 1, now, now],
    );
    db.run(
      `INSERT INTO sessions (session_id, workflow_id, ticket_key, status, phase, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["orch-1", "orch-abc", "CTL-50", "in_progress", 2, now, now],
    );
    db.close();

    sessServer = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      dbPath,
      annotationsDbPath: join(sessTmp, "annotations.db"),
    });
    sessBaseUrl = `http://localhost:${sessServer.port}`;
  });

  afterAll(() => {
    void sessServer?.stop(true);
    try {
      rmSync(sessTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns all sessions by default", async () => {
    const res = await fetch(`${sessBaseUrl}/api/sessions`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      available: boolean;
      sessions: { sessionId: string }[];
    };
    expect(data.available).toBe(true);
    expect(data.sessions).toHaveLength(2);
  });

  it("filters to solo sessions when ?solo=true", async () => {
    const res = await fetch(`${sessBaseUrl}/api/sessions?solo=true`);
    const data = (await res.json()) as {
      sessions: { sessionId: string; workflowId: string | null }[];
    };
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].sessionId).toBe("solo-1");
    expect(data.sessions[0].workflowId).toBeNull();
  });

  it("filters by ticket", async () => {
    const res = await fetch(`${sessBaseUrl}/api/sessions?ticket=CTL-50`);
    const data = (await res.json()) as { sessions: { sessionId: string }[] };
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].sessionId).toBe("orch-1");
  });

  it("includes sessions in /api/snapshot", async () => {
    const res = await fetch(`${sessBaseUrl}/api/snapshot`);
    const data = (await res.json()) as {
      sessionStoreAvailable: boolean;
      sessions: { sessionId: string }[];
    };
    expect(data.sessionStoreAvailable).toBe(true);
    expect(data.sessions.length).toBeGreaterThanOrEqual(2);
  });
});

describe("History API endpoints", () => {
  let histTmp: string;
  let histServer: ReturnType<typeof createServer>;
  let histBaseUrl: string;
  let histDbPath: string;

  beforeAll(() => {
    histTmp = mkdtempSync(join(tmpdir(), "orch-monitor-hist-"));
    const wtDir = join(histTmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    histDbPath = join(histTmp, "catalyst.db");

    const migDir2 = join(__dirname, "..", "..", "db-migrations");
    const db = new Database(histDbPath, { create: true });
    db.exec("PRAGMA foreign_keys = ON;");
    for (const f of [
      "001_initial_schema.sql",
      "002_session_context.sql",
      "003_archives.sql",
    ]) {
      db.exec(readFileSync(join(migDir2, f), "utf8"));
    }

    db.run(
      `INSERT INTO sessions (session_id, skill_name, ticket_key, label, status, phase, started_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["h1", "oneshot", "CTL-10", "fix auth", "done", 6, "2026-04-10T10:00:00Z", "2026-04-10T11:00:00Z", "2026-04-10T11:00:00Z"],
    );
    db.run(
      `INSERT INTO sessions (session_id, skill_name, ticket_key, label, status, phase, started_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["h2", "research", "CTL-20", "explore caching", "failed", 3, "2026-04-14T10:00:00Z", "2026-04-14T11:00:00Z", "2026-04-14T11:00:00Z"],
    );
    db.run(
      `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["h1", 2.50, 60000, 5000, 2000, 1000, 0, "2026-04-10T11:00:00Z"],
    );
    db.run(
      `INSERT INTO session_metrics (session_id, cost_usd, duration_ms, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ["h2", 1.00, 30000, 2000, 1000, 500, 0, "2026-04-14T11:00:00Z"],
    );
    db.run(
      `INSERT INTO session_tools (session_id, tool_name, call_count, total_duration_ms, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["h1", "Read", 30, 3000, "2026-04-10T11:00:00Z"],
    );
    db.close();

    histServer = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      dbPath: histDbPath,
      annotationsDbPath: join(histTmp, "annotations.db"),
    });
    histBaseUrl = `http://localhost:${histServer.port}`;
  });

  afterAll(() => {
    void histServer?.stop(true);
    try {
      rmSync(histTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("GET /api/history returns paginated entries with total", async () => {
    const res = await fetch(`${histBaseUrl}/api/history`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { entries: { sessionId: string }[]; total: number };
    expect(data.total).toBe(2);
    expect(data.entries).toHaveLength(2);
    expect(data.entries[0].sessionId).toBe("h2");
  });

  it("GET /api/history?skill=oneshot filters by skill", async () => {
    const res = await fetch(`${histBaseUrl}/api/history?skill=oneshot`);
    const data = (await res.json()) as { entries: { sessionId: string }[]; total: number };
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].sessionId).toBe("h1");
  });

  it("GET /api/history?search=auth filters by text search", async () => {
    const res = await fetch(`${histBaseUrl}/api/history?search=auth`);
    const data = (await res.json()) as { entries: { sessionId: string }[] };
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0].sessionId).toBe("h1");
  });

  it("GET /api/history/stats returns aggregate statistics", async () => {
    const res = await fetch(`${histBaseUrl}/api/history/stats`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      totalSessions: number;
      totalCostUsd: number;
      successRate: number;
      skillBreakdown: { skill: string }[];
      dailyCosts: { date: string }[];
      topTools: { tool: string }[];
    };
    expect(data.totalSessions).toBe(2);
    expect(data.totalCostUsd).toBeCloseTo(3.5);
    expect(data.skillBreakdown.length).toBeGreaterThanOrEqual(2);
    expect(data.dailyCosts.length).toBeGreaterThanOrEqual(1);
    expect(data.topTools.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/history/compare?a=h1&b=h2 returns comparison", async () => {
    const res = await fetch(`${histBaseUrl}/api/history/compare?a=h1&b=h2`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      left: { sessionId: string; costUsd: number };
      right: { sessionId: string; costUsd: number };
    };
    expect(data.left.sessionId).toBe("h1");
    expect(data.right.sessionId).toBe("h2");
    expect(data.left.costUsd).toBe(2.5);
    expect(data.right.costUsd).toBe(1.0);
  });

  it("GET /api/history/compare returns 400 without params", async () => {
    const res = await fetch(`${histBaseUrl}/api/history/compare`);
    expect(res.status).toBe(400);
    await res.text();
  });

  it("GET /api/history/compare returns 404 for missing session", async () => {
    const res = await fetch(`${histBaseUrl}/api/history/compare?a=h1&b=nonexistent`);
    expect(res.status).toBe(404);
    await res.text();
  });

  it("GET /history serves history.html page", async () => {
    const res = await fetch(`${histBaseUrl}/history`);
    expect([200, 500]).toContain(res.status);
    await res.text();
  });
});

describe("SQLite session endpoints (no dbPath)", () => {
  let sessTmp: string;
  let noDbServer: ReturnType<typeof createServer>;
  let url: string;

  beforeAll(() => {
    sessTmp = mkdtempSync(join(tmpdir(), "orch-monitor-nodb-"));
    const wtDir = join(sessTmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    noDbServer = createServer({ port: 0, wtDir, startWatcher: false, annotationsDbPath: join(sessTmp, "annotations.db") });
    url = `http://localhost:${noDbServer.port}`;
  });

  afterAll(() => {
    void noDbServer?.stop(true);
    try {
      rmSync(sessTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns available:false when dbPath not configured", async () => {
    const res = await fetch(`${url}/api/sessions`);
    const data = (await res.json()) as {
      available: boolean;
      sessions: unknown[];
    };
    expect(data.available).toBe(false);
    expect(data.sessions).toEqual([]);
  });
});

describe("AI briefing endpoint", () => {
  it("returns enabled:false when no briefing provider is configured", async () => {
    const res = await fetch(`${baseUrl}/api/briefing`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { enabled: boolean };
    expect(data.enabled).toBe(false);
  });

  it("returns briefing data when provider is configured", async () => {
    let bTmp: string | null = null;
    let bServer: ReturnType<typeof createServer> | null = null;
    try {
      bTmp = mkdtempSync(join(tmpdir(), "orch-monitor-briefing-"));
      const bWtDir = join(bTmp, "wt");
      mkdirSync(bWtDir, { recursive: true });
      const bOrchDir = join(bWtDir, "orch-briefing");
      mkdirSync(join(bOrchDir, "workers"), { recursive: true });
      writeFileSync(
        join(bOrchDir, "state.json"),
        JSON.stringify({ id: "orch-briefing", waves: [] }),
      );

      const mockProvider: BriefingProvider = {
        generate(_snapshot: MonitorSnapshot, _linear: Record<string, LinearTicket>) {
          return Promise.resolve({
            briefing: "All 1 orchestrator is idle.",
            suggestedLabels: {},
            generatedAt: "2026-04-14T12:00:00Z",
          });
        },
        stop() {},
      };

      bServer = createServer({
        port: 0,
        wtDir: bWtDir,
        startWatcher: false,
        prStatusFetcher: null,
        linearFetcher: null,
        briefingProvider: mockProvider,
        annotationsDbPath: join(bTmp, "annotations.db"),
      });

      const bUrl = `http://localhost:${bServer.port}`;
      const res = await fetch(`${bUrl}/api/briefing`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as {
        enabled: boolean;
        briefing: string;
        suggestedLabels: Record<string, string[]>;
      };
      expect(data.enabled).toBe(true);
      expect(data.briefing).toContain("idle");
      expect(data.suggestedLabels).toBeDefined();
    } finally {
      if (bServer) void bServer.stop(true);
      if (bTmp) {
        try { rmSync(bTmp, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });
});

describe("terminal mode", () => {
  it("createServer with terminal option does not throw", () => {
    const tmp = mkdtempSync(join(tmpdir(), "orch-monitor-term-"));
    const wtDir = join(tmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    const orchDir = join(wtDir, "orch-term");
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ id: "orch-term", waves: [] }),
    );

    const srv = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      terminal: true,
      prStatusFetcher: null,
      linearFetcher: null,
      annotationsDbPath: join(tmp, "annotations.db"),
    });
    expect(srv).toBeDefined();
    expect(srv.port).toBeGreaterThan(0);
    void srv.stop(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("startTerminalOnly starts watcher without HTTP server", () => {
    const tmp = mkdtempSync(join(tmpdir(), "orch-monitor-to-"));
    const wtDir = join(tmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    const orchDir = join(wtDir, "orch-to");
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ id: "orch-to", waves: [] }),
    );

    const handle = startTerminalOnly(wtDir);
    expect(handle).toBeDefined();
    expect(typeof handle.stop).toBe("function");
    handle.stop();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("Preview integration", () => {
  let pvTmp: string;
  let pvServer: ReturnType<typeof createServer>;
  let pvUrl: string;

  beforeAll(async () => {
    pvTmp = mkdtempSync(join(tmpdir(), "orch-monitor-pv-"));
    const wtDir = join(pvTmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    const orchDir = join(wtDir, "orch-pv");
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ id: "orch-pv", waves: [] }),
    );
    writeFileSync(
      join(orchDir, "workers", "PV-1.json"),
      JSON.stringify({
        ticket: "PV-1",
        orchestrator: "orch-pv",
        workerName: "w",
        status: "pr-created",
        phase: 5,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pr: { number: 42, url: "https://github.com/test-org/test-repo/pull/42" },
      }),
    );

    const fetcher = createPreviewFetcher({
      runner: (args) => {
        if (args[1] === "--version")
          return Promise.resolve({ stdout: "gh 2.0", ok: true });
        const key = args.join(" ");
        if (key.includes("comments"))
          return Promise.resolve({
            stdout: "Preview: https://my-app.pages.dev\n",
            ok: true,
          });
        if (key.includes("deployments"))
          return Promise.resolve({ stdout: "[]", ok: true });
        return Promise.resolve({ stdout: "", ok: true });
      },
    });

    await fetcher.refreshAll([{ repo: "test-org/test-repo", number: 42 }]);

    pvServer = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      prStatusFetcher: null,
      linearFetcher: null,
      previewFetcher: fetcher,
      annotationsDbPath: join(pvTmp, "annotations.db"),
    });
    pvUrl = `http://localhost:${pvServer.port}`;
  });

  afterAll(() => {
    void pvServer?.stop(true);
    try {
      rmSync(pvTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("includes preview links in /api/snapshot after refresh", async () => {
    const res = await fetch(`${pvUrl}/api/snapshot`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      orchestrators: Array<{
        workers: Record<string, { previews?: Array<{ url: string; provider: string }> }>;
      }>;
    };
    const worker = data.orchestrators[0]?.workers["PV-1"];
    expect(worker).toBeDefined();
    expect(worker?.previews).toBeDefined();
    expect(worker?.previews?.length).toBeGreaterThan(0);
    expect(worker?.previews?.[0]?.url).toBe("https://my-app.pages.dev");
    expect(worker?.previews?.[0]?.provider).toBe("cloudflare");
  });
});

describe("/api/rollup with merged worker PR", () => {
  let rollupServer: ReturnType<typeof createServer>;
  let rollupUrl: string;
  let rollupTmp: string;

  beforeAll(() => {
    rollupTmp = mkdtempSync(join(tmpdir(), "orch-rollup-test-"));
    const wtDir = join(rollupTmp, "wt");
    const orchDir = join(wtDir, "orch-rollup");
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({
        id: "orch-rollup",
        startedAt: new Date().toISOString(),
        currentWave: 1,
        totalWaves: 1,
        waves: [{ wave: 1, status: "done", tickets: ["CTL-108"] }],
      }),
    );
    writeFileSync(
      join(orchDir, "workers", "CTL-108.json"),
      JSON.stringify({
        ticket: "CTL-108",
        orchestrator: "orch-rollup",
        workerName: "orch-rollup-CTL-108",
        status: "done",
        phase: 5,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pr: {
          number: 999,
          url: "https://github.com/a/b/pull/999",
          title: "feat: rollup briefing",
        },
      }),
    );
    writeFileSync(
      join(orchDir, "workers", "CTL-108-rollup.md"),
      "Key note: gated behind existing AI briefing flag.",
    );

    rollupServer = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      annotationsDbPath: join(rollupTmp, "annotations.db"),
    });
    rollupUrl = `http://localhost:${rollupServer.port}`;
  });

  afterAll(() => {
    void rollupServer?.stop(true);
    if (rollupTmp) {
      try {
        rmSync(rollupTmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("returns whatShipped, whatToSee, gotchas", async () => {
    const res = await fetch(`${rollupUrl}/api/rollup/orch-rollup`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      orchId: string;
      rollup: {
        whatShipped: Array<{ ticket: string; pr: number; title: string }>;
        whatToSee: string;
        gotchas: string;
        generatedBy: string;
      } | null;
    };
    expect(data.orchId).toBe("orch-rollup");
    expect(data.rollup).not.toBeNull();
    expect(data.rollup!.whatShipped).toHaveLength(1);
    expect(data.rollup!.whatShipped[0].ticket).toBe("CTL-108");
    expect(data.rollup!.whatShipped[0].pr).toBe(999);
    expect(data.rollup!.whatToSee).toContain(
      "https://github.com/a/b/pull/999",
    );
    expect(data.rollup!.gotchas).toContain("### CTL-108");
    expect(data.rollup!.gotchas).toContain("Key note");
    expect(data.rollup!.generatedBy).toBe("auto");
  });
});

describe("Webhook receiver route (/api/webhook)", () => {
  let webhookServer: ReturnType<typeof createServer>;
  let webhookUrl: string;
  let webhookTmp: string;

  beforeAll(() => {
    webhookTmp = mkdtempSync(join(tmpdir(), "webhook-route-"));
    const wtDir = join(webhookTmp, "wt");
    mkdirSync(wtDir, { recursive: true });

    // Fake smee-client constructor — never opens a real network connection.
    const fakeFactory = () => ({
      start: () => Promise.resolve({}),
      stop: () => Promise.resolve(),
    });

    webhookServer = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      annotationsDbPath: join(webhookTmp, "annotations.db"),
      webhookConfig: {
        smeeChannel: "https://smee.io/test-channel",
        secret: "test-secret",
        tunnelFactory: fakeFactory,
      },
    });
    webhookUrl = `http://localhost:${webhookServer.port}`;
  });

  afterAll(() => {
    void webhookServer?.stop(true);
    try {
      rmSync(webhookTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns 401 (not 404) for POST without signature — route is registered", async () => {
    const res = await fetch(`${webhookUrl}/api/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"action":"closed"}',
    });
    expect(res.status).toBe(401);
  });

  it("returns 405 for GET (method not allowed)", async () => {
    const res = await fetch(`${webhookUrl}/api/webhook`);
    // The catchall returns 404 for unmatched paths/methods, so this hits the
    // default 404 unless we restrict at the route level. We accept either.
    expect([404, 405]).toContain(res.status);
  });
});

describe("Webhook receiver — disabled (no webhookConfig)", () => {
  let plainServer: ReturnType<typeof createServer>;
  let plainUrl: string;
  let plainTmp: string;

  beforeAll(() => {
    plainTmp = mkdtempSync(join(tmpdir(), "webhook-disabled-"));
    const wtDir = join(plainTmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    plainServer = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      annotationsDbPath: join(plainTmp, "annotations.db"),
    });
    plainUrl = `http://localhost:${plainServer.port}`;
  });

  afterAll(() => {
    void plainServer?.stop(true);
    try {
      rmSync(plainTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns 503 when webhookConfig is not provided", async () => {
    const res = await fetch(`${plainUrl}/api/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(503);
  });
});

describe("Webhook config-driven watch list (CTL-216)", () => {
  // The subscriber issues a `gh api repos/{repo}/hooks` GET-list call before
  // doing anything else (see webhook-subscriber.ts). We use the recorded calls
  // as the signal that ensureSubscribed was invoked for a repo.
  type Call = string[];

  // Default responder returns a single existing hook that matches the test
  // smee channel, so listExistingHook resolves to that hook id and the cache
  // is populated WITHOUT a POST. This is the "happy path" used by tests A and
  // B; bad-token / failure cases override the responder.
  function defaultResponder(channel: string) {
    return (args: string[]): { stdout: string; ok: boolean } => {
      if (args.includes("-X")) {
        // POST createHook — only reached when listExistingHook returns null,
        // which our default responder avoids. Stub a created-hook response.
        return { stdout: '{"id":777}', ok: true };
      }
      return {
        stdout: JSON.stringify([{ id: 12345, config: { url: channel } }]),
        ok: true,
      };
    };
  }

  function makeRunner(
    responder?: (args: string[]) => { stdout: string; ok: boolean },
    channel = "https://smee.io/test",
  ): {
    runner: (args: string[]) => Promise<{ stdout: string; ok: boolean }>;
    calls: Call[];
  } {
    const calls: Call[] = [];
    const respond = responder ?? defaultResponder(channel);
    const runner = (args: string[]) => {
      calls.push([...args]);
      return Promise.resolve(respond(args));
    };
    return { runner, calls };
  }

  // Fake smee-client constructor — never opens a real network connection.
  const fakeFactory = () => ({
    start: () => Promise.resolve({}),
    stop: () => Promise.resolve(),
  });

  // Subscriber subscriptions are kicked off in a `then(...)` chain after
  // `webhookTunnel.start()`. Allow microtasks/macrotasks to drain so the
  // recorded calls reflect the startup hook firing.
  async function waitForSubscribeCalls(
    calls: Call[],
    expected: number,
    deadlineMs = 1000,
  ): Promise<void> {
    const start = Date.now();
    while (calls.length < expected && Date.now() - start < deadlineMs) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  function reposCalledFromGetHooks(calls: Call[]): string[] {
    const out: string[] = [];
    for (const args of calls) {
      // GET-list step is `gh api repos/<owner>/<repo>/hooks` with no `-X POST`.
      if (args[0] !== "gh" || args[1] !== "api") continue;
      if (args.includes("-X")) continue;
      const path = args[2] ?? "";
      const m = path.match(/^repos\/([^/]+\/[^/]+)\/hooks$/);
      if (m && m[1]) out.push(m[1]);
    }
    return out;
  }

  it("subscribes to configured watchRepos at startup with no workers present", async () => {
    const channel = "https://smee.io/test-a";
    const { runner, calls } = makeRunner(undefined, channel);
    const tmp = mkdtempSync(join(tmpdir(), "webhook-watchrepos-a-"));
    try {
      const wtDir = join(tmp, "wt");
      mkdirSync(wtDir, { recursive: true });
      const srv = createServer({
        port: 0,
        wtDir,
        startWatcher: false,
        annotationsDbPath: join(tmp, "annotations.db"),
        webhookConfig: {
          smeeChannel: channel,
          secret: "secret",
          tunnelFactory: fakeFactory,
          watchRepos: ["coalesce-labs/catalyst", "coalesce-labs/adva"],
          subscriberRunner: runner,
        },
      });
      try {
        await waitForSubscribeCalls(calls, 2);
        const repos = reposCalledFromGetHooks(calls);
        expect(repos).toContain("coalesce-labs/catalyst");
        expect(repos).toContain("coalesce-labs/adva");
      } finally {
        void srv.stop(true);
      }
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("dedupes when a configured repo is also auto-discovered via worker signal", async () => {
    const channel = "https://smee.io/test-b";
    const { runner, calls } = makeRunner(undefined, channel);
    const tmp = mkdtempSync(join(tmpdir(), "webhook-watchrepos-b-"));
    try {
      const wtDir = join(tmp, "wt");
      const orchDir = join(wtDir, "orch-dedup");
      mkdirSync(join(orchDir, "workers"), { recursive: true });
      writeFileSync(
        join(orchDir, "state.json"),
        JSON.stringify({
          id: "orch-dedup",
          startedAt: new Date().toISOString(),
          currentWave: 1,
          totalWaves: 1,
          waves: [{ wave: 1, status: "in_progress", tickets: ["X-1"] }],
        }),
      );
      writeFileSync(
        join(orchDir, "workers", "X-1.json"),
        JSON.stringify({
          ticket: "X-1",
          orchestrator: "orch-dedup",
          workerName: "orch-dedup-X-1",
          status: "in_progress",
          phase: 1,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          pid: process.pid,
          pr: {
            number: 99,
            url: "https://github.com/coalesce-labs/catalyst/pull/99",
            ciStatus: "pending",
            prOpenedAt: new Date().toISOString(),
            autoMergeArmedAt: null,
            mergedAt: null,
          },
        }),
      );

      const srv = createServer({
        port: 0,
        wtDir,
        startWatcher: false,
        annotationsDbPath: join(tmp, "annotations.db"),
        webhookConfig: {
          smeeChannel: channel,
          secret: "secret",
          tunnelFactory: fakeFactory,
          watchRepos: ["coalesce-labs/catalyst"],
          subscriberRunner: runner,
        },
      });
      try {
        await waitForSubscribeCalls(calls, 1);
        // Force snapshot to run the auto-discovery path too.
        const res = await fetch(`http://localhost:${srv.port}/api/snapshot`);
        expect(res.ok).toBe(true);
        await res.json();
        // Give the snapshot's `void ensureSubscribed` a tick to attempt running.
        await new Promise((r) => setTimeout(r, 20));
        const repos = reposCalledFromGetHooks(calls);
        const catalystCalls = repos.filter(
          (r) => r === "coalesce-labs/catalyst",
        );
        // Subscriber's in-memory cache dedupes — only one subscription attempt
        // even though both startup hook and snapshot would have fired.
        expect(catalystCalls.length).toBe(1);
      } finally {
        void srv.stop(true);
      }
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("does not subscribe to anything when watchRepos is empty/missing", async () => {
    const { runner, calls } = makeRunner();
    const tmp = mkdtempSync(join(tmpdir(), "webhook-watchrepos-c-"));
    try {
      const wtDir = join(tmp, "wt");
      mkdirSync(wtDir, { recursive: true });
      const srv = createServer({
        port: 0,
        wtDir,
        startWatcher: false,
        annotationsDbPath: join(tmp, "annotations.db"),
        webhookConfig: {
          smeeChannel: "https://smee.io/test-c",
          secret: "secret",
          tunnelFactory: fakeFactory,
          // watchRepos omitted entirely.
          subscriberRunner: runner,
        },
      });
      try {
        // Wait long enough that any rogue subscription attempt would have
        // started. Don't loop on calls.length — we're asserting it stays 0.
        await new Promise((r) => setTimeout(r, 50));
        expect(reposCalledFromGetHooks(calls)).toEqual([]);
      } finally {
        void srv.stop(true);
      }
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("keeps the daemon running when a configured repo's hook list call fails", async () => {
    // Simulate the gh CLI returning ok:false for the GET hooks call. The
    // subscriber's tolerance contract is: log a warning and continue. The
    // server must NOT throw / crash.
    const { runner, calls } = makeRunner(() => ({ stdout: "", ok: false }));
    const tmp = mkdtempSync(join(tmpdir(), "webhook-watchrepos-d-"));
    try {
      const wtDir = join(tmp, "wt");
      mkdirSync(wtDir, { recursive: true });
      const srv = createServer({
        port: 0,
        wtDir,
        startWatcher: false,
        annotationsDbPath: join(tmp, "annotations.db"),
        webhookConfig: {
          smeeChannel: "https://smee.io/test-d",
          secret: "secret",
          tunnelFactory: fakeFactory,
          watchRepos: ["unknown-org/no-access"],
          subscriberRunner: runner,
        },
      });
      try {
        await waitForSubscribeCalls(calls, 1);
        // Server is still serving requests after the failed subscription.
        const res = await fetch(`http://localhost:${srv.port}/api/snapshot`);
        expect(res.ok).toBe(true);
      } finally {
        void srv.stop(true);
      }
    } finally {
      try {
        rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe("Linear webhook receiver route (/api/webhook/linear) — CTL-210", () => {
  let linearServer: ReturnType<typeof createServer>;
  let linearUrl: string;
  let linearTmp: string;

  beforeAll(() => {
    linearTmp = mkdtempSync(join(tmpdir(), "linear-webhook-route-"));
    const wtDir = join(linearTmp, "wt");
    mkdirSync(wtDir, { recursive: true });

    linearServer = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      annotationsDbPath: join(linearTmp, "annotations.db"),
      linearWebhookConfig: { secret: "linear-test-secret" },
    });
    linearUrl = `http://localhost:${linearServer.port}`;
  });

  afterAll(() => {
    void linearServer?.stop(true);
    try {
      rmSync(linearTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns 401 (not 404) for POST without signature — route is registered", async () => {
    const res = await fetch(`${linearUrl}/api/webhook/linear`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-event": "Issue",
        "linear-delivery": "delivery-1",
      },
      body: '{"action":"create","type":"Issue","data":{}}',
    });
    expect(res.status).toBe(401);
  });
});

describe("Linear webhook receiver — disabled (no linearWebhookConfig)", () => {
  let plainServer: ReturnType<typeof createServer>;
  let plainUrl: string;
  let plainTmp: string;

  beforeAll(() => {
    plainTmp = mkdtempSync(join(tmpdir(), "linear-webhook-disabled-"));
    const wtDir = join(plainTmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    plainServer = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      annotationsDbPath: join(plainTmp, "annotations.db"),
    });
    plainUrl = `http://localhost:${plainServer.port}`;
  });

  afterAll(() => {
    void plainServer?.stop(true);
    try {
      rmSync(plainTmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("returns 503 when linearWebhookConfig is not provided", async () => {
    const res = await fetch(`${plainUrl}/api/webhook/linear`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(503);
  });
});

describe("GET /api/status/webhook-tunnel", () => {
  const fakeFactory = () => ({
    start: () => Promise.resolve({}),
    stop: () => Promise.resolve(),
  });

  it("returns connected=true when tunnel is configured and started", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wt-status-tunnel-conn-"));
    const wtDir = join(tmp, "wt");
    mkdirSync(wtDir, { recursive: true });

    // Write a github event in the current month's event log
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const eventsDir = join(tmp, "events");
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(
      join(eventsDir, `${month}.jsonl`),
      JSON.stringify({
        ts: now.toISOString(),
        event: "github.pr.merged",
        scope: { repo: "org/repo" },
        schemaVersion: 2,
      }) + "\n",
    );

    const srv = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      catalystDir: tmp,
      webhookConfig: {
        smeeChannel: "https://smee.io/test",
        secret: "s3cr3t",
        secretEnvName: "CATALYST_WEBHOOK_SECRET",
        tunnelFactory: fakeFactory,
      },
    });
    const url = `http://localhost:${srv.port}`;

    // Allow tunnel.start() microtask to complete
    await new Promise((r) => setTimeout(r, 30));

    try {
      const res = await fetch(`${url}/api/status/webhook-tunnel`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.connected).toBe(true);
      expect(body.smeeUrl).toBe("https://smee.io/test");
      expect(body.secretEnvName).toBe("CATALYST_WEBHOOK_SECRET");
      expect(body.secretPresent).toBe(true);
      expect(typeof body.eventCount24h).toBe("number");
      expect(body.eventCount24h).toBeGreaterThanOrEqual(1);
      expect(typeof body.eventCount24hByRepo).toBe("object");
    } finally {
      void srv.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns connected=false when no webhookConfig provided", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wt-status-tunnel-noconf-"));
    const wtDir = join(tmp, "wt");
    mkdirSync(wtDir, { recursive: true });

    const srv = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      catalystDir: tmp,
    });
    const url = `http://localhost:${srv.port}`;

    try {
      const res = await fetch(`${url}/api/status/webhook-tunnel`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.connected).toBe(false);
      expect(body.smeeUrl).toBeNull();
      expect(body.secretEnvName).toBeNull();
      expect(body.secretPresent).toBe(false);
      expect(body.eventCount24h).toBe(0);
      expect(body.eventCount24hByRepo).toEqual({});
    } finally {
      void srv.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns smeeUrl=null when smeeChannel is empty string", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wt-status-tunnel-nochan-"));
    const wtDir = join(tmp, "wt");
    mkdirSync(wtDir, { recursive: true });

    const srv = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      catalystDir: tmp,
      webhookConfig: {
        smeeChannel: "",
        secret: "s3cr3t",
        secretEnvName: "CATALYST_WEBHOOK_SECRET",
        tunnelFactory: fakeFactory,
      },
    });
    const url = `http://localhost:${srv.port}`;

    try {
      const res = await fetch(`${url}/api/status/webhook-tunnel`);
      const body = await res.json() as Record<string, unknown>;
      expect(body.smeeUrl).toBeNull();
      expect(body.secretPresent).toBe(true);
    } finally {
      void srv.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns secretPresent=false when secret is empty string", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "wt-status-tunnel-nosec-"));
    const wtDir = join(tmp, "wt");
    mkdirSync(wtDir, { recursive: true });

    const srv = createServer({
      port: 0,
      wtDir,
      startWatcher: false,
      catalystDir: tmp,
      webhookConfig: {
        smeeChannel: "https://smee.io/test",
        secret: "",
        secretEnvName: "CATALYST_WEBHOOK_SECRET",
        tunnelFactory: fakeFactory,
      },
    });
    const url = `http://localhost:${srv.port}`;

    try {
      const res = await fetch(`${url}/api/status/webhook-tunnel`);
      const body = await res.json() as Record<string, unknown>;
      expect(body.secretPresent).toBe(false);
    } finally {
      void srv.stop(true);
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
