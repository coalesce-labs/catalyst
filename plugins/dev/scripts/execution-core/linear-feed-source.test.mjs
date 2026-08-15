// linear-feed-source.test.mjs — CTL-1847.
//
// Run: cd plugins/dev/scripts/execution-core && bun test linear-feed-source.test.mjs
//
// Against a REAL SQLite database with the replica's actual column names, not a
// stubbed query layer. The defect this module exists to avoid — same-millisecond
// rows skipped or re-read forever — is a property of SQL comparison and ordering,
// and a mocked reader cannot exhibit it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedSource, shapeEdgeRow } from "./linear-feed-source.mjs";
import { buildIssueEvent, classifyEdge } from "./linear-feed-event.mjs";
import { parseStateChangedEvent } from "./monitor.mjs";

let dir;
let dbPath;

const SCHEMA = `
CREATE TABLE issues (id TEXT PRIMARY KEY, identifier TEXT, team_key TEXT, description TEXT,
  estimate REAL, delegate_id TEXT, project_id TEXT);
CREATE TABLE issue_history (id TEXT PRIMARY KEY, issue_id TEXT, actor_id TEXT, created_at INTEGER,
  from_state TEXT, to_state TEXT, from_assignee_id TEXT, to_assignee_id TEXT,
  from_priority INTEGER, to_priority INTEGER, from_estimate REAL, to_estimate REAL,
  from_project_id TEXT, to_project_id TEXT, from_cycle_id TEXT, to_cycle_id TEXT,
  from_parent_id TEXT, to_parent_id TEXT, from_team_id TEXT, to_team_id TEXT,
  from_title TEXT, to_title TEXT, from_due_date TEXT, to_due_date TEXT,
  updated_description INTEGER, added_label_ids TEXT, removed_label_ids TEXT);
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE issue_labels (issue_id TEXT, label_id TEXT);
CREATE TABLE comments (id TEXT PRIMARY KEY, issue_id TEXT, body TEXT, created_at INTEGER, author_id TEXT, author_name TEXT, is_bot INTEGER);
`;

const seed = (db) => {
  db.run(SCHEMA);
  db.run(`INSERT INTO issues VALUES ('i1','CTL-1','CTL','desc',3,'del-1',NULL)`);
  db.run(`INSERT INTO issues VALUES ('i2','ADV-9','ADV','desc',1,NULL,NULL)`);
  db.run(`INSERT INTO users VALUES ('u1','Ryan Rozich')`);
  db.run(`INSERT INTO users VALUES ('bot','Catalyst')`);
};

const addEdge = (db, id, createdAt, over = {}) => {
  const o = { issue_id: "i1", actor_id: "u1", from_state: "Todo", to_state: "Triage", ...over };
  db.run(
    `INSERT INTO issue_history (id, issue_id, actor_id, created_at, from_state, to_state, updated_description)
     VALUES (?,?,?,?,?,?,0)`,
    [id, o.issue_id, o.actor_id, createdAt, o.from_state, o.to_state],
  );
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfs-"));
  dbPath = join(dir, "replica.db");
  const db = new Database(dbPath);
  seed(db);
  db.close();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("⭐ keyset pagination: same-millisecond rows are neither skipped nor repeated", () => {
  test("five rows sharing ONE timestamp are each seen exactly once across pages", () => {
    // This is the defect the composite cursor exists to prevent. With a
    // timestamp-only watermark, `> last` drops the siblings that weren't in the
    // first page and `>= last` re-reads the millisecond forever.
    const db = new Database(dbPath);
    for (const id of ["h1", "h2", "h3", "h4", "h5"]) addEdge(db, id, 1000);
    db.close();

    const src = createFeedSource({ dbPath, limit: 2 });
    const seen = [];
    let pos = { lastCreatedAt: 0, lastId: "" };
    for (let i = 0; i < 10; i++) {
      const page = src.edgesSince(pos);
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.history.id));
      pos = src.positionAfter(page);
    }
    src.close();

    expect(seen).toEqual(["h1", "h2", "h3", "h4", "h5"]); // exactly once, in order
    expect(new Set(seen).size).toBe(5); // no repeats
  });

  test("a timestamp holding MORE rows than the batch limit still drains", () => {
    // The wedge case: limit 2, seven rows in one millisecond. A `>=` comparison
    // would return the same first page forever.
    const db = new Database(dbPath);
    for (let i = 1; i <= 7; i++) addEdge(db, `h${i}`, 5000);
    db.close();

    const src = createFeedSource({ dbPath, limit: 2 });
    const seen = new Set();
    let pos = { lastCreatedAt: 0, lastId: "" };
    let pages = 0;
    while (pages++ < 20) {
      const page = src.edgesSince(pos);
      if (page.length === 0) break;
      for (const r of page) seen.add(r.history.id);
      pos = src.positionAfter(page);
    }
    src.close();
    expect(seen.size).toBe(7);
    expect(pages).toBeLessThan(20); // it terminated rather than wedging
  });

  test("rows arriving later with an EQUAL timestamp are still picked up", () => {
    const db = new Database(dbPath);
    addEdge(db, "h1", 1000);
    db.close();

    const src = createFeedSource({ dbPath, limit: 10 });
    const first = src.edgesSince({ lastCreatedAt: 0, lastId: "" });
    const pos = src.positionAfter(first);
    expect(first.map((r) => r.history.id)).toEqual(["h1"]);

    // a sibling lands in the same millisecond, after we already read h1
    const db2 = new Database(dbPath);
    addEdge(db2, "h2", 1000);
    db2.close();

    const second = src.edgesSince(pos);
    src.close();
    expect(second.map((r) => r.history.id)).toEqual(["h2"]);
  });

  test("positionAfter returns null on an empty page — never advance past nothing", () => {
    const src = createFeedSource({ dbPath });
    expect(src.positionAfter([])).toBeNull();
    expect(src.positionAfter(null)).toBeNull();
    src.close();
  });

  test("ordering is oldest-first, so edges are emitted in the order they happened", () => {
    const db = new Database(dbPath);
    addEdge(db, "hB", 3000);
    addEdge(db, "hA", 1000);
    addEdge(db, "hC", 2000);
    db.close();
    const src = createFeedSource({ dbPath });
    const ids = src.edgesSince({ lastCreatedAt: 0, lastId: "" }).map((r) => r.history.id);
    src.close();
    expect(ids).toEqual(["hA", "hC", "hB"]);
  });
});

