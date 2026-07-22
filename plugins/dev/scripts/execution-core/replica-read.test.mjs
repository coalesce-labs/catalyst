// Tests for replica-read.mjs (CTL-1340) — the daemon's readonly client over the
// local Catalyst-Cloud SQLite replica. The fixture DB is built with REAL
// bun:sqlite (the only test exercising the real SQL + adapter), seeding an
// `issues` table that mirrors the cloud schema's terminal-relevant columns.
// Run: bun test plugins/dev/scripts/execution-core/replica-read.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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

// CTL-1397 — board-list / eligible() tests. The replica-backed discovery query
// the daemon's reconcile uses instead of `linearis issues list --team X --status
// Y` (which burns the shared Linear quota + trips the CTL-679 circuit breaker,
// freezing board discovery fleet-wide). The fixture mirrors the cloud schema's
// eligible-relevant columns + relations + projects so the SQL + enrichment +
// timestamp coercion are exercised against REAL bun:sqlite.

// fresh — bump the DB + a NON-EMPTY -wal sidecar's mtime to NOW so the
// mtime-based staleness gate (writer-liveness proxy) reads the fixture as fresh.
// Without this, a fixture written "in the past" relative to the 5-min threshold
// would (correctly) fall through, masking the row assertions we're after.
function freshen() {
  const now = new Date();
  utimesSync(dbPath, now, now);
  try {
    // open + WAL-checkpoint leaves a -wal sidecar; if it's empty the gate ignores
    // it (reader artifact). Write a byte so its mtime counts, then touch it now.
    writeFileSync(dbPath + "-wal", "x");
    utimesSync(dbPath + "-wal", now, now);
  } catch {
    /* best-effort: the DB mtime alone is enough when -wal is absent */
  }
}

