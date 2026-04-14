import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  scanOrchestrators,
  readOrchestratorState,
  buildSnapshot,
  buildAnalyticsSnapshot,
} from "../lib/state-reader";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "orch-monitor-test-"));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function setupOrch(
  baseDir: string,
  id: string,
  opts: {
    state?: object | null;
    workers?: Record<string, object>;
    dashboard?: string | null;
    malformedWorker?: string;
  } = {}
): string {
  const orchDir = join(baseDir, id);
  mkdirSync(join(orchDir, "workers"), { recursive: true });

  if (opts.state !== null) {
    const defaultState = {
      id,
      startedAt: "2026-04-13T18:00:00Z",
      currentWave: 1,
      totalWaves: 2,
      waves: [
        { wave: 1, status: "in_progress", tickets: ["ADV-216"] },
        { wave: 2, status: "pending", tickets: ["ADV-217"] },
      ],
    };
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify(opts.state ?? defaultState, null, 2)
    );
  }

  if (opts.workers) {
    for (const [name, data] of Object.entries(opts.workers)) {
      writeFileSync(
        join(orchDir, "workers", `${name}.json`),
        JSON.stringify(data, null, 2)
      );
    }
  }

  if (opts.malformedWorker) {
    writeFileSync(
      join(orchDir, "workers", `${opts.malformedWorker}.json`),
      "{this is not valid json"
    );
  }

  if (opts.dashboard !== undefined && opts.dashboard !== null) {
    writeFileSync(join(orchDir, "DASHBOARD.md"), opts.dashboard);
  }

  return orchDir;
}

describe("scanOrchestrators", () => {
  it("discovers orch-* directories that have workers/ subdir", () => {
    setupOrch(tmpRoot, "orch-alpha", { workers: { "T-1": { ticket: "T-1" } } });
    setupOrch(tmpRoot, "orch-beta", { workers: { "T-2": { ticket: "T-2" } } });

    // Non-matching: no workers/ dir
    mkdirSync(join(tmpRoot, "orch-empty"), { recursive: true });
    // Non-matching: wrong prefix
    mkdirSync(join(tmpRoot, "other-dir", "workers"), { recursive: true });

    const found = scanOrchestrators(tmpRoot);
    expect(found).toBeArray();
    expect(found.length).toBe(2);
    expect(found.some((p) => p.endsWith("orch-alpha"))).toBe(true);
    expect(found.some((p) => p.endsWith("orch-beta"))).toBe(true);
    expect(found.every((p) => p.startsWith("/"))).toBe(true);
  });

  it("returns empty array when baseDir is missing", () => {
    const found = scanOrchestrators(join(tmpRoot, "does-not-exist"));
    expect(found).toEqual([]);
  });
});

describe("readOrchestratorState", () => {
  it("parses worker signal files from workers/ directory", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "ADV-216": {
          ticket: "ADV-216",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-ADV-216",
          status: "in_progress",
          phase: 1,
          startedAt: now,
          updatedAt: now,
          pid: process.pid,
          lastHeartbeat: now,
        },
      },
    });

    const state = readOrchestratorState(orchDir);
    expect(state.workers).toBeDefined();
    expect(state.workers["ADV-216"]).toBeDefined();
    expect(state.workers["ADV-216"].ticket).toBe("ADV-216");
    expect(state.workers["ADV-216"].status).toBe("in_progress");
    expect(state.workers["ADV-216"].pid).toBe(process.pid);
    expect(state.workers["ADV-216"].alive).toBe(true);
  });

  it("computes timeSinceUpdate as a positive number in seconds", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "T-1": {
          ticket: "T-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-T-1",
          status: "in_progress",
          phase: 1,
          startedAt: past,
          updatedAt: past,
        },
      },
    });

    const state = readOrchestratorState(orchDir);
    const w = state.workers["T-1"];
    expect(typeof w.timeSinceUpdate).toBe("number");
    expect(w.timeSinceUpdate).toBeGreaterThan(5);
    expect(w.timeSinceUpdate).toBeLessThan(3600);
  });

  it("is backwards-compatible with signals that lack pid", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "T-1": {
          ticket: "T-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-T-1",
          status: "dispatched",
          phase: 0,
          startedAt: now,
          updatedAt: now,
        },
      },
    });

    const state = readOrchestratorState(orchDir);
    const w = state.workers["T-1"];
    expect(w.pid).toBeNull();
    expect(w.alive).toBe(false);
    expect(w.lastHeartbeat).toBeNull();
  });

  it("surfaces malformed worker JSON as a signal_corrupt placeholder (no silent drop)", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "T-good": {
          ticket: "T-good",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-T-good",
          status: "in_progress",
          phase: 1,
          startedAt: now,
          updatedAt: now,
        },
      },
      malformedWorker: "T-bad",
    });

    const state = readOrchestratorState(orchDir);
    expect(state.workers["T-good"]).toBeDefined();
    const bad = state.workers["T-bad"];
    expect(bad).toBeDefined();
    expect(bad?.status).toBe("signal_corrupt");
    expect(bad?.parseError).toBeDefined();
  });

  it("handles missing state.json gracefully", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      state: null,
      workers: {
        "T-1": {
          ticket: "T-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-T-1",
          status: "in_progress",
          phase: 1,
          startedAt: now,
          updatedAt: now,
        },
      },
    });

    const state = readOrchestratorState(orchDir);
    expect(state.id).toBe("orch-alpha");
    expect(state.workers["T-1"]).toBeDefined();
    expect(state.waves).toBeArray();
  });

  it("handles empty workers directory", () => {
    const orchDir = setupOrch(tmpRoot, "orch-alpha", { workers: {} });
    const state = readOrchestratorState(orchDir);
    expect(state.workers).toEqual({});
  });
});