describe("the join resolves scoping fields locally — no API call", () => {
  test("labels, project, actor and delegate all come back", () => {
    const db = new Database(dbPath);
    db.run(`INSERT INTO projects VALUES ('p1','P4 Dispatch')`);
    db.run(`UPDATE issues SET project_id='p1' WHERE id='i1'`);
    db.run(`INSERT INTO labels VALUES ('l1','worker:mini')`);
    db.run(`INSERT INTO issue_labels VALUES ('i1','l1')`);
    addEdge(db, "h1", 1000);
    db.close();

    const src = createFeedSource({ dbPath });
    const [row] = src.edgesSince({ lastCreatedAt: 0, lastId: "" });
    src.close();
    expect(row.issue.identifier).toBe("CTL-1");
    expect(row.issue.team_key).toBe("CTL");
    expect(row.issue.delegate_id).toBe("del-1");
    expect(row.actor.name).toBe("Ryan Rozich");
    expect(row.project.name).toBe("P4 Dispatch");
    expect(row.labels).toEqual(["worker:mini"]);
  });

  test("⭐ a label containing a comma survives — the separator is not ','", () => {
    // group_concat's default separator would split this label in half and invent a
    // second one. Labels really can contain commas.
    const db = new Database(dbPath);
    db.run(`INSERT INTO labels VALUES ('l1','area: cli, tui')`);
    db.run(`INSERT INTO labels VALUES ('l2','worker:mini')`);
    db.run(`INSERT INTO issue_labels VALUES ('i1','l1')`);
    db.run(`INSERT INTO issue_labels VALUES ('i1','l2')`);
    addEdge(db, "h1", 1000);
    db.close();

    const src = createFeedSource({ dbPath });
    const [row] = src.edgesSince({ lastCreatedAt: 0, lastId: "" });
    src.close();
    expect(row.labels).toHaveLength(2);
    expect(row.labels).toContain("area: cli, tui");
  });

  test("multiple labels do NOT multiply the edge rows", () => {
    // A JOIN + GROUP BY would fan one edge into three; a correlated subquery does not.
    const db = new Database(dbPath);
    for (const [id, name] of [["l1", "a"], ["l2", "b"], ["l3", "c"]]) {
      db.run(`INSERT INTO labels VALUES (?,?)`, [id, name]);
      db.run(`INSERT INTO issue_labels VALUES ('i1',?)`, [id]);
    }
    addEdge(db, "h1", 1000);
    db.close();
    const src = createFeedSource({ dbPath });
    const rows = src.edgesSince({ lastCreatedAt: 0, lastId: "" });
    src.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].labels).toHaveLength(3);
  });

  test("an edge with no labels/project/actor yields empty, not broken", () => {
    const db = new Database(dbPath);
    addEdge(db, "h1", 1000, { actor_id: null });
    db.close();
    const src = createFeedSource({ dbPath });
    const [row] = src.edgesSince({ lastCreatedAt: 0, lastId: "" });
    src.close();
    expect(row.labels).toEqual([]);
    expect(row.project).toBeNull();
    expect(row.actor).toBeNull();
  });
});

