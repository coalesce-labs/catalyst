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
      removed_at   TEXT,
      updated_at   INTEGER
    )
  `);
  db.run(`CREATE INDEX idx_issues_identifier ON issues (identifier)`);
  // updated_at is epoch-ms (CTL-1366 freshness probe); MAX over these rows is 3000.
  // terminal via completed_at (Done category)
  db.run(`INSERT INTO issues VALUES ('CTL-1', 'Shipped', '2026-06-01T00:00:00Z', NULL, NULL, 1000)`);
  // terminal via canceled_at (Canceled category) — even with a completed_at set,
  // canceled wins (canceled_at is checked first).
  db.run(`INSERT INTO issues VALUES ('CTL-2', 'Abandoned', NULL, '2026-06-02T00:00:00Z', NULL, 2000)`);
  // non-terminal — neither timestamp set; returns the row's actual state name.
  db.run(`INSERT INTO issues VALUES ('CTL-3', 'In Progress', NULL, NULL, NULL, 3000)`);
  // removed (tombstoned) — excluded by removed_at IS NULL → MISS (undefined).
  db.run(`INSERT INTO issues VALUES ('CTL-4', 'In Review', NULL, NULL, '2026-06-03T00:00:00Z', 500)`);
  // non-terminal with NULL state — maps to state: null (not "").
  db.run(`INSERT INTO issues VALUES ('CTL-5', NULL, NULL, NULL, NULL, NULL)`);
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

describe("createReplicaReader.freshness (CTL-1366)", () => {
  test("seeded db → { maxUpdatedAtMs, rowCount } from MAX(updated_at)/COUNT(*)", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.freshness()).toEqual({ maxUpdatedAtMs: 3000, rowCount: 5 });
  });

  test("ISO-8601 updated_at strings are parsed to epoch-ms (Date.parse fallback)", () => {
    const db = new Database(dbPath, { create: true });
    db.run(`CREATE TABLE issues (identifier TEXT, updated_at TEXT)`);
    db.run(`INSERT INTO issues VALUES ('CTL-1', '2026-06-01T00:00:00Z')`);
    db.run(`INSERT INTO issues VALUES ('CTL-2', '2026-06-02T00:00:00Z')`);
    db.close();
    reader = createReplicaReader({ dbPath });
    const f = reader.freshness();
    expect(f.rowCount).toBe(2);
    expect(f.maxUpdatedAtMs).toBe(Date.parse("2026-06-02T00:00:00Z"));
  });

  test("missing DB file → undefined (fail-open), then recovers once created", () => {
    reader = createReplicaReader({ dbPath });
    expect(reader.freshness()).toBeUndefined();
    seed();
    expect(reader.freshness()).toEqual({ maxUpdatedAtMs: 3000, rowCount: 5 });
  });

  test("DB exists but lacks the issues table → undefined (query throws → fail-open)", () => {
    const empty = new Database(dbPath, { create: true });
    empty.run(`CREATE TABLE unrelated (x INTEGER)`);
    empty.close();
    reader = createReplicaReader({ dbPath });
    expect(reader.freshness()).toBeUndefined();
  });

  test("empty issues table (no rows / NULL MAX) → undefined", () => {
    const db = new Database(dbPath, { create: true });
    db.run(`CREATE TABLE issues (identifier TEXT, updated_at INTEGER)`);
    db.close();
    reader = createReplicaReader({ dbPath });
    expect(reader.freshness()).toBeUndefined();
  });
});

// seedTitles — build a minimal `issues` table carrying titles + the removed_at
// tombstone column the batched title reader reads (CTL-1372).
function seedTitles() {
  const db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE issues (identifier TEXT, title TEXT, removed_at TEXT)`);
  db.run(`CREATE INDEX idx_issues_identifier ON issues (identifier)`);
  db.run(`INSERT INTO issues VALUES ('CTL-1214', 'Slim .catalyst/config.json down to the essentials', NULL)`);
  db.run(`INSERT INTO issues VALUES ('CTL-1215', 'Bound the title-desc cache', NULL)`);
  // removed (tombstoned) — excluded by removed_at IS NULL → MISS (omitted).
  db.run(`INSERT INTO issues VALUES ('CTL-9000', 'Tombstoned ticket', '2026-06-03T00:00:00Z')`);
  // null title → omitted (caller falls through to its existing chain).
  db.run(`INSERT INTO issues VALUES ('CTL-8000', NULL, NULL)`);
  db.close();
}

describe("createReplicaReader.titles (CTL-1372 — batched board title source)", () => {
  test("returns an { identifier → title } map for HITS", () => {
    seedTitles();
    reader = createReplicaReader({ dbPath });
    expect(reader.titles(["CTL-1214", "CTL-1215"])).toEqual({
      "CTL-1214": "Slim .catalyst/config.json down to the essentials",
      "CTL-1215": "Bound the title-desc cache",
    });
  });

  test("the parked-ticket repro: a single id resolves to its real Linear title", () => {
    seedTitles();
    reader = createReplicaReader({ dbPath });
    // The exact live-diagnosed case — CTL-1214 must NOT render as the bare id.
    expect(reader.titles(["CTL-1214"])["CTL-1214"]).toBe(
      "Slim .catalyst/config.json down to the essentials",
    );
  });

  test("omits absent ids, tombstoned rows, and null titles (MISS → caller falls through)", () => {
    seedTitles();
    reader = createReplicaReader({ dbPath });
    const map = reader.titles(["CTL-1214", "CTL-9000", "CTL-8000", "CTL-404"]);
    expect(map).toEqual({ "CTL-1214": "Slim .catalyst/config.json down to the essentials" });
    expect("CTL-9000" in map).toBe(false); // tombstoned
    expect("CTL-8000" in map).toBe(false); // null title
    expect("CTL-404" in map).toBe(false); // absent
  });

  test("empty / non-array / all-falsy input → {} without touching the DB", () => {
    reader = createReplicaReader({ dbPath });
    expect(reader.titles([])).toEqual({});
    expect(reader.titles(null)).toEqual({});
    expect(reader.titles(["", null, undefined])).toEqual({});
  });

  test("de-dupes the requested ids", () => {
    seedTitles();
    reader = createReplicaReader({ dbPath });
    expect(reader.titles(["CTL-1214", "CTL-1214", "CTL-1214"])).toEqual({
      "CTL-1214": "Slim .catalyst/config.json down to the essentials",
    });
  });

  test("chunks beyond the bound-parameter ceiling (>400 ids) without throwing", () => {
    seedTitles();
    reader = createReplicaReader({ dbPath });
    const many = Array.from({ length: 950 }, (_, i) => `CTL-${i}`);
    many.push("CTL-1214"); // one real hit amid the misses
    const map = reader.titles(many);
    expect(map["CTL-1214"]).toBe("Slim .catalyst/config.json down to the essentials");
  });

  test("fail-open: missing DB → {}, then recovers once created", () => {
    reader = createReplicaReader({ dbPath });
    expect(reader.titles(["CTL-1214"])).toEqual({}); // no db yet → fail-open
    seedTitles();
    expect(reader.titles(["CTL-1214"])).toEqual({
      "CTL-1214": "Slim .catalyst/config.json down to the essentials",
    });
  });

  test("fail-open: DB without the issues table → {} (query throws → fail-open)", () => {
    const empty = new Database(dbPath, { create: true });
    empty.run(`CREATE TABLE unrelated (x INTEGER)`);
    empty.close();
    reader = createReplicaReader({ dbPath });
    expect(reader.titles(["CTL-1214"])).toEqual({});
  });
});