// seedEligible — the full eligible fixture: issues (with team-prefixed
// identifiers, state, priority, estimate, project_id, parent_identifier,
// delegate, removed_at, timestamps), a relations table (forward + inverse), and
// a projects table (LEFT JOIN name source).
function seedEligible() {
  const db = new Database(dbPath, { create: true });
  db.run(`
    CREATE TABLE issues (
      identifier        TEXT,
      title             TEXT,
      state             TEXT,
      priority          INTEGER,
      estimate          INTEGER,
      project_id        TEXT,
      parent_identifier TEXT,
      delegate_id       TEXT,
      delegate_name     TEXT,
      removed_at        TEXT,
      updated_at        INTEGER,
      created_at        INTEGER
    )
  `);
  db.run(`CREATE INDEX idx_issues_identifier ON issues (identifier)`);
  db.run(`CREATE TABLE relations (type TEXT, issue_identifier TEXT, related_identifier TEXT)`);
  db.run(`CREATE TABLE projects (id TEXT, name TEXT)`);
  // CTL-1397: sync_meta carries the seed-completeness cursor. The cloud-sync
  // writer DELETES the cursor row at re-seed start and re-writes it only on
  // completion, so cursor-present = seed complete (the gate eligible() checks).
  db.run(`CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`INSERT INTO sync_meta VALUES ('cursor', '42')`);
  db.run(`INSERT INTO projects VALUES ('proj-1', 'Harden the core')`);
  // CTL-100: Todo, priority 2, in a project, has a parent + a delegate, newest.
  db.run(
    `INSERT INTO issues VALUES ('CTL-100', 'Repoint board-list', 'Todo', 2, 3, 'proj-1', 'CTL-1', 'del-1', 'Bot', NULL, 3000, 100)`,
  );
  // CTL-101: Todo, priority 0 (no priority), no project/parent/delegate, older.
  db.run(
    `INSERT INTO issues VALUES ('CTL-101', 'Second todo', 'Todo', 0, NULL, NULL, NULL, NULL, NULL, NULL, 2000, 90)`,
  );
  // CTL-102: Backlog (NOT Todo) — excluded by the state filter.
  db.run(
    `INSERT INTO issues VALUES ('CTL-102', 'Backlogged', 'Backlog', 1, NULL, NULL, NULL, NULL, NULL, NULL, 2500, 80)`,
  );
  // CTL-103: Todo but tombstoned (removed_at set) — excluded by removed_at IS NULL.
  db.run(
    `INSERT INTO issues VALUES ('CTL-103', 'Removed todo', 'Todo', 2, NULL, NULL, NULL, NULL, NULL, '2026-06-03T00:00:00Z', 2600, 70)`,
  );
  // CTC-100: a DIFFERENT team (the hyphen disambiguates CTL- from CTC-) — must
  // not leak into a CTL query via a naive prefix match.
  db.run(
    `INSERT INTO issues VALUES ('CTC-100', 'Other team todo', 'Todo', 2, NULL, NULL, NULL, NULL, NULL, NULL, 2700, 60)`,
  );
  // relations: CTL-100 blocks CTL-9 (forward); CTL-7 blocks CTL-100 (inverse).
  db.run(`INSERT INTO relations VALUES ('blocks', 'CTL-100', 'CTL-9')`);
  db.run(`INSERT INTO relations VALUES ('blocks', 'CTL-7', 'CTL-100')`);
  db.close();
  freshen();
}

describe("createReplicaReader.eligible (CTL-1397 board-list)", () => {
  test("returns { nodes } filtered by identifier-prefix + state, excludes removed + other teams", () => {
    seedEligible();
    reader = createReplicaReader({ dbPath });
    const res = reader.eligible({ team: "CTL", status: "Todo" });
    expect(Array.isArray(res?.nodes)).toBe(true);
    // CTL-100 (newest) then CTL-101 (ORDER BY updated_at DESC). NOT CTL-102
    // (Backlog), NOT CTL-103 (removed), NOT CTC-100 (other team).
    expect(res.nodes.map((n) => n.identifier)).toEqual(["CTL-100", "CTL-101"]);
  });

  test("builds a node normalizeTicket consumes: state/priority/estimate/project/parent/delegate + ISO timestamps", () => {
    seedEligible();
    reader = createReplicaReader({ dbPath });
    const res = reader.eligible({ team: "CTL", status: "Todo" });
    const n = res.nodes.find((x) => x.identifier === "CTL-100");
    expect(n.title).toBe("Repoint board-list");
    expect(n.state).toBe("Todo");
    expect(n.priority).toBe(2);
    expect(n.estimate).toBe(3);
    expect(n.project).toBe("Harden the core");
    expect(n.parent).toBe("CTL-1");
    expect(n.delegate).toEqual({ id: "del-1", name: "Bot" });
    // epoch-ms → ISO-8601 string (the scheduler tie-break compares these).
    expect(n.updatedAt).toBe(new Date(3000).toISOString());
    expect(n.createdAt).toBe(new Date(100).toISOString());
  });

  test("enriches relations (forward) + inverseRelations from the relations table", () => {
    seedEligible();
    reader = createReplicaReader({ dbPath });
    const res = reader.eligible({ team: "CTL", status: "Todo" });
    const n = res.nodes.find((x) => x.identifier === "CTL-100");
    expect(n.relations.nodes).toEqual([
      { type: "blocks", relatedIssue: { identifier: "CTL-9" } },
    ]);
    expect(n.inverseRelations.nodes).toEqual([
      { type: "blocks", issue: { identifier: "CTL-7" } },
    ]);
  });

  test("a row with no project/parent/delegate maps those to null + empty relation node lists", () => {
    seedEligible();
    reader = createReplicaReader({ dbPath });
    const res = reader.eligible({ team: "CTL", status: "Todo" });
    const n = res.nodes.find((x) => x.identifier === "CTL-101");
    expect(n.project).toBeNull();
    expect(n.parent).toBeNull();
    expect(n.delegate).toBeNull();
    expect(n.priority).toBe(0);
    expect(n.estimate).toBeNull();
    expect(n.relations.nodes).toEqual([]);
    expect(n.inverseRelations.nodes).toEqual([]);
  });

  test("fresh-empty (no matching rows) → { nodes: [] }, NOT undefined", () => {
    seedEligible();
    reader = createReplicaReader({ dbPath });
    // A team with zero Todo rows: a fresh replica genuinely has no eligible
    // tickets — that is a REAL answer, not a fall-through miss.
    const res = reader.eligible({ team: "ZZZ", status: "Todo" });
    expect(res).toEqual({ nodes: [] });
  });

  test("returns undefined (fall through) when team is missing", () => {
    seedEligible();
    reader = createReplicaReader({ dbPath });
    expect(reader.eligible({ status: "Todo" })).toBeUndefined();
  });

  test("returns undefined (fall through) when status is missing", () => {
    seedEligible();
    reader = createReplicaReader({ dbPath });
    expect(reader.eligible({ team: "CTL" })).toBeUndefined();
  });

  // D1 (Stage 0): project-filtered queries are now SERVED from the replica (the
  // permanent every-tick fall-through to `linearis issues list` for project-scoped
  // teams is closed). The filter is an EXACT project-name match on the LEFT JOIN.
  test("D1: serves a project-filtered query from the replica (exact project name)", () => {
    seedEligible();
    reader = createReplicaReader({ dbPath });
    const res = reader.eligible({ team: "CTL", status: "Todo", project: "Harden the core" });
    // Only CTL-100 is in proj-1 ("Harden the core"); CTL-101 has no project.
    expect(res.nodes.map((n) => n.identifier)).toEqual(["CTL-100"]);
  });

  test("D1: a project filter that matches nothing → { nodes: [] } (served, NOT undefined)", () => {
    seedEligible();
    reader = createReplicaReader({ dbPath });
    // A defined empty answer — the caller must NOT re-run linearis for it.
    expect(reader.eligible({ team: "CTL", status: "Todo", project: "Nonexistent" })).toEqual({
      nodes: [],
    });
  });

  test("returns undefined when the replica file is absent", () => {
    reader = createReplicaReader({ dbPath });
    expect(reader.eligible({ team: "CTL", status: "Todo" })).toBeUndefined();
  });

  test("returns undefined when the replica is STALE by mtime", () => {
    seedEligible();
    // Backdate the DB + -wal well past the default 5-min staleness threshold.
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(dbPath, old, old);
    try { utimesSync(dbPath + "-wal", old, old); } catch { /* -wal may be absent */ }
    reader = createReplicaReader({ dbPath });
    expect(reader.eligible({ team: "CTL", status: "Todo" })).toBeUndefined();
  });

  test("honors CATALYST_LINEAR_REPLICA_STALE_MS override for the freshness gate", () => {
    seedEligible();
    const old = new Date(Date.now() - 2 * 60_000); // 2 min old
    utimesSync(dbPath, old, old);
    try { utimesSync(dbPath + "-wal", old, old); } catch { /* -wal may be absent */ }
    // no writer.lock in this fixture → the gate falls back to the db/-wal mtime.
    const prev = process.env.CATALYST_LINEAR_REPLICA_STALE_MS;
    process.env.CATALYST_LINEAR_REPLICA_STALE_MS = "60000"; // 1 min threshold → 2-min-old is stale
    try {
      reader = createReplicaReader({ dbPath });
      expect(reader.eligible({ team: "CTL", status: "Todo" })).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CATALYST_LINEAR_REPLICA_STALE_MS;
      else process.env.CATALYST_LINEAR_REPLICA_STALE_MS = prev;
    }
  });

  // CTL-1397 (4/n) — the freshness gate prefers the writer's HEARTBEAT lock
  // (`<db>.writer.lock`) over the db/-wal mtime, so a QUIET feed (live writer, no
  // issue updates → stale -wal) still serves discovery from the replica instead of
  // false-falling-through to linearis.
  test("QUIET FEED: fresh .writer.lock + STALE db/-wal → still serves the replica (no linearis fallback)", () => {
    seedEligible();
    // Simulate a quiet feed: the db + -wal went stale (no recent apply)…
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(dbPath, old, old);
    try { utimesSync(dbPath + "-wal", old, old); } catch { /* -wal may be absent */ }
    // …but the writer is alive and heartbeated its lock just now.
    writeFileSync(dbPath + ".writer.lock", "");
    utimesSync(dbPath + ".writer.lock", new Date(), new Date());
    reader = createReplicaReader({ dbPath });
    const res = reader.eligible({ team: "CTL", status: "Todo" });
    expect(res?.nodes.map((n) => n.identifier)).toEqual(["CTL-100", "CTL-101"]);
  });

  test("DEAD WRITER: STALE .writer.lock is authoritative → undefined even if db/-wal is fresh", () => {
    seedEligible(); // db + -wal fresh (a recent apply just before the writer died)
    // The writer died: its lock stopped heartbeating and is now well past the threshold.
    const old = new Date(Date.now() - 10 * 60_000);
    writeFileSync(dbPath + ".writer.lock", "");
    utimesSync(dbPath + ".writer.lock", old, old);
    reader = createReplicaReader({ dbPath });
    // A present-but-stale lock means the writer is gone → do NOT serve (the data
    // will only drift from here), even though the db/-wal mtime is fresh.
    expect(reader.eligible({ team: "CTL", status: "Todo" })).toBeUndefined();
  });

  test("fail-open: DB without the issues table → undefined (query throws)", () => {
    const empty = new Database(dbPath, { create: true });
    empty.run(`CREATE TABLE unrelated (x INTEGER)`);
    empty.close();
    freshen();
    reader = createReplicaReader({ dbPath });
    expect(reader.eligible({ team: "CTL", status: "Todo" })).toBeUndefined();
  });

  // CTL-1397 (P1 fix) — seed-completeness gate. The mtime gate proves the writer
  // is LIVE, not that the seed is COMPLETE. The cloud-sync forced re-seed
  // truncates + batch-repopulates `issues` while the mtime stays fresh, so a
  // mid-reseed read would (a) see an EMPTY table → trusted-empty zeroes the board
  // or (b) see a PARTIAL table → trusted-incomplete set. The writer deletes the
  // `sync_meta` cursor row at re-seed start and re-writes it only on completion,
  // so cursor-absent = mid-reseed → eligible() must NOT serve (fall through).

  test("cursor row ABSENT (mid-reseed) on a fresh+populated DB → undefined (fall through)", () => {
    seedEligible(); // fresh + populated + cursor present
    // Simulate the writer mid-reseed: it deletes the cursor row at re-seed start.
    const db = new Database(dbPath);
    db.run(`DELETE FROM sync_meta WHERE key = 'cursor'`);
    db.close();
    freshen(); // the writer is STILL live (fresh mtime) — only the seed is incomplete
    reader = createReplicaReader({ dbPath });
    // Even though CTL-100/CTL-101 rows are present, a missing cursor means the
    // seed is not known-complete → do not trust the read.
    expect(reader.eligible({ team: "CTL", status: "Todo" })).toBeUndefined();
  });

  test("cursor present (seed complete) + matching rows → returns { nodes } as before", () => {
    seedEligible();
    reader = createReplicaReader({ dbPath });
    const res = reader.eligible({ team: "CTL", status: "Todo" });
    expect(res.nodes.map((n) => n.identifier)).toEqual(["CTL-100", "CTL-101"]);
  });

  test("cursor present but EMPTY value (key exists, value '') → undefined (mid-reseed sentinel)", () => {
    seedEligible();
    const db = new Database(dbPath);
    db.run(`UPDATE sync_meta SET value = '' WHERE key = 'cursor'`);
    db.close();
    freshen();
    reader = createReplicaReader({ dbPath });
    expect(reader.eligible({ team: "CTL", status: "Todo" })).toBeUndefined();
  });

  test("cursor present + ZERO matching rows → still { nodes: [] } at the READER level (empty-distrust lives in runEligibleQuery, not here)", () => {
    seedEligible(); // cursor present, but no ZZZ-team rows
    reader = createReplicaReader({ dbPath });
    // The reader's contract is unchanged for a genuinely-empty, seed-complete
    // result: it returns { nodes: [] }. The decision to DISTRUST a replica-empty
    // (and confirm via linearis) belongs to runEligibleQuery — the two layers'
    // responsibilities stay distinct.
    expect(reader.eligible({ team: "ZZZ", status: "Todo" })).toEqual({ nodes: [] });
  });

  // CTL-1397 (P1 fix #2, Codex review) — the cursor gate + board + relation reads
  // now run inside ONE deferred read transaction so a forced re-seed can't slip
  // between the gate and the data SELECTs (serving a partial board). The race is
  // single-snapshot SQLite isolation that a synchronous fixture can't interleave,
  // so these lock the OBSERVABLE properties of the wrapped path: it works in WAL
  // (prod journal mode), it commits/releases the snapshot every call (a botched
  // COMMIT would leak a read txn → the second call's BEGIN nests/throws or the WAL
  // never releases), and the gate still composes inside the transaction.
  test("WAL journal mode (prod shape): repeated eligible() calls each commit/release the snapshot and return the consistent board", () => {
    const db = new Database(dbPath, { create: true });
    db.run(`PRAGMA journal_mode = WAL`); // exercise the prod journal mode the snapshot fix targets
    db.run(`CREATE TABLE issues (identifier TEXT, title TEXT, state TEXT, priority INTEGER, estimate INTEGER, project_id TEXT, parent_identifier TEXT, delegate_id TEXT, delegate_name TEXT, removed_at TEXT, updated_at INTEGER, created_at INTEGER)`);
    db.run(`CREATE INDEX idx_issues_identifier ON issues (identifier)`);
    db.run(`CREATE TABLE relations (type TEXT, issue_identifier TEXT, related_identifier TEXT)`);
    db.run(`CREATE TABLE projects (id TEXT, name TEXT)`);
    db.run(`CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)`);
    db.run(`INSERT INTO sync_meta VALUES ('cursor', '42')`);
    db.run(`INSERT INTO issues VALUES ('CTL-100', 'Repoint board-list', 'Todo', 2, 3, NULL, NULL, NULL, NULL, NULL, 3000, 100)`);
    db.run(`INSERT INTO issues VALUES ('CTL-101', 'Second todo', 'Todo', 0, NULL, NULL, NULL, NULL, NULL, NULL, 2000, 90)`);
    db.run(`INSERT INTO relations VALUES ('blocks', 'CTL-7', 'CTL-100')`);
    db.close();
    freshen();
    reader = createReplicaReader({ dbPath });
    const first = reader.eligible({ team: "CTL", status: "Todo" });
    expect(first.nodes.map((n) => n.identifier)).toEqual(["CTL-100", "CTL-101"]);
    // A second call must succeed identically — proving the prior call's read
    // transaction was committed/released (not left open pinning the WAL snapshot).
    const second = reader.eligible({ team: "CTL", status: "Todo" });
    expect(second.nodes.map((n) => n.identifier)).toEqual(["CTL-100", "CTL-101"]);
    // The inverse (blocked-by) relation, enriched INSIDE the same snapshot, survives.
    expect(second.nodes[0].inverseRelations.nodes).toEqual([
      { type: "blocks", issue: { identifier: "CTL-7" } },
    ]);
  });
});

// D1 (Stage 0) — label-filtered eligible(). Needs the issue_labels⋈labels join keyed
// by the issue's own PK `id`, so this fixture carries the `id` column + the two label
// tables the corrected join reads (issue_labels(issue_id,label_id) + labels(id,name)).
function seedEligibleLabeled() {
  const db = new Database(dbPath, { create: true });
  db.run(`
    CREATE TABLE issues (
      id                TEXT,
      identifier        TEXT,
      title             TEXT,
      state             TEXT,
      priority          INTEGER,
      estimate          INTEGER,
      project_id        TEXT,
      parent_identifier TEXT,
      delegate_id       TEXT,
      delegate_name     TEXT,
      removed_at        TEXT,
      updated_at        INTEGER,
      created_at        INTEGER
    )
  `);
  db.run(`CREATE INDEX idx_issues_identifier ON issues (identifier)`);
  db.run(`CREATE TABLE relations (type TEXT, issue_identifier TEXT, related_identifier TEXT)`);
  db.run(`CREATE TABLE projects (id TEXT, name TEXT)`);
  db.run(`CREATE TABLE labels (id TEXT, name TEXT)`);
  db.run(`CREATE TABLE issue_labels (issue_id TEXT, label_id TEXT)`);
  db.run(`CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`INSERT INTO sync_meta VALUES ('cursor', '42')`);
  db.run(`INSERT INTO labels VALUES ('lab-bug', 'bug')`);
  db.run(`INSERT INTO labels VALUES ('lab-chore', 'chore')`);
  // CTL-200 labeled 'bug'; CTL-201 labeled 'chore'; both Todo.
  db.run(
    `INSERT INTO issues VALUES ('id-200', 'CTL-200', 'Bug ticket', 'Todo', 2, NULL, NULL, NULL, NULL, NULL, NULL, 3000, 100)`,
  );
  db.run(
    `INSERT INTO issues VALUES ('id-201', 'CTL-201', 'Chore ticket', 'Todo', 2, NULL, NULL, NULL, NULL, NULL, NULL, 2000, 90)`,
  );
  db.run(`INSERT INTO issue_labels VALUES ('id-200', 'lab-bug')`);
  db.run(`INSERT INTO issue_labels VALUES ('id-201', 'lab-chore')`);
  db.close();
  freshen();
}