describe("wave assignment", () => {
  it("assigns wave numbers from state.waves to each worker", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      state: {
        id: "orch-alpha",
        startedAt: now,
        currentWave: 2,
        totalWaves: 2,
        waves: [
          { wave: 1, status: "complete", tickets: ["A-1", "A-2"] },
          { wave: 2, status: "in_progress", tickets: ["B-1", "B-2"] },
        ],
      },
      workers: {
        "A-1": { ticket: "A-1", status: "done", phase: 6, startedAt: now, updatedAt: now },
        "A-2": { ticket: "A-2", status: "done", phase: 6, startedAt: now, updatedAt: now },
        "B-1": { ticket: "B-1", status: "in_progress", phase: 1, startedAt: now, updatedAt: now },
        "B-2": { ticket: "B-2", status: "in_progress", phase: 1, startedAt: now, updatedAt: now },
      },
    });

    const state = readOrchestratorState(orchDir);
    expect(state.workers["A-1"].wave).toBe(1);
    expect(state.workers["A-2"].wave).toBe(1);
    expect(state.workers["B-1"].wave).toBe(2);
    expect(state.workers["B-2"].wave).toBe(2);
  });

  it("leaves wave === null for orphan worker signals not listed in any wave", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      state: {
        id: "orch-alpha",
        startedAt: now,
        currentWave: 1,
        totalWaves: 1,
        waves: [{ wave: 1, status: "complete", tickets: ["A-1"] }],
      },
      workers: {
        "A-1": { ticket: "A-1", status: "done", phase: 6, startedAt: now, updatedAt: now },
        "ORPHAN-9": { ticket: "ORPHAN-9", status: "in_progress", phase: 1, startedAt: now, updatedAt: now },
      },
    });

    const state = readOrchestratorState(orchDir);
    expect(state.workers["A-1"].wave).toBe(1);
    expect(state.workers["ORPHAN-9"].wave).toBeNull();
  });

  it("leaves all workers' wave === null when state.waves is empty", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      state: {
        id: "orch-alpha",
        startedAt: now,
        currentWave: 0,
        totalWaves: 0,
        waves: [],
      },
      workers: {
        "T-1": { ticket: "T-1", status: "in_progress", phase: 1, startedAt: now, updatedAt: now },
        "T-2": { ticket: "T-2", status: "in_progress", phase: 1, startedAt: now, updatedAt: now },
      },
    });

    const state = readOrchestratorState(orchDir);
    expect(state.workers["T-1"].wave).toBeNull();
    expect(state.workers["T-2"].wave).toBeNull();
  });

  it("does not create worker entries for tickets in waves but with no signal file", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      state: {
        id: "orch-alpha",
        startedAt: now,
        currentWave: 1,
        totalWaves: 1,
        waves: [{ wave: 1, status: "in_progress", tickets: ["HAS-SIGNAL", "NO-SIGNAL"] }],
      },
      workers: {
        "HAS-SIGNAL": { ticket: "HAS-SIGNAL", status: "in_progress", phase: 1, startedAt: now, updatedAt: now },
      },
    });

    const state = readOrchestratorState(orchDir);
    expect(state.workers["HAS-SIGNAL"]).toBeDefined();
    expect(state.workers["HAS-SIGNAL"].wave).toBe(1);
    expect(state.workers["NO-SIGNAL"]).toBeUndefined();
  });
});

