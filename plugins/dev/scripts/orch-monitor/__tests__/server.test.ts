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

    const schemaSql = readFileSync(
      join(__dirname, "..", "..", "db-migrations", "001_initial_schema.sql"),
      "utf8",
    );
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(schemaSql);
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

    const schemaSql = readFileSync(
      join(__dirname, "..", "..", "db-migrations", "001_initial_schema.sql"),
      "utf8",
    );
    const db = new Database(histDbPath, { create: true });
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(schemaSql);

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