describe("createReplicaReader.eligible — D1 label filter (Stage 0)", () => {
  test("serves a label-filtered query from the replica (issue_labels⋈labels by name)", () => {
    seedEligibleLabeled();
    reader = createReplicaReader({ dbPath });
    const res = reader.eligible({ team: "CTL", status: "Todo", label: "bug" });
    expect(res.nodes.map((n) => n.identifier)).toEqual(["CTL-200"]); // only the 'bug' ticket
  });

  test("a different label selects the other ticket (join resolves identifier→id correctly)", () => {
    seedEligibleLabeled();
    reader = createReplicaReader({ dbPath });
    const res = reader.eligible({ team: "CTL", status: "Todo", label: "chore" });
    expect(res.nodes.map((n) => n.identifier)).toEqual(["CTL-201"]);
  });

  test("a label matching nothing → { nodes: [] } (served, NOT undefined)", () => {
    seedEligibleLabeled();
    reader = createReplicaReader({ dbPath });
    expect(reader.eligible({ team: "CTL", status: "Todo", label: "nonexistent" })).toEqual({
      nodes: [],
    });
  });

  test("project + label combined AND both filters", () => {
    seedEligibleLabeled();
    reader = createReplicaReader({ dbPath });
    // No project set on these rows, so a project filter + label yields nothing.
    expect(
      reader.eligible({ team: "CTL", status: "Todo", label: "bug", project: "Harden the core" }),
    ).toEqual({ nodes: [] });
  });
});