describe("buildSnapshot", () => {
  it("returns timestamp + orchestrators array combining all orchs", () => {
    const now = new Date().toISOString();
    setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "A-1": {
          ticket: "A-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-A-1",
          status: "in_progress",
          phase: 1,
          startedAt: now,
          updatedAt: now,
        },
      },
    });
    setupOrch(tmpRoot, "orch-beta", {
      workers: {
        "B-1": {
          ticket: "B-1",
          orchestrator: "orch-beta",
          workerName: "orch-beta-B-1",
          status: "dispatched",
          phase: 0,
          startedAt: now,
          updatedAt: now,
        },
      },
    });

    const snap = buildSnapshot(tmpRoot);
    expect(typeof snap.timestamp).toBe("string");
    expect(Date.parse(snap.timestamp)).not.toBeNaN();
    expect(snap.orchestrators).toBeArray();
    expect(snap.orchestrators.length).toBe(2);
    const ids = snap.orchestrators.map((o) => o.id).sort();
    expect(ids).toEqual(["orch-alpha", "orch-beta"]);
  });

  it("returns empty orchestrators array when baseDir missing", () => {
    const snap = buildSnapshot(join(tmpRoot, "nope"));
    expect(snap.orchestrators).toEqual([]);
    expect(typeof snap.timestamp).toBe("string");
  });

  it("includes empty sessions array and sessionStoreAvailable=false when no dbPath given", () => {
    const snap = buildSnapshot(tmpRoot);
    expect(snap.sessions).toEqual([]);
    expect(snap.sessionStoreAvailable).toBe(false);
  });

  it("includes sessions from SQLite store when dbPath is provided", () => {
    const dbPath = join(tmpRoot, "catalyst.db");
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
    db.close();

    const snap = buildSnapshot(tmpRoot, { dbPath });
    expect(snap.sessionStoreAvailable).toBe(true);
    expect(snap.sessions).toHaveLength(1);
    expect(snap.sessions[0].sessionId).toBe("solo-1");
  });
});

describe("WorkerState analytics fields", () => {
  it("exposes phaseTimestamps, completedAt, and cost when present", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "T-1": {
          ticket: "T-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-T-1",
          status: "done",
          phase: 6,
          startedAt: now,
          updatedAt: now,
          phaseTimestamps: {
            researching: "2026-04-13T18:00:00Z",
            implementing: "2026-04-13T18:05:00Z",
          },
          completedAt: "2026-04-13T18:30:00Z",
          cost: {
            costUSD: 1.23,
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 200,
          },
        },
      },
    });

    const w = readOrchestratorState(orchDir).workers["T-1"];
    expect(w.phaseTimestamps).toEqual({
      researching: "2026-04-13T18:00:00Z",
      implementing: "2026-04-13T18:05:00Z",
    });
    expect(w.completedAt).toBe("2026-04-13T18:30:00Z");
    expect(w.cost?.costUSD).toBe(1.23);
    expect(w.cost?.inputTokens).toBe(1000);
    expect(w.cost?.outputTokens).toBe(500);
    expect(w.cost?.cacheReadTokens).toBe(200);
  });

  it("leaves analytics fields absent or null when signal omits them", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "T-1": {
          ticket: "T-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-T-1",
          status: "in_progress",
          phase: 1,
          startedAt: now,
          updatedAt: now,
        },
      },
    });

    const w = readOrchestratorState(orchDir).workers["T-1"];
    expect(w.phaseTimestamps).toBeUndefined();
    expect(w.completedAt).toBeNull();
    expect(w.cost).toBeNull();
  });

  it("handles malformed cost (non-numeric values) gracefully", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "T-1": {
          ticket: "T-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-T-1",
          status: "done",
          phase: 6,
          startedAt: now,
          updatedAt: now,
          cost: { costUSD: "not-a-number", inputTokens: null },
          phaseTimestamps: { researching: 1234, implementing: "2026-04-13T18:05:00Z" },
        },
      },
    });

    const w = readOrchestratorState(orchDir).workers["T-1"];
    expect(w.cost).toBeDefined();
    expect(w.cost?.costUSD).toBe(0);
    expect(w.cost?.inputTokens).toBe(0);
    // non-string entries dropped, string entries retained
    expect(w.phaseTimestamps).toEqual({ implementing: "2026-04-13T18:05:00Z" });
  });

  it("propagates fixupCommit and followUpTo when present", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "T-1": {
          ticket: "T-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-T-1-fixup",
          status: "pr-created",
          phase: 5,
          startedAt: now,
          updatedAt: now,
          fixupCommit: "3704e82f9f7f0d0a9e1c2b3a4f5e6d7c8b9a0f1e",
          followUpTo: "T-0",
        },
      },
    });

    const w = readOrchestratorState(orchDir).workers["T-1"];
    expect(w.fixupCommit).toBe("3704e82f9f7f0d0a9e1c2b3a4f5e6d7c8b9a0f1e");
    expect(w.followUpTo).toBe("T-0");
  });

  it("leaves fixupCommit and followUpTo undefined when signal omits them", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "T-1": {
          ticket: "T-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-T-1",
          status: "in_progress",
          phase: 1,
          startedAt: now,
          updatedAt: now,
        },
      },
    });

    const w = readOrchestratorState(orchDir).workers["T-1"];
    expect(w.fixupCommit).toBeUndefined();
    expect(w.followUpTo).toBeUndefined();
  });
});

