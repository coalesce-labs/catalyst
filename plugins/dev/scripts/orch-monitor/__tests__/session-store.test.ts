import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  readSessionStore,
  sessionStoreAvailable,
} from "../lib/session-store";

let tmpRoot: string;
let dbPath: string;

function loadSchemaSql(): string {
  const schemaPath = join(
    __dirname,
    "..",
    "..",
    "db-migrations",
    "001_initial_schema.sql",
  );
  return readFileSync(schemaPath, "utf8");
}

function seedDb(path: string, fn: (db: Database) => void): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(loadSchemaSql());
  fn(db);
  db.close();
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "session-store-test-"));
  dbPath = join(tmpRoot, "catalyst.db");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("sessionStoreAvailable", () => {
  it("returns false when db file does not exist", () => {
    expect(sessionStoreAvailable(dbPath)).toBe(false);
  });

  it("returns true when db file exists with sessions table", () => {
    seedDb(dbPath, () => {});
    expect(sessionStoreAvailable(dbPath)).toBe(true);
  });

  it("returns false when file exists but is not a valid sqlite db", () => {
    writeFileSync(dbPath, "not a sqlite file");
    expect(sessionStoreAvailable(dbPath)).toBe(false);
  });
});

describe("readSessionStore", () => {
  it("returns an empty sessions array when db file is missing", () => {
    const snap = readSessionStore(dbPath);
    expect(snap.sessions).toEqual([]);
    expect(snap.available).toBe(false);
  });

  it("reads session rows mapped to SessionState", () => {
    const now = new Date().toISOString();
    seedDb(dbPath, (db) => {
      db.run(
        `INSERT INTO sessions (session_id, workflow_id, ticket_key, label, skill_name, status, phase, pid, started_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ["sess-1", "CTL-40", "research", "oneshot", "researching", 1, 99999, now, now],
      );
    });

    const snap = readSessionStore(dbPath);
    expect(snap.available).toBe(true);
    expect(snap.sessions).toHaveLength(1);
    const s = snap.sessions[0];
    expect(s.sessionId).toBe("sess-1");
    expect(s.ticket).toBe("CTL-40");
    expect(s.status).toBe("researching");
    expect(s.phase).toBe(1);
    expect(s.workflowId).toBeNull();
    expect(s.pid).toBe(99999);
    expect(typeof s.alive).toBe("boolean");
    expect(s.startedAt).toBe(now);
    expect(s.updatedAt).toBe(now);
    expect(typeof s.timeSinceUpdate).toBe("number");
  });

  it("joins session_metrics as cost", () => {
    const now = new Date().toISOString();
    seedDb(dbPath, (db) => {
      db.run(
        `INSERT INTO sessions (session_id, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["sess-1", "done", 6, now, now],
      );
      db.run(
        `INSERT INTO session_metrics (session_id, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ["sess-1", 1.23, 1000, 500, 200, 100, 5000, now],
      );
    });

    const snap = readSessionStore(dbPath);
    expect(snap.sessions[0].cost).toMatchObject({
      costUSD: 1.23,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
    });
  });

  it("joins session_prs as pr", () => {
    const now = new Date().toISOString();
    seedDb(dbPath, (db) => {
      db.run(
        `INSERT INTO sessions (session_id, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["sess-1", "pr-created", 5, now, now],
      );
      db.run(
        `INSERT INTO session_prs (session_id, pr_number, pr_url, ci_status, opened_at, merged_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["sess-1", 123, "https://github.com/o/r/pull/123", "passing", now, null, now],
      );
    });

    const snap = readSessionStore(dbPath);
    const pr = snap.sessions[0].pr!;
    expect(pr.number).toBe(123);
    expect(pr.url).toBe("https://github.com/o/r/pull/123");
    expect(pr.ciStatus).toBe("passing");
    expect(pr.openedAt).toBe(now);
    expect(pr.mergedAt).toBeNull();
  });

  it("filters by workflowId=null to return solo sessions only", () => {
    const now = new Date().toISOString();
    seedDb(dbPath, (db) => {
      db.run(
        `INSERT INTO sessions (session_id, workflow_id, status, phase, started_at, updated_at)
         VALUES (?, NULL, ?, ?, ?, ?)`,
        ["solo-1", "in_progress", 1, now, now],
      );
      db.run(
        `INSERT INTO sessions (session_id, workflow_id, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["orch-1", "orch-abc", "in_progress", 1, now, now],
      );
    });

    const all = readSessionStore(dbPath);
    expect(all.sessions).toHaveLength(2);

    const solo = readSessionStore(dbPath, { soloOnly: true });
    expect(solo.sessions).toHaveLength(1);
    expect(solo.sessions[0].sessionId).toBe("solo-1");
  });

  it("supports status + limit filters", () => {
    const now = new Date().toISOString();
    seedDb(dbPath, (db) => {
      for (let i = 0; i < 5; i++) {
        db.run(
          `INSERT INTO sessions (session_id, status, phase, started_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
          [`s-${i}`, i < 3 ? "done" : "in_progress", i, now, now],
        );
      }
    });

    const done = readSessionStore(dbPath, { status: "done" });
    expect(done.sessions).toHaveLength(3);

    const limited = readSessionStore(dbPath, { limit: 2 });
    expect(limited.sessions).toHaveLength(2);
  });

  it("returns sessions ordered by started_at DESC (newest first)", () => {
    seedDb(dbPath, (db) => {
      db.run(
        `INSERT INTO sessions (session_id, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["old", "done", 6, "2026-04-10T00:00:00Z", "2026-04-10T00:00:00Z"],
      );
      db.run(
        `INSERT INTO sessions (session_id, status, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        ["new", "done", 6, "2026-04-14T00:00:00Z", "2026-04-14T00:00:00Z"],
      );
    });

    const snap = readSessionStore(dbPath);
    expect(snap.sessions.map((s) => s.sessionId)).toEqual(["new", "old"]);
  });

  it("is robust when db is malformed (not a sqlite file)", () => {
    writeFileSync(dbPath, "garbage");
    const snap = readSessionStore(dbPath);
    expect(snap.sessions).toEqual([]);
    expect(snap.available).toBe(false);
  });
});