// ownership() (Stage 0 / A0) — the per-ticket claim-gate reader. Same freshness +
// seed-cursor gate as eligible() (NO per-ticket currency gate — the null-vs-non-null
// trust decision lives in fetchTicketAssignee); any gate-fail / miss → undefined
// (caller HOLDs / falls through, never claims on unknown).
function seedOwnership() {
  const db = new Database(dbPath, { create: true });
  db.run(
    `CREATE TABLE issues (identifier TEXT, assignee_id TEXT, delegate_id TEXT, delegate_name TEXT, removed_at TEXT)`,
  );
  db.run(`CREATE INDEX idx_issues_identifier ON issues (identifier)`);
  db.run(`CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`INSERT INTO sync_meta VALUES ('cursor', '42')`);
  db.run(`INSERT INTO issues VALUES ('CTL-300', 'user-1', 'bot-9', 'Bot', NULL)`); // assigned + delegated
  db.run(`INSERT INTO issues VALUES ('CTL-301', NULL, NULL, NULL, NULL)`); // unassigned/undelegated
  db.run(`INSERT INTO issues VALUES ('CTL-302', 'user-2', 'user-3', 'Human', NULL)`); // human delegate
  db.run(`INSERT INTO issues VALUES ('CTL-303', 'user-1', 'bot-9', 'Bot', '2026-06-03T00:00:00Z')`); // removed
  db.close();
}

// backdate — push a file's mtime N minutes into the past (liveness/currency fixtures).
function backdate(path, minutes) {
  const t = new Date(Date.now() - minutes * 60_000);
  try {
    utimesSync(path, t, t);
  } catch {
    /* absent */
  }
}

describe("createReplicaReader.ownership (Stage 0 / A0)", () => {
  test("fresh (liveness + seed pass) → HIT { assignee, delegate }", () => {
    seedOwnership();
    freshen();
    reader = createReplicaReader({ dbPath });
    expect(reader.ownership("CTL-300")).toEqual({ assignee: "user-1", delegate: "bot-9" });
  });

  test("HIT coerces unset assignee/delegate to null", () => {
    seedOwnership();
    freshen();
    reader = createReplicaReader({ dbPath });
    expect(reader.ownership("CTL-301")).toEqual({ assignee: null, delegate: null });
  });

  test("HIT reports a human delegate verbatim (the claim decision lives in the caller)", () => {
    seedOwnership();
    freshen();
    reader = createReplicaReader({ dbPath });
    expect(reader.ownership("CTL-302")).toEqual({ assignee: "user-2", delegate: "user-3" });
  });

  test("removed (tombstoned) row → undefined (MISS → caller HOLDs)", () => {
    seedOwnership();
    freshen();
    reader = createReplicaReader({ dbPath });
    expect(reader.ownership("CTL-303")).toBeUndefined();
  });

  test("absent ticket → undefined", () => {
    seedOwnership();
    freshen();
    reader = createReplicaReader({ dbPath });
    expect(reader.ownership("CTL-404")).toBeUndefined();
  });

  test("empty/falsy identifier → undefined without touching the DB", () => {
    reader = createReplicaReader({ dbPath });
    expect(reader.ownership("")).toBeUndefined();
    expect(reader.ownership(null)).toBeUndefined();
    expect(reader.ownership(undefined)).toBeUndefined();
  });

  test("STALE .writer.lock (dead writer) → undefined (liveness gate fails)", () => {
    seedOwnership();
    freshen(); // db/-wal fresh (a recent apply just before the writer died)
    writeFileSync(dbPath + ".writer.lock", "");
    backdate(dbPath + ".writer.lock", 10); // present-but-stale lock is authoritative → liveness fails
    reader = createReplicaReader({ dbPath });
    expect(reader.ownership("CTL-300")).toBeUndefined();
  });

  test("mid-reseed (cursor absent) on a fresh DB → undefined (seed gate)", () => {
    seedOwnership();
    const db = new Database(dbPath);
    db.run(`DELETE FROM sync_meta WHERE key = 'cursor'`);
    db.close();
    freshen(); // liveness passes; only the seed is incomplete
    reader = createReplicaReader({ dbPath });
    expect(reader.ownership("CTL-300")).toBeUndefined();
  });

  // Regression (Stage-0 review): there is deliberately NO per-ticket currency gate.
  // File mtime cannot detect PER-TICKET lag, and gating on it re-froze the claim gate
  // on a genuinely QUIET-but-current feed (the CTL-1397 antipattern). As long as the
  // writer is LIVE (fresh lock) and the seed is complete, ownership() serves the row
  // even when the data-file mtimes are old — the null-vs-non-null trust decision is
  // the caller's (fetchTicketAssignee live-confirms every null delegate).
  test("STALE data files but LIVE writer + complete seed → HIT (no currency gate)", () => {
    seedOwnership();
    backdate(dbPath, 30); // data files stale far beyond any old currency window …
    backdate(dbPath + "-wal", 30);
    // … but the writer is alive: a just-heartbeated lock keeps liveness passing.
    writeFileSync(dbPath + ".writer.lock", "");
    utimesSync(dbPath + ".writer.lock", new Date(), new Date());
    reader = createReplicaReader({ dbPath });
    expect(reader.ownership("CTL-300")).toEqual({ assignee: "user-1", delegate: "bot-9" });
  });
});

// labels() (CTL-1481 — worker-label visibility projection read). Same freshness +
// seed-cursor gate as ownership(); any gate-fail/miss/throw → undefined (caller
// falls through, never trusts a stale/partial label list). Resolves
// identifier → internal id first (issue_labels keys off the PK, matching the
// identifier→id resolution eligible()'s label-EXISTS join needs), then joins
// issue_labels⋈labels for that id.
function seedLabels() {
  const db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE issues (id TEXT, identifier TEXT, removed_at TEXT)`);
  db.run(`CREATE INDEX idx_issues_identifier ON issues (identifier)`);
  db.run(`CREATE TABLE labels (id TEXT, name TEXT, removed_at TEXT)`);
  db.run(`CREATE TABLE issue_labels (issue_id TEXT, label_id TEXT)`);
  db.run(`CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.run(`INSERT INTO sync_meta VALUES ('cursor', '42')`);
  db.run(`INSERT INTO labels VALUES ('lab-a', 'worker:mini', NULL)`);
  db.run(`INSERT INTO labels VALUES ('lab-b', 'type:bug', NULL)`);
  // CTL-400: two live labels attached — the sort-order + basic HIT case.
  db.run(`INSERT INTO issues VALUES ('id-400', 'CTL-400', NULL)`);
  db.run(`INSERT INTO issue_labels VALUES ('id-400', 'lab-a')`);
  db.run(`INSERT INTO issue_labels VALUES ('id-400', 'lab-b')`);
  // CTL-401: no labels attached at all — a defined, authoritative [].
  db.run(`INSERT INTO issues VALUES ('id-401', 'CTL-401', NULL)`);
  // CTL-402: tombstoned issue (removed_at set) — excluded by removed_at IS NULL.
  db.run(`INSERT INTO issues VALUES ('id-402', 'CTL-402', '2026-06-03T00:00:00Z')`);
  db.run(`INSERT INTO issue_labels VALUES ('id-402', 'lab-a')`);
  // CTL-403: one live label ('lab-a') + one tombstoned label ('lab-c') attached —
  // the tombstoned label must be filtered out of the returned list.
  db.run(`INSERT INTO labels VALUES ('lab-c', 'worker:mini-2', '2026-06-03T00:00:00Z')`);
  db.run(`INSERT INTO issues VALUES ('id-403', 'CTL-403', NULL)`);
  db.run(`INSERT INTO issue_labels VALUES ('id-403', 'lab-a')`);
  db.run(`INSERT INTO issue_labels VALUES ('id-403', 'lab-c')`);
  db.close();
  freshen();
}

describe("createReplicaReader.labels (CTL-1481 — worker-label visibility read)", () => {
  test("fresh + seeded issue with 2 labels → sorted [{id,name}] pairs (ORDER BY l.name)", () => {
    seedLabels();
    reader = createReplicaReader({ dbPath });
    expect(reader.labels("CTL-400")).toEqual([
      { id: "lab-b", name: "type:bug" },
      { id: "lab-a", name: "worker:mini" },
    ]);
  });

  test("issue with zero labels → [] (a defined, authoritative empty answer)", () => {
    seedLabels();
    reader = createReplicaReader({ dbPath });
    expect(reader.labels("CTL-401")).toEqual([]);
  });

  test("unknown identifier → undefined (MISS)", () => {
    seedLabels();
    reader = createReplicaReader({ dbPath });
    expect(reader.labels("CTL-404")).toBeUndefined();
  });

  test("tombstoned issue (removed_at set) → undefined", () => {
    seedLabels();
    reader = createReplicaReader({ dbPath });
    expect(reader.labels("CTL-402")).toBeUndefined();
  });

  test("a tombstoned label attached to a live issue is filtered out of the list", () => {
    seedLabels();
    reader = createReplicaReader({ dbPath });
    // CTL-403 has lab-a (live) + lab-c (tombstoned) attached; only lab-a returns.
    expect(reader.labels("CTL-403")).toEqual([{ id: "lab-a", name: "worker:mini" }]);
  });

  test("STALE .writer.lock (dead writer) → undefined (liveness gate fails)", () => {
    seedLabels();
    writeFileSync(dbPath + ".writer.lock", "");
    backdate(dbPath + ".writer.lock", 10); // present-but-stale lock is authoritative
    reader = createReplicaReader({ dbPath });
    expect(reader.labels("CTL-400")).toBeUndefined();
  });

  test("mid-reseed (cursor row ABSENT) on a fresh DB → undefined (seed gate)", () => {
    seedLabels();
    const db = new Database(dbPath);
    db.run(`DELETE FROM sync_meta WHERE key = 'cursor'`);
    db.close();
    freshen(); // the writer is STILL live; only the seed is incomplete
    reader = createReplicaReader({ dbPath });
    expect(reader.labels("CTL-400")).toBeUndefined();
  });

  test("mid-reseed (cursor present but EMPTY value) → undefined (seed gate)", () => {
    seedLabels();
    const db = new Database(dbPath);
    db.run(`UPDATE sync_meta SET value = '' WHERE key = 'cursor'`);
    db.close();
    freshen();
    reader = createReplicaReader({ dbPath });
    expect(reader.labels("CTL-400")).toBeUndefined();
  });

  test("empty/falsy identifier → undefined without touching the DB", () => {
    reader = createReplicaReader({ dbPath });
    expect(reader.labels("")).toBeUndefined();
    expect(reader.labels(null)).toBeUndefined();
    expect(reader.labels(undefined)).toBeUndefined();
  });
});