describe("buildAnalyticsSnapshot", () => {
  function writeOutputJson(orchDir: string, ticket: string, data: unknown): void {
    const logsDir = join(orchDir, "workers", "logs");
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, `${ticket}.output.json`), JSON.stringify(data));
  }

  it("returns one entry per orchestrator", () => {
    const now = new Date().toISOString();
    setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "A-1": {
          ticket: "A-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-A-1",
          status: "in_progress",
          phase: 1,
          startedAt: now,
          updatedAt: now,
        },
      },
    });
    setupOrch(tmpRoot, "orch-beta", {
      workers: {
        "B-1": {
          ticket: "B-1",
          orchestrator: "orch-beta",
          workerName: "orch-beta-B-1",
          status: "in_progress",
          phase: 1,
          startedAt: now,
          updatedAt: now,
        },
      },
    });

    const snap = buildAnalyticsSnapshot(tmpRoot);
    expect(typeof snap.generatedAt).toBe("string");
    expect(Date.parse(snap.generatedAt)).not.toBeNaN();
    expect(snap.orchestrators.length).toBe(2);
    const ids = snap.orchestrators.map((o) => o.id).sort();
    expect(ids).toEqual(["orch-alpha", "orch-beta"]);
  });

  it("returns null per worker when output.json is missing", () => {
    const now = new Date().toISOString();
    setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "A-1": {
          ticket: "A-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-A-1",
          status: "in_progress",
          phase: 1,
          startedAt: now,
          updatedAt: now,
        },
      },
    });

    const snap = buildAnalyticsSnapshot(tmpRoot);
    const orch = snap.orchestrators.find((o) => o.id === "orch-alpha");
    expect(orch).toBeDefined();
    expect(orch?.workers["A-1"]).toBeNull();
  });

  it("fills in ticket from filename, not from output", () => {
    const now = new Date().toISOString();
    const orchDir = setupOrch(tmpRoot, "orch-alpha", {
      workers: {
        "A-1": {
          ticket: "A-1",
          orchestrator: "orch-alpha",
          workerName: "orch-alpha-A-1",
          status: "done",
          phase: 6,
          startedAt: now,
          updatedAt: now,
        },
      },
    });
    writeOutputJson(orchDir, "A-1", [
      {
        type: "result",
        duration_ms: 1000,
        duration_api_ms: 500,
        num_turns: 3,
        total_cost_usd: 0.5,
        modelUsage: { "claude-opus-4-6": { costUSD: 0.5 } },
      },
    ]);

    const snap = buildAnalyticsSnapshot(tmpRoot);
    const orch = snap.orchestrators.find((o) => o.id === "orch-alpha");
    const analytics = orch?.workers["A-1"];
    expect(analytics).not.toBeNull();
    expect(analytics?.ticket).toBe("A-1");
    expect(analytics?.costUSD).toBe(0.5);
    expect(analytics?.durationMs).toBe(1000);
  });
});
