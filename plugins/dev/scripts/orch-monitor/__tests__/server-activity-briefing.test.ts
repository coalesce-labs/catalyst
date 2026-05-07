import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer } from "../server";

type Server = ReturnType<typeof createServer>;

describe("GET /api/briefing/activity — AI not configured", () => {
  let server: Server;
  let baseUrl: string;
  let tmp: string;
  let savedEnv: string | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "orch-activity-brief-"));
    const catalystDir = join(tmp, "catalyst");
    mkdirSync(join(catalystDir, "events"), { recursive: true });

    // Write fixture events to the current month's log
    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const eventFile = join(catalystDir, "events", `${month}.jsonl`);
    const recentTs = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const lines = [
      JSON.stringify({ ts: recentTs, event: "heartbeat", orchestrator: null, worker: null, detail: null }),
      JSON.stringify({
        ts: recentTs,
        event: "worker-phase-advanced",
        orchestrator: "orch-test",
        worker: "CTL-1",
        detail: { from: "planning", to: "implementing", phase: 3 },
      }),
      JSON.stringify({
        ts: recentTs,
        event: "attention-raised",
        orchestrator: "orch-test",
        worker: "CTL-2",
        detail: { reason: "CI blocked after 3 attempts", attentionType: "waiting-for-user" },
      }),
    ];
    writeFileSync(eventFile, lines.join("\n") + "\n");

    savedEnv = process.env.CATALYST_DIR;
    process.env.CATALYST_DIR = catalystDir;

    server = createServer({
      port: 0,
      wtDir: join(tmp, "wt"),
      startWatcher: false,
      annotationsDbPath: join(tmp, "annotations.db"),
      // No summarizeHandler or summarizeConfig → AI not configured
    });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterAll(() => {
    void server.stop(true);
    if (savedEnv === undefined) {
      delete process.env.CATALYST_DIR;
    } else {
      process.env.CATALYST_DIR = savedEnv;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns enabled:false when AI not configured", async () => {
    const res = await fetch(`${baseUrl}/api/briefing/activity?window=30m`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.enabled).toBe(false);
  });

  it("returns 400 for invalid window parameter", async () => {
    const res = await fetch(`${baseUrl}/api/briefing/activity?window=invalid`);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.error).toBe("string");
  });

  it("defaults to 30m when no window parameter provided", async () => {
    const res = await fetch(`${baseUrl}/api/briefing/activity`);
    expect(res.status).toBe(200);
  });

  it("accepts all valid window values", async () => {
    for (const w of ["30m", "1h", "6h"]) {
      const res = await fetch(`${baseUrl}/api/briefing/activity?window=${w}`);
      expect(res.status).toBe(200);
    }
  });
});
