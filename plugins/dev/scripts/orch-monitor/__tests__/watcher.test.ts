import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  diffWorkers,
  diffSessions,
  diffLiveness,
  isRelevant,
  startWatching,
} from "../lib/watcher";
import { subscribe } from "../lib/event-bus";
import type { MonitorSnapshot, SessionState, WorkerState } from "../lib/state-reader";

function makeWorker(overrides: Partial<WorkerState> = {}): WorkerState {
  return {
    ticket: "T-1",
    label: null,
    status: "in_progress",
    phase: 2,
    wave: null,
    pid: 1234,
    alive: true,
    pr: null,
    startedAt: "2026-04-13T17:30:00Z",
    updatedAt: "2026-04-13T18:00:00Z",
    timeSinceUpdate: 0,
    lastHeartbeat: null,
    definitionOfDone: {},
    ...overrides,
  };
}

function makeSnapshot(
  workers: Record<string, WorkerState>,
  sessions: SessionState[] = [],
): MonitorSnapshot {
  return {
    timestamp: "2026-04-13T18:00:00Z",
    orchestrators: [
      {
        id: "orch-test",
        path: "/tmp/orch-test",
        workspace: "default",
        startedAt: "2026-04-13T17:00:00Z",
        currentWave: 1,
        totalWaves: 1,
        waves: [],
        workers,
        dashboard: null,
        briefings: {},
        attention: [],
      },
    ],
    sessions,
    sessionStoreAvailable: sessions.length > 0,
  };
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionId: "sess-1",
    workflowId: null,
    ticket: "CTL-40",
    label: "oneshot",
    skillName: "oneshot",
    status: "researching",
    phase: 1,
    pid: null,
    alive: false,
    startedAt: "2026-04-14T19:00:00Z",
    updatedAt: "2026-04-14T19:00:00Z",
    completedAt: null,
    timeSinceUpdate: 0,
    cost: null,
    pr: null,
    ...overrides,
  };
}

describe("isRelevant", () => {
  it("accepts worker signal files", () => {
    expect(isRelevant("workers/T-1.json")).toBe(true);
  });
  it("accepts state.json", () => {
    expect(isRelevant("state.json")).toBe(true);
    expect(isRelevant("orch-test/state.json")).toBe(true);
  });
  it("rejects non-relevant files", () => {
    expect(isRelevant("workers/T-1.txt")).toBe(false);
    expect(isRelevant("README.md")).toBe(false);
  });
  it("accepts wave briefings and DASHBOARD.md", () => {
    expect(isRelevant("wave-3-briefing.md")).toBe(true);
    expect(isRelevant("orch-alpha/wave-12-briefing.md")).toBe(true);
    expect(isRelevant("DASHBOARD.md")).toBe(true);
    expect(isRelevant("orch-alpha/DASHBOARD.md")).toBe(true);
  });
  it("rejects dotfiles like .DS_Store", () => {
    expect(isRelevant("workers/.DS_Store")).toBe(false);
  });
  it("rejects unrelated json files", () => {
    expect(isRelevant("random.json")).toBe(false);
    expect(isRelevant("logs/out.json")).toBe(false);
  });
});

describe("diffWorkers", () => {
  it("returns added workers", () => {
    const prev = makeSnapshot({});
    const next = makeSnapshot({ "T-1": makeWorker() });
    expect(diffWorkers(prev, next).map((c) => c.worker.ticket)).toEqual(["T-1"]);
  });

  it("returns workers whose status changed", () => {
    const prev = makeSnapshot({ "T-1": makeWorker({ status: "in_progress" }) });
    const next = makeSnapshot({ "T-1": makeWorker({ status: "done" }) });
    expect(diffWorkers(prev, next)).toHaveLength(1);
  });

  it("returns workers whose phase, updatedAt, or pid changed", () => {
    const prev = makeSnapshot({ "T-1": makeWorker({ phase: 1 }) });
    expect(
      diffWorkers(prev, makeSnapshot({ "T-1": makeWorker({ phase: 2 }) })),
    ).toHaveLength(1);
    expect(
      diffWorkers(
        prev,
        makeSnapshot({
          "T-1": makeWorker({ phase: 1, updatedAt: "2026-04-13T19:00:00Z" }),
        }),
      ),
    ).toHaveLength(1);
    expect(
      diffWorkers(
        prev,
        makeSnapshot({ "T-1": makeWorker({ phase: 1, pid: 9999 }) }),
      ),
    ).toHaveLength(1);
  });

  it("returns empty array when nothing changed", () => {
    const snap = makeSnapshot({ "T-1": makeWorker() });
    expect(diffWorkers(snap, snap)).toEqual([]);
  });
});

describe("diffSessions", () => {
  it("emits when a new session appears", () => {
    const prev = makeSnapshot({}, []);
    const next = makeSnapshot({}, [makeSession({ sessionId: "new-1" })]);
    expect(diffSessions(prev, next).map((c) => c.session.sessionId)).toEqual([
      "new-1",
    ]);
  });

  it("emits when status / phase / updatedAt / pid changes", () => {
    const base = makeSession({ sessionId: "s-1" });
    const prev = makeSnapshot({}, [base]);

    expect(
      diffSessions(
        prev,
        makeSnapshot({}, [{ ...base, status: "done" }]),
      ),
    ).toHaveLength(1);
    expect(
      diffSessions(
        prev,
        makeSnapshot({}, [{ ...base, phase: 5 }]),
      ),
    ).toHaveLength(1);
    expect(
      diffSessions(
        prev,
        makeSnapshot({}, [{ ...base, updatedAt: "2026-04-14T20:00:00Z" }]),
      ),
    ).toHaveLength(1);
    expect(
      diffSessions(
        prev,
        makeSnapshot({}, [{ ...base, pid: 9999 }]),
      ),
    ).toHaveLength(1);
  });

  it("does not emit when nothing changed", () => {
    const snap = makeSnapshot({}, [makeSession()]);
    expect(diffSessions(snap, snap)).toEqual([]);
  });
});