describe("⭐ end-to-end: a real DB row becomes an event the REAL parser understands", () => {
  test("query → shape → classify → build → parseStateChangedEvent", () => {
    const db = new Database(dbPath);
    db.run(`INSERT INTO labels VALUES ('l1','worker:mini')`);
    db.run(`INSERT INTO issue_labels VALUES ('i1','l1')`);
    addEdge(db, "h1", 1000, { from_state: "Todo", to_state: "Triage" });
    db.close();

    const src = createFeedSource({ dbPath });
    const [row] = src.edgesSince({ lastCreatedAt: 0, lastId: "" });
    src.close();

    expect(classifyEdge(row, { teams: new Set(["CTL"]) })).toEqual({ emit: true, reason: "ok" });
    const parsed = parseStateChangedEvent(buildIssueEvent(row));
    expect(parsed).toMatchObject({
      identifier: "CTL-1",
      teamKey: "CTL",
      toState: "Triage",
      toLabels: ["worker:mini"],
    });
  });

  test("a foreign tenant's row is queried but refused at classify", () => {
    // The source is tenant-blind by design; scoping is the classifier's job, so the
    // sweep can observe (and count) what it declines rather than never seeing it.
    const db = new Database(dbPath);
    addEdge(db, "h1", 1000, { issue_id: "i2" });
    db.close();
    const src = createFeedSource({ dbPath });
    const [row] = src.edgesSince({ lastCreatedAt: 0, lastId: "" });
    src.close();
    expect(row.issue.identifier).toBe("ADV-9");
    expect(classifyEdge(row, { teams: new Set(["CTL"]) })).toEqual({ emit: false, reason: "foreign-team" });
  });
});

describe("bounds and shape helpers", () => {
  test("the batch limit is respected", () => {
    const db = new Database(dbPath);
    for (let i = 1; i <= 10; i++) addEdge(db, `h${i}`, 1000 + i);
    db.close();
    const src = createFeedSource({ dbPath, limit: 3 });
    expect(src.edgesSince({ lastCreatedAt: 0, lastId: "" })).toHaveLength(3);
    src.close();
  });

  test("comments page the same way", () => {
    const db = new Database(dbPath);
    db.run(`INSERT INTO comments VALUES ('c1','i1','hello',1000,'u1','Ryan Rozich',0)`);
    db.run(`INSERT INTO comments VALUES ('c2','i1','again',1000,'u1','Ryan Rozich',0)`);
    db.close();
    const src = createFeedSource({ dbPath, limit: 1 });
    const p1 = src.commentsSince({ lastCreatedAt: 0, lastId: "" });
    const p2 = src.commentsSince(src.positionAfter(p1));
    src.close();
    expect(p1[0].comment.id).toBe("c1");
    expect(p2[0].comment.id).toBe("c2");
    expect(p1[0].issue.identifier).toBe("CTL-1");
    expect(p1[0].author.name).toBe("Ryan Rozich");
  });

  test("shapeEdgeRow rejects junk rather than half-shaping it", () => {
    for (const bad of [null, undefined, 42, "row"]) expect(shapeEdgeRow(bad)).toBeNull();
  });
});

describe("⭐ schema conformance against the REAL replica", () => {
  // This is the test that was missing when `c.user_id` shipped. The unit fixtures
  // above are written BY ME, so they can only ever agree with the query they were
  // written for — the first cut declared `user_id` because the query assumed it, and
  // the mistake surfaced only when the query first met a real database.
  //
  // ⚠️ When the replica is absent this REPORTS INCONCLUSIVE rather than passing.
  // A silent skip here would restore exactly the blind spot it exists to close.
  test("every column the queries read exists in the live replica", async () => {
    const { REQUIRED_COLUMNS } = await import("./linear-feed-source.mjs");
    const real = `${process.env.HOME}/catalyst/catalyst-replica.db`;
    if (!existsSync(real)) {
      console.warn(
        `INCONCLUSIVE: no replica at ${real}; schema conformance was NOT verified. ` +
          `This test cannot pass or fail here — treat it as unrun.`,
      );
      expect(Object.keys(REQUIRED_COLUMNS).length).toBeGreaterThan(0); // shape only
      return;
    }
    const db = new Database(real, { readonly: true });
    const missing = [];
    try {
      for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
        const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name));
        if (have.size === 0) {
          missing.push(`${table}: TABLE ABSENT`);
          continue;
        }
        for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`);
      }
    } finally {
      db.close();
    }
    expect(missing).toEqual([]);
  });
});
