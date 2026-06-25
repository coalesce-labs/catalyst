// Tests for replica-read.mjs (CTL-1340) — the daemon's readonly client over the
// local Catalyst-Cloud SQLite replica. The fixture DB is built with REAL
// bun:sqlite (the only test exercising the real SQL + adapter), seeding an
// `issues` table that mirrors the cloud schema's terminal-relevant columns.
// Run: bun test plugins/dev/scripts/execution-core/replica-read.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplicaReader } from "./replica-read.mjs";

let tmpDir;
let dbPath;
let reader;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "replica-read-test-"));
  dbPath = join(tmpDir, "catalyst-replica.db");
});

afterEach(() => {
  reader?.close();
  reader = null;
  rmSync(tmpDir, { recursive: true, force: true });
});

// seed — build the minimal `issues` table the light terminal SELECT reads, with
// the index the prod query is backed by, then insert the four canonical rows.
function seed() {
  const db = new Database(dbPath, { create: true });
  db.run(`
    CREATE TABLE issues (
      identifier   TEXT,
      state        TEXT,
      completed_at TEXT,
      canceled_at  TEXT,
      removed_at   TEXT
    )
  `);
  db.run(`CREATE INDEX idx_issues_identifier ON issues (identifier)`);
  // terminal via completed_at (Done category)
  db.run(`INSERT INTO issues VALUES ('CTL-1', 'Shipped', '2026-06-01T00:00:00Z', NULL, NULL)`);
  // terminal via canceled_at (Canceled category) — even with a completed_at set,
  // canceled wins (canceled_at is checked first).
  db.run(`INSERT INTO issues VALUES ('CTL-2', 'Abandoned', NULL, '2026-06-02T00:00:00Z', NULL)`);
  // non-terminal — neither timestamp set; returns the row's actual state name.
  db.run(`INSERT INTO issues VALUES ('CTL-3', 'In Progress', NULL, NULL, NULL)`);
  // removed (tombstoned) — excluded by removed_at IS NULL → MISS (undefined).
  db.run(`INSERT INTO issues VALUES ('CTL-4', 'In Review', NULL, NULL, '2026-06-03T00:00:00Z')`);
  // non-terminal with NULL state — maps to state: null (not "").
  db.run(`INSERT INTO issues VALUES ('CTL-5', NULL, NULL, NULL, NULL)`);
  db.close();
}

describe("createReplicaReader.lookup (real bun:sqlite)", () => {
  test("HIT completed_at → { terminal: true, state: 'Done' }", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.lookup("CTL-1")).toEqual({ terminal: true, state: "Done" });
  });

  test("HIT canceled_at → { terminal: true, state: 'Canceled' } (canceled wins)", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.lookup("CTL-2")).toEqual({ terminal: true, state: "Canceled" });
  });

  test("HIT non-terminal → { terminal: false, state } with the row's actual name", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.lookup("CTL-3")).toEqual({ terminal: false, state: "In Progress" });
  });

  test("HIT non-terminal with NULL state → { terminal: false, state: null }", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.lookup("CTL-5")).toEqual({ terminal: false, state: null });
  });

  test("removed (tombstoned) row → undefined (MISS, caller falls through)", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.lookup("CTL-4")).toBeUndefined();
  });

  test("absent ticket → undefined (MISS)", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.lookup("CTL-404")).toBeUndefined();
  });

  test("empty/falsy identifier → undefined without touching the DB", () => {
    reader = createReplicaReader({ dbPath });
    expect(reader.lookup("")).toBeUndefined();
    expect(reader.lookup(null)).toBeUndefined();
    expect(reader.lookup(undefined)).toBeUndefined();
  });
});

describe("createReplicaReader — fail-open", () => {
  test("missing DB file → undefined, then recovers once created", () => {
    reader = createReplicaReader({ dbPath });
    expect(reader.lookup("CTL-1")).toBeUndefined(); // no db yet → fail-open MISS
    seed(); // replica daemon creates the DB after the failed read
    expect(reader.lookup("CTL-1")).toEqual({ terminal: true, state: "Done" });
  });

  test("DB exists but lacks the issues table → undefined; recovers after re-seed", () => {
    // open-succeeds-then-query-throws path: the SELECT throws, the catch drops
    // the handle so the next call re-opens and sees the seeded schema.
    const empty = new Database(dbPath, { create: true });
    empty.run(`CREATE TABLE unrelated (x INTEGER)`);
    empty.close();
    reader = createReplicaReader({ dbPath });
    expect(reader.lookup("CTL-1")).toBeUndefined();
    seed();
    expect(reader.lookup("CTL-3")).toEqual({ terminal: false, state: "In Progress" });
  });
});
