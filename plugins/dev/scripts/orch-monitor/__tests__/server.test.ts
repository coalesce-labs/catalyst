import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
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

describe("SQLite session endpoints (no dbPath)", () => {
  let sessTmp: string;
  let noDbServer: ReturnType<typeof createServer>;
  let url: string;

  beforeAll(() => {
    sessTmp = mkdtempSync(join(tmpdir(), "orch-monitor-nodb-"));
    const wtDir = join(sessTmp, "wt");
    mkdirSync(wtDir, { recursive: true });
    noDbServer = createServer({ port: 0, wtDir, startWatcher: false });
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
