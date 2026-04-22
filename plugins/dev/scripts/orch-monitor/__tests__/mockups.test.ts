import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mockups-test-"));
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
      waves: [{ wave: 1, status: "in_progress", tickets: [] }],
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

describe("mockups — worker.html", () => {
  it("serves /mockups/worker.html with text/html", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body.toLowerCase()).toContain("<!doctype html");
    expect(body).toContain('<main class="mockup-shell">');
  });

  it("gallery index links to worker.html", async () => {
    const res = await fetch(`${baseUrl}/mockups/`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="./worker.html"');
  });

  it("worker.html supports mode switching via ?mode param", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    const body = await res.text();
    // The mode resolver writes html[data-worker-mode] — mockup script must reference it.
    expect(body).toContain("data-worker-mode");
    // Both modes are supported.
    expect(body).toContain("orch-worker");
    expect(body).toContain("standalone");
  });

  it("worker.html renders all required sections", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    const body = await res.text();
    // Header + breadcrumb + title markers.
    expect(body).toContain("worker-head");
    expect(body).toContain("worker-head__breadcrumb");
    // Phase timeline.
    expect(body).toContain("phase-strip");
    // Signal panel.
    expect(body).toContain("signal-grid");
    // PR card.
    expect(body).toContain("pr-card");
    // Stream tail.
    expect(body).toContain("stream-list");
    // Todos block (mini kanban with 3 columns).
    expect(body).toContain("todos-kanban");
    // Subagents section.
    expect(body).toContain("subagent-row");
    // Cost breakdown.
    expect(body).toContain("cost-grid");
  });

  it("worker.html phase timeline covers all six oneshot phases", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    const body = await res.text().then((s) => s.toLowerCase());
    for (const phase of ["research", "plan", "implement", "validate", "ship", "done"]) {
      expect(body).toContain(phase);
    }
  });

  it("worker.html stream tail includes the required tool mix", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    const body = await res.text();
    // Acceptance criterion: stream tail has realistic mock events covering
    // Bash, Read, Edit, Task, TodoWrite.
    for (const tool of ["Bash", "Read", "Edit", "Task", "TodoWrite"]) {
      expect(body).toContain(tool);
    }
  });

  it("worker.html renders at least two subagents with status", async () => {
    const res = await fetch(`${baseUrl}/mockups/worker.html`);
    const body = await res.text();
    const matches = body.match(/class="subagent-row[^"]*"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
