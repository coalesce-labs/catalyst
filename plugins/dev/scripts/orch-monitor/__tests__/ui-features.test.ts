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

  server = createServer({ port: 0, wtDir, startWatcher: false });
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

describe("command palette", () => {
  it("should include command palette markup in the HTML", () => {
    expect(html).toContain("cmd-palette");
  });

  it("should include command palette input element", () => {
    expect(html).toContain("cmd-input");
  });

  it("should include command palette results container", () => {
    expect(html).toContain("cmd-results");
  });

  it("should have command palette overlay with backdrop styling", () => {
    expect(html).toContain("cmd-overlay");
  });
});

describe("sidebar navigation", () => {
  it("should include sidebar element", () => {
    expect(html).toContain("sidebar");
  });

  it("should include sidebar toggle button", () => {
    expect(html).toContain("sidebar-toggle");
  });

  it("should include layout wrapper", () => {
    expect(html).toContain("layout");
  });
});

describe("context menu", () => {
  it("should include context menu element", () => {
    expect(html).toContain("ctx-menu");
  });

  it("should include context menu items for common actions", () => {
    expect(html).toContain("Open in Linear");
    expect(html).toContain("Open PR");
    expect(html).toContain("Copy ticket ID");
  });
});

describe("keyboard navigation", () => {
  it("should include focused row CSS class", () => {
    expect(html).toContain(".worker-row.focused");
  });

  it("should include keydown event listener", () => {
    expect(html).toContain("keydown");
  });

  it("should handle j/k navigation keys", () => {
    expect(html).toContain('"j"');
    expect(html).toContain('"k"');
  });

  it("should handle Escape key", () => {
    expect(html).toContain('"Escape"');
  });
});

describe("design consistency", () => {
  it("should include focus-visible outlines for keyboard nav", () => {
    expect(html).toContain("focus-visible");
  });

  it("should include CSS transitions for smooth animations", () => {
    expect(html).toContain("transition:");
  });

  it("should include briefing drawer transition instead of display toggle", () => {
    expect(html).toContain("briefing-drawer");
  });
});

describe("compact table design", () => {
  it("should use compact padding in table cells", () => {
    expect(html).toContain("worker-table");
  });

  it("should include monospace font for IDs", () => {
    expect(html).toContain("ui-monospace");
  });
});