describe("diffLiveness", () => {
  it("emits for workers whose alive flag flipped", () => {
    const prev = makeSnapshot({ "T-1": makeWorker({ alive: true }) });
    const next = makeSnapshot({ "T-1": makeWorker({ alive: false }) });
    expect(diffLiveness(prev, next)).toHaveLength(1);
  });
  it("does not emit for brand-new workers (no prior liveness state)", () => {
    const prev = makeSnapshot({});
    const next = makeSnapshot({ "T-1": makeWorker({ alive: true }) });
    expect(diffLiveness(prev, next)).toEqual([]);
  });
  it("does not emit when alive is unchanged", () => {
    const snap = makeSnapshot({ "T-1": makeWorker({ alive: true }) });
    expect(diffLiveness(snap, snap)).toEqual([]);
  });
});

describe("startWatching integration", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "orch-monitor-watcher-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("emits a snapshot event on start", async () => {
    const received: unknown[] = [];
    const unsub = subscribe("snapshot", (d) => received.push(d));
    const handle = startWatching(tmp);
    await new Promise((r) => setTimeout(r, 10));
    expect(received.length).toBeGreaterThanOrEqual(1);
    unsub();
    handle.stop();
  });

  it("emits snapshot events wrapped in envelope format", async () => {
    const received: unknown[] = [];
    const unsub = subscribe("snapshot", (d) => received.push(d));
    const handle = startWatching(tmp);
    await new Promise((r) => setTimeout(r, 10));
    expect(received.length).toBeGreaterThanOrEqual(1);
    const envelope = received[0] as {
      type: string;
      timestamp: string;
      data: unknown;
      source: string;
    };
    expect(envelope.type).toBe("snapshot");
    expect(envelope.source).toBe("filesystem");
    expect(typeof envelope.timestamp).toBe("string");
    expect(envelope.data).toBeDefined();
    unsub();
    handle.stop();
  });

  it("does not throw when baseDir is missing", () => {
    const missing = join(tmp, "does-not-exist");
    const handle = startWatching(missing);
    handle.stop();
    expect(true).toBe(true);
  });

  it("emits worker-update when a signal file is written (debounced)", async () => {
    const orchDir = join(tmp, "orch-alpha");
    mkdirSync(join(orchDir, "workers"), { recursive: true });
    writeFileSync(
      join(orchDir, "state.json"),
      JSON.stringify({ id: "orch-alpha", waves: [] }),
    );

    const updates: unknown[] = [];
    const unsub = subscribe("worker-update", (d) => updates.push(d));
    const handle = startWatching(tmp);
    await new Promise((r) => setTimeout(r, 10));

    const now = new Date().toISOString();
    writeFileSync(
      join(orchDir, "workers", "T-1.json"),
      JSON.stringify({
        ticket: "T-1",
        orchestrator: "orch-alpha",
        workerName: "orch-alpha-T-1",
        status: "in_progress",
        phase: 1,
        startedAt: now,
        updatedAt: now,
      }),
    );

    await new Promise((r) => setTimeout(r, 500));
    unsub();
    handle.stop();

    expect(updates.length).toBeGreaterThanOrEqual(1);
    const envelope = updates[0] as {
      type: string;
      timestamp: string;
      data: { orchId: string; worker: { ticket: string } };
      source: string;
    };
    expect(envelope.type).toBe("worker-update");
    expect(envelope.source).toBe("filesystem");
    expect(envelope.data.orchId).toBe("orch-alpha");
  });

  it("stop() is idempotent and cleanly tears down", () => {
    const handle = startWatching(tmp);
    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });

  it("polls SQLite and emits session-update events when dbPath is given", async () => {
    const dbPath = join(tmp, "catalyst.db");
    const schemaSql = readFileSync(
      join(__dirname, "..", "..", "db-migrations", "001_initial_schema.sql"),
      "utf8",
    );
    const db = new Database(dbPath, { create: true });
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec(schemaSql);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO sessions (session_id, status, phase, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["sess-1", "researching", 1, now, now],
    );
    db.close();

    const updates: unknown[] = [];
    const unsub = subscribe("session-update", (d) => updates.push(d));
    const handle = startWatching(tmp, {
      dbPath,
      sqlitePollIntervalMs: 50,
    });
    await new Promise((r) => setTimeout(r, 20));

    // Mutate the DB: status change should trigger a session-update
    const db2 = new Database(dbPath);
    db2.run(
      `UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?`,
      ["done", new Date().toISOString(), "sess-1"],
    );
    db2.close();

    await new Promise((r) => setTimeout(r, 200));
    unsub();
    handle.stop();

    expect(updates.length).toBeGreaterThanOrEqual(1);
  });
});
