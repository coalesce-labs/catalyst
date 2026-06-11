// CTL-967 (N5): unit tests for BeliefTail cursor logic.
//
// These tests drive the BeliefTail entirely in-process against a real in-memory
// bun:sqlite database (no file I/O, no server started). They prove:
//   - poll() returns no rows when the db is empty
//   - poll() returns only NEW rows since the cursor (no duplicates)
//   - prime() sets the cursor to the current max so a fresh connection does
//     not replay history
//   - poll() returns [] gracefully when the db path does not exist
//   - consecutive polls do not return the same row twice
//
// The HTTP-route wiring is intentionally NOT tested here — the integration
// shape (SSE open frame, 200 response headers) mirrors the existing screen /
// transcript SSE endpoint tests (ec-worker-screen-endpoint.test.ts) and would
// require a real server start; a focused cursor test is faster and more
// deterministic.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";
import type { BeliefTail as BeliefTailType } from "../lib/belief-reader.mjs";

const { BeliefTail } = await import("../lib/belief-reader.mjs");

// Intersection type for reaching into the plain-JS private fields in tests.
type TestBeliefTail = BeliefTailType & { _dbLoaded: boolean; _db: unknown };

// --- helpers -----------------------------------------------------------------

function openInMemory(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode = WAL");
  // Minimal schema matching schema.mjs DDL (only the tables BeliefTail needs).
  db.run(`CREATE TABLE IF NOT EXISTS tick (
    tick_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    now_ms    INTEGER NOT NULL,
    host      TEXT    NOT NULL
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS belief (
    belief_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    tick_id         INTEGER NOT NULL,
    stratum         INTEGER NOT NULL,
    name            TEXT NOT NULL,
    subject         TEXT NOT NULL,
    value           TEXT,
    rule_id         TEXT NOT NULL,
    source_fact_ids TEXT NOT NULL,
    UNIQUE (tick_id, name, subject)
  )`);
  return db;
}

function insertTick(db: Database, nowMs: number, host = "test"): number {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [nowMs, host]);
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

function insertBelief(
  db: Database,
  tickId: number,
  name: string,
  subject: string,
  ruleId = "R1",
): number {
  db.run(
    `INSERT OR IGNORE INTO belief
       (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [tickId, 1, name, subject, null, ruleId, "[]"],
  );
  return (db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

/**
 * Build a BeliefTail whose internal DB handle is replaced with an injected
 * in-memory Database so no real file is opened. We reach into the JS object's
 * properties directly (the class is plain JS, no private modifiers).
 */
function makeInMemoryTail(db: Database, pageSize = 200): BeliefTailType {
  const tail = new BeliefTail({ dbPath: ":memory:", pageSize }) as unknown as TestBeliefTail;
  // Inject the already-open in-memory DB so _ensureDb returns it immediately.
  tail._dbLoaded = true;
  tail._db = db;
  return tail;
}

// --- tests -------------------------------------------------------------------

describe("BeliefTail cursor logic (CTL-967)", () => {
  let db: Database;
  let tail: BeliefTailType;

  beforeEach(() => {
    db = openInMemory();
    tail = makeInMemoryTail(db);
  });

  afterEach(() => {
    tail.close();
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  it("returns [] from an empty belief table", async () => {
    const rows = await tail.poll();
    expect(rows).toEqual([]);
  });

  it("returns new rows on first poll when lastBeliefId is 0 (primed to 0)", async () => {
    tail.lastBeliefId = 0;
    const t1 = insertTick(db, 1000);
    insertBelief(db, t1, "session_registered", "CTL-100/plan");
    const rows = await tail.poll();
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("session_registered");
  });

  it("does NOT return the same row on a second consecutive poll", async () => {
    tail.lastBeliefId = 0;
    const t1 = insertTick(db, 2000);
    insertBelief(db, t1, "session_registered", "CTL-200/plan");

    const first = await tail.poll();
    expect(first.length).toBe(1);

    // No new rows inserted — second poll must return [].
    const second = await tail.poll();
    expect(second).toEqual([]);
  });

  it("returns only rows AFTER the cursor position (no duplicates)", async () => {
    tail.lastBeliefId = 0;
    const t1 = insertTick(db, 3000);
    const id1 = insertBelief(db, t1, "belief_a", "CTL-300/plan");

    const first = await tail.poll();
    expect(first.length).toBe(1);
    expect(tail.lastBeliefId).toBe(id1);

    const id2 = insertBelief(db, t1, "belief_b", "CTL-300/research");

    const second = await tail.poll();
    expect(second.length).toBe(1);
    expect(second[0].belief_id).toBe(id2);

    const third = await tail.poll();
    expect(third).toEqual([]);
  });

  it("enriches rows with ts_ms and host from the tick table", async () => {
    tail.lastBeliefId = 0;
    const nowMs = 9_999_999;
    const t1 = insertTick(db, nowMs, "host-alpha");
    insertBelief(db, t1, "worker_dead", "CTL-400/verify");

    const rows = await tail.poll();
    expect(rows.length).toBe(1);
    expect(rows[0].ts_ms).toBe(nowMs);
    expect(rows[0].host).toBe("host-alpha");
  });

  it("prime() sets cursor to current max belief_id (no history replay)", async () => {
    // Insert two beliefs before prime() is called.
    const t1 = insertTick(db, 4000);
    const id1 = insertBelief(db, t1, "old_belief_1", "CTL-500/plan");
    const id2 = insertBelief(db, t1, "old_belief_2", "CTL-500/research");

    // Reset to pristine state (simulates a fresh connection).
    tail.lastBeliefId = -1;
    await tail.prime();
    expect(tail.lastBeliefId).toBe(Math.max(id1, id2));

    // poll() should return no rows (cursor already at the max).
    const rows = await tail.poll();
    expect(rows).toEqual([]);
  });

  it("returns [] gracefully when the db path does not exist", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "belief-tail-absent-"));
    const absentPath = join(tmpDir, "nonexistent.db");
    const realTail = new BeliefTail({ dbPath: absentPath });
    try {
      const rows = await realTail.poll();
      expect(rows).toEqual([]);
    } finally {
      realTail.close();
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ok */
      }
    }
  });

  it("respects pageSize cap — does not return more than pageSize rows per poll", async () => {
    const smallTail = makeInMemoryTail(db, 3 /* pageSize */);
    smallTail.lastBeliefId = 0;
    const t1 = insertTick(db, 5000);
    for (let i = 0; i < 7; i++) {
      insertBelief(db, t1, `belief_${i}`, `CTL-600/plan-${i}`);
    }
    const first = await smallTail.poll();
    expect(first.length).toBe(3);
    const second = await smallTail.poll();
    expect(second.length).toBe(3);
    const third = await smallTail.poll();
    expect(third.length).toBe(1);
    const fourth = await smallTail.poll();
    expect(fourth).toEqual([]);
    smallTail.close();
  });
});
