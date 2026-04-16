import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "../server";

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;
let html: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "orch-monitor-ui-test-"));
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
      totalWaves: 2,
      waves: [
        { wave: 1, status: "complete", tickets: ["TEST-1", "TEST-2"] },
        { wave: 2, status: "in_progress", tickets: ["TEST-3"] },
      ],
    }),
  );

  for (const [ticket, status] of [
    ["TEST-1", "done"],
    ["TEST-2", "implementing"],
    ["TEST-3", "dispatched"],
  ] as const) {
    writeFileSync(
      join(orchDir, "workers", `${ticket}.json`),
      JSON.stringify({
        ticket,
        orchestrator: "orch-test",
        workerName: `orch-test-${ticket}`,
        status,
        phase: status === "done" ? 6 : 1,
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        pid: process.pid,
      }),
    );
  }

  server = createServer({ port: 0, wtDir, startWatcher: false, annotationsDbPath: join(tmpDir, "annotations.db") });
  baseUrl = `http://localhost:${server.port}`;

  const res = await fetch(`${baseUrl}/`);
  html = await res.text();
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

describe("React app shell", () => {
  it("should serve a valid HTML document", () => {
    expect(html.toLowerCase()).toContain("<!doctype html");
    expect(html).toContain("<html");
  });

  it("should include React root mount point", () => {
    expect(html).toContain('id="root"');
  });

  it("should include module script tag for Vite bundle", () => {
    expect(html).toContain('type="module"');
    expect(html).toContain("/assets/");
  });

  it("should include CSS stylesheet link", () => {
    expect(html).toContain('rel="stylesheet"');
    expect(html).toContain(".css");
  });

  it("should include page title", () => {
    expect(html).toContain("Catalyst Monitor");
  });

  it("should include favicon reference", () => {
    expect(html).toContain("catalyst-logo.svg");
  });
});

describe("static asset serving", () => {
  it("should serve built JS assets from /assets/", async () => {
    const match = html.match(/src="(\/assets\/[^"]+\.js)"/);
    expect(match).toBeTruthy();
    if (match) {
      const res = await fetch(`${baseUrl}${match[1]}`);
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") || "";
      expect(ct).toContain("javascript");
    }
  });

  it("should serve built CSS assets from /assets/", async () => {
    const match = html.match(/href="(\/assets\/[^"]+\.css)"/);
    expect(match).toBeTruthy();
    if (match) {
      const res = await fetch(`${baseUrl}${match[1]}`);
      expect(res.status).toBe(200);
      const ct = res.headers.get("content-type") || "";
      expect(ct).toContain("css");
    }
  });

  it("should serve logo SVG from /public/", async () => {
    const res = await fetch(`${baseUrl}/public/catalyst-logo.svg`);
    expect(res.status).toBe(200);
  });
});
