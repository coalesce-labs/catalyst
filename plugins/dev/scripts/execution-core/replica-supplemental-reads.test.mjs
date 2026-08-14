// replica-supplemental-reads.test.mjs — CTL-1806. The three new replica reads
// that let the orch-monitor's supplemental resolvers stop calling the
// rate-limited Linear API: estimates(), relations(), details(), plus the
// timestamp-based state.type synthesis they depend on.
//
// Built with REAL bun:sqlite over a real schema fixture (same discipline as
// replica-read.test.mjs) so the actual SQL is exercised, not a mock of it.
//
// Run: bun test plugins/dev/scripts/execution-core/replica-supplemental-reads.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createReplicaReader, synthesizeStateType } from "./replica-read.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let tmpDir;
let dbPath;
let reader;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "replica-supplemental-"));
  dbPath = join(tmpDir, "catalyst-replica.db");
});

afterEach(() => {
  reader?.close();
  reader = null;
  rmSync(tmpDir, { recursive: true, force: true });
});

// seed — the real cloud-schema columns these reads touch.
function seed() {
  const db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE issues (
    id TEXT PRIMARY KEY, identifier TEXT, title TEXT, description TEXT,
    state TEXT, priority INTEGER, estimate REAL, project_id TEXT,
    started_at INTEGER, completed_at INTEGER, canceled_at INTEGER,
    removed_at INTEGER
  )`);
  db.run(`CREATE INDEX idx_issues_identifier ON issues (identifier)`);
  db.run(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT)`);
  db.run(`CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT, color TEXT, removed_at INTEGER)`);
  db.run(`CREATE TABLE issue_labels (issue_id TEXT, label_id TEXT)`);
  db.run(
    `CREATE TABLE relations (id TEXT PRIMARY KEY, type TEXT, issue_identifier TEXT, related_identifier TEXT)`
  );

  db.run(`INSERT INTO projects VALUES ('p1', 'Fleet Hardening')`);
  db.run(`INSERT INTO labels VALUES ('l1','needs-human','#ff0000',NULL)`);
  db.run(`INSERT INTO labels VALUES ('l2','no-colour',NULL,NULL)`);
  db.run(`INSERT INTO labels VALUES ('l3','tombstoned','#00ff00',1700)`);
  // A label whose NAME is NULL — the degenerate row details()' label-name type
  // guard exists for. Attached only to CTL-13 so it cannot perturb the exact
  // label assertions on CTL-1.
  db.run(`INSERT INTO labels VALUES ('l4',NULL,'#123456',NULL)`);

  // CTL-1 — the full-payload row: started, has everything.
  db.run(
    `INSERT INTO issues VALUES ('i1','CTL-1','Real title','## Body','Implement',2,5,'p1',1000,NULL,NULL,NULL)`
  );
  db.run(`INSERT INTO issue_labels VALUES ('i1','l1')`);
  db.run(`INSERT INTO issue_labels VALUES ('i1','l2')`);
  db.run(`INSERT INTO issue_labels VALUES ('i1','l3')`); // tombstoned → excluded
  // CTL-2 — completed AND started (the 2215-row overlap: completed must win).
  db.run(
    `INSERT INTO issues VALUES ('i2','CTL-2','Done ticket',NULL,'Done',NULL,3,NULL,1000,2000,NULL,NULL)`
  );
  // CTL-3 — NULL estimate: a MISS for estimates(), a HIT for details().
  db.run(
    `INSERT INTO issues VALUES ('i3','CTL-3','No estimate',NULL,'Backlog',0,NULL,NULL,NULL,NULL,NULL,NULL)`
  );
  // CTL-4 — tombstoned: a MISS for every read.
  db.run(
    `INSERT INTO issues VALUES ('i4','CTL-4','Removed',NULL,'Todo',1,8,NULL,NULL,NULL,NULL,1700)`
  );
  // CTL-5 — empty title: a MISS for details() (cannot populate the detail page).
  db.run(`INSERT INTO issues VALUES ('i5','CTL-5','',NULL,'Todo',NULL,13,NULL,NULL,NULL,NULL,NULL)`);
  // CTL-6 — canceled AND completed (canceled must win).
  db.run(
    `INSERT INTO issues VALUES ('i6','CTL-6','Cancelled',NULL,'Canceled',NULL,1,NULL,1000,2000,3000,NULL)`
  );
  // CTL-7 — NULL state name: details() must report state null, never fabricate a
  // name from the synthesized type.
  db.run(`INSERT INTO issues VALUES ('i7','CTL-7','No state name',NULL,NULL,NULL,2,NULL,NULL,NULL,NULL,NULL)`);
  // CTL-8 — a second `related` peer, reached FORWARD, to pin the pass order.
  db.run(`INSERT INTO issues VALUES ('i8','CTL-8','Forward related',NULL,'Todo',NULL,1,NULL,NULL,NULL,NULL,NULL)`);
  // CTL-9 — a `related` peer reached only INVERSELY.
  db.run(`INSERT INTO issues VALUES ('i9','CTL-9','Inverse related',NULL,'Todo',NULL,1,NULL,NULL,NULL,NULL,NULL)`);

  // ── Degenerate-cell rows. Every one of these is written as a REAL SQLite
  // literal rather than faked at the JS layer: the point of each guard is what
  // the driver actually hands back from a column of that affinity, and a value
  // injected past the driver would prove nothing about the read.
  //
  // CTL-10 — an EMPTY-STRING state name. `state` is TEXT affinity, so '' stays
  // ''. The row is started, so a fabricated ref would carry a real-looking type.
  db.run(
    `INSERT INTO issues VALUES ('i10','CTL-10','Empty state name',NULL,'',NULL,1,NULL,1000,NULL,NULL,NULL)`
  );
  // CTL-11 — a NON-FINITE estimate. 9e999 overflows REAL and comes back as a JS
  // number whose Number.isFinite is false (i.e. Infinity) — verified against this
  // driver, not assumed.
  db.run(
    `INSERT INTO issues VALUES ('i11','CTL-11','Non-finite estimate',NULL,'Todo',NULL,9e999,NULL,NULL,NULL,NULL,NULL)`
  );
  // CTL-12 — a NON-NUMERIC STRING in the REAL estimate column. REAL affinity
  // only converts text that is losslessly convertible, so this is stored — and
  // returned — as a JS string.
  db.run(
    `INSERT INTO issues VALUES ('i12','CTL-12','String estimate',NULL,'Todo',NULL,'not a number',NULL,NULL,NULL,NULL,NULL)`
  );
  // CTL-13 — carries the NULL-named label l4 alongside a well-formed one.
  db.run(
    `INSERT INTO issues VALUES ('i13','CTL-13','Null label name',NULL,'Todo',NULL,NULL,NULL,NULL,NULL,NULL,NULL)`
  );
  db.run(`INSERT INTO issue_labels VALUES ('i13','l1')`);
  db.run(`INSERT INTO issue_labels VALUES ('i13','l4')`); // NULL name → must be dropped
  // CTL-14 — an EMPTY-STRING description on an otherwise valid detail HIT.
  db.run(
    `INSERT INTO issues VALUES ('i14','CTL-14','Empty description','','Todo',NULL,NULL,NULL,NULL,NULL,NULL,NULL)`
  );
  // CTL-15 — blocks CTL-5, whose title is ''. CTL-5 is thus reachable as a
  // relation TARGET, which is the only way the target-title normalize is
  // exercised (details() rejects an empty title before it ever gets there).
  db.run(
    `INSERT INTO issues VALUES ('i15','CTL-15','Blocks an untitled ticket',NULL,'Todo',NULL,NULL,NULL,NULL,NULL,NULL,NULL)`
  );

  // Relations on CTL-1: forward blocks/duplicate/related, inverse blocks/related.
  db.run(`INSERT INTO relations VALUES ('r1','blocks','CTL-1','CTL-2')`);
  db.run(`INSERT INTO relations VALUES ('r2','duplicate','CTL-1','CTL-3')`);
  db.run(`INSERT INTO relations VALUES ('r3','related','CTL-1','CTL-6')`);
  db.run(`INSERT INTO relations VALUES ('r4','blocks','CTL-6','CTL-1')`); // inverse → blockedBy
  db.run(`INSERT INTO relations VALUES ('r5','related','CTL-6','CTL-1')`); // inverse related, dup of r3
  db.run(`INSERT INTO relations VALUES ('r6','blocks','CTL-1','CTL-999')`); // dangling target
  // Order fixture: CTL-8 is related FORWARD from CTL-1; CTL-9 is related to CTL-1
  // only INVERSELY. The GraphQL parser walks forward edges first, so CTL-8 must
  // precede CTL-9 in `related`.
  db.run(`INSERT INTO relations VALUES ('r7','related','CTL-1','CTL-8')`);
  db.run(`INSERT INTO relations VALUES ('r8','related','CTL-9','CTL-1')`);
  // Edge onto the empty-titled CTL-5. Sourced from CTL-15 (not CTL-1) so the
  // relation-grouping and pass-order assertions above stay untouched.
  db.run(`INSERT INTO relations VALUES ('r9','blocks','CTL-15','CTL-5')`);
  db.close();
}

describe("estimates() — CTL-1806", () => {
  test("HIT: a finite estimate is returned", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.estimates(["CTL-1"])).toEqual({ "CTL-1": 5 });
  });

  test("a NULL estimate is a MISS (omitted), NEVER an authoritative null", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    const out = reader.estimates(["CTL-3"]);
    // The distinction that matters: `undefined` (absent key) makes the caller
    // fall through; a present `null` would make it serve "no estimate" and drop
    // the board chip for a refresh.
    expect(Object.hasOwn(out, "CTL-3")).toBe(false);
    expect(out).toEqual({});
  });

  test("a tombstoned row is a MISS", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.estimates(["CTL-4"])).toEqual({});
  });

  test("mixed batch returns only the hits", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.estimates(["CTL-1", "CTL-2", "CTL-3", "CTL-4", "CTL-404"])).toEqual({
      "CTL-1": 5,
      "CTL-2": 3,
    });
  });

  test("a NON-FINITE estimate is a MISS (omitted), never served as Infinity", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    // 9e999 overflows SQLite's REAL and the driver hands back a JS number whose
    // Number.isFinite is false. Serving it would put Infinity on the board's
    // estimate chip and into any arithmetic downstream of it; the caller must
    // instead fall through, exactly as for a NULL estimate.
    const out = reader.estimates(["CTL-11"]);
    expect(Object.hasOwn(out, "CTL-11")).toBe(false);
    expect(out).toEqual({});
  });

  test("a NON-NUMERIC STRING estimate is a MISS (omitted), never served as text", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    // REAL affinity converts text only when it is losslessly convertible, so
    // 'not a number' really is stored and returned as a JS string — the board
    // must never receive a string where it expects a point estimate.
    //
    // Mutation note: numOrNull's `typeof v === "number"` conjunct is on its own
    // an EQUIVALENT mutant — Number.isFinite returns true only for number
    // primitives, so deleting the typeof test cannot change any answer. What
    // this case does kill is removal of the guard as a whole, which the
    // non-finite case above cannot distinguish from a bare typeof check.
    const out = reader.estimates(["CTL-12"]);
    expect(Object.hasOwn(out, "CTL-12")).toBe(false);
    expect(out).toEqual({});
  });

  test("empty / non-array input → {}", () => {
    // Scope note: this asserts ONLY the return value. The original name also
    // claimed "without opening the db", which the body never checked and cannot
    // check — createReplicaReader constructs its Database inline with no
    // injectable opener, and on an absent path the open throws and is caught,
    // yielding the identical {}. Dropping the early return is therefore an
    // equivalent mutant here, and adding a production seam purely to observe it
    // is not worth the surface. A test name must not claim a property its body
    // does not verify.
    reader = createReplicaReader({ dbPath: join(tmpDir, "absent.db") });
    expect(reader.estimates([])).toEqual({});
    expect(reader.estimates(null)).toEqual({});
  });

  test("absent db → {} (fail-open, never throws)", () => {
    reader = createReplicaReader({ dbPath: join(tmpDir, "absent.db") });
    expect(reader.estimates(["CTL-1"])).toEqual({});
  });

  test("chunks past the SQLite bound-parameter ceiling (600 ids in one call)", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    // 999 is SQLite's ceiling; an unchunked IN() of 600 would still fit, so use
    // 1200 to force >2 chunks and prove the loop, not the ceiling.
    const ids = Array.from({ length: 1200 }, (_, i) => `CTL-${9000 + i}`);
    ids.push("CTL-1");
    expect(reader.estimates(ids)).toEqual({ "CTL-1": 5 });
  });
});

describe("relations() — CTL-1806", () => {
  test("groups forward/inverse edges exactly as the GraphQL parser does", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    const rel = reader.relations(["CTL-1"])["CTL-1"];
    expect(rel.blocks.map((t) => t.identifier).sort()).toEqual(["CTL-2", "CTL-999"]);
    expect(rel.duplicateOf.map((t) => t.identifier)).toEqual(["CTL-3"]);
    expect(rel.blockedBy.map((t) => t.identifier)).toEqual(["CTL-6"]);
    // r3 (forward) and r5 (inverse) name the same peer → deduped to one entry.
    // Order is load-bearing: forward edges are walked first (matching the GraphQL
    // parser), and the rail renders only the first 5 with a "show N more", so a
    // flipped pass order silently changes WHICH relations a reader sees.
    expect(rel.related.map((t) => t.identifier)).toEqual(["CTL-6", "CTL-8", "CTL-9"]);
  });

  test("enriches each target with title/state/priority/project", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    const rel = reader.relations(["CTL-1"])["CTL-1"];
    const target = rel.blocks.find((t) => t.identifier === "CTL-2");
    expect(target).toEqual({
      identifier: "CTL-2",
      title: "Done ticket",
      state: { name: "Done", type: "completed" },
      priority: null,
      project: null,
    });
  });

  test("a target with no live issues row KEEPS its edge with null fields", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    const rel = reader.relations(["CTL-1"])["CTL-1"];
    // Dropping it would silently hide a genuine blocker; the rail renders
    // `title ?? identifier`, so the bare identifier is still real information.
    expect(rel.blocks.find((t) => t.identifier === "CTL-999")).toEqual({
      identifier: "CTL-999",
      title: null,
      state: null,
      priority: null,
      project: null,
    });
  });

  test("a target whose title is EMPTY normalizes to null, so the rail renders its id", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    const rel = reader.relations(["CTL-15"])["CTL-15"];
    // The rail renders `title ?? identifier`. An empty string is not null, so it
    // wins that coalesce and the row draws BLANK — a genuine blocker rendered as
    // an empty line instead of "CTL-5". Normalizing to null is what restores the
    // identifier fallback.
    expect(rel.blocks).toEqual([
      {
        identifier: "CTL-5",
        title: null,
        state: { name: "Todo", type: "backlog" },
        priority: null,
        project: null,
      },
    ]);
  });

  test("an id with no edges is OMITTED (a miss, not an empty map)", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.relations(["CTL-3"])).toEqual({});
  });

  test("absent db → {} (fail-open)", () => {
    reader = createReplicaReader({ dbPath: join(tmpDir, "absent.db") });
    expect(reader.relations(["CTL-1"])).toEqual({});
  });
});

describe("details() — CTL-1806", () => {
  test("HIT returns the whole detail payload", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    const d = reader.details(["CTL-1"])["CTL-1"];
    expect(d.title).toBe("Real title");
    expect(d.description).toBe("## Body");
    expect(d.state).toEqual({ name: "Implement", type: "started" });
    expect(d.priority).toBe(2);
    expect(d.estimate).toBe(5);
    expect(d.project).toBe("Fleet Hardening");
  });

  test("labels carry colour, default a colourless one, and exclude tombstones", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    const d = reader.details(["CTL-1"])["CTL-1"];
    expect(d.labels).toEqual([
      // ORDER BY l.name
      { name: "needs-human", color: "#ff0000" },
      // matches the GraphQL parser's default so a colourless replica label
      // renders identically to a colourless Linear one
      { name: "no-colour", color: "#8d8d8d" },
    ]);
    expect(d.labels.some((l) => l.name === "tombstoned")).toBe(false);
  });

  test("relations are attached, and an edge-less hit gets an EMPTY map not null", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    const withEdges = reader.details(["CTL-1"])["CTL-1"];
    expect(withEdges.relations.duplicateOf.map((t) => t.identifier)).toEqual(["CTL-3"]);
    const withoutEdges = reader.details(["CTL-3"])["CTL-3"];
    // We READ the relation table for it and it genuinely has none — that is an
    // empty answer, not "unknown".
    expect(withoutEdges.relations).toEqual({
      blockedBy: [],
      blocks: [],
      related: [],
      duplicateOf: [],
    });
  });

  test("an EMPTY title is a MISS — a hollow entry would suppress the Linear fall-through", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.details(["CTL-5"])).toEqual({});
  });

  test("a NULL estimate on a detail HIT stays null (the row IS served)", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    // Unlike estimates(), details() is not an estimate lookup — the ticket is a
    // genuine hit and its absent estimate is an honest null on a served payload.
    expect(reader.details(["CTL-3"])["CTL-3"].estimate).toBe(null);
  });

  test("a tombstoned row is a MISS", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    expect(reader.details(["CTL-4"])).toEqual({});
  });

  test("a NULL state name yields state:null — a name is never fabricated", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    // The synthesized `type` is always derivable from timestamps, but the NAME
    // is not. Emitting {name:null,type:"backlog"} would invent a workflow state
    // that does not exist in the workspace and break the LinearStateRef contract.
    expect(reader.details(["CTL-7"])["CTL-7"].state).toBe(null);
  });

  test("an EMPTY state name yields state:null — an empty ref is never fabricated", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    // Distinct from the NULL-state case above: '' IS a string, so only the
    // length check stands between the row and a {name:"", type:"started"} ref.
    // That ref satisfies LinearStateRef structurally while naming a workflow
    // state that does not exist, so the consumer renders a nameless chip with a
    // confident icon instead of falling through.
    expect(reader.details(["CTL-10"])["CTL-10"].state).toBe(null);
  });

  test("an EMPTY description normalizes to null, not the empty string", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    const d = reader.details(["CTL-14"])["CTL-14"];
    expect(d.title).toBe("Empty description"); // the row IS served
    // The detail page's availability check is `title !== null || description
    // !== null`, and callers coalesce on null. An empty string reads as present
    // content, so the page renders an empty body instead of falling through.
    expect(d.description).toBe(null);
  });

  test("a label whose NAME is NULL is DROPPED, never pushed as {name:null}", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    const d = reader.details(["CTL-13"])["CTL-13"];
    // ORDER BY l.name puts a NULL name FIRST in SQLite, so an ungated push
    // would lead the chip row with a nameless label.
    expect(d.labels).toEqual([{ name: "needs-human", color: "#ff0000" }]);
    expect(d.labels.every((l) => typeof l.name === "string" && l.name.length > 0)).toBe(true);
    expect(d.labels.length).toBe(1); // fail closed: an emptied list is not a pass
  });

  test("a NON-FINITE estimate on a detail HIT is null, never Infinity", () => {
    seed();
    reader = createReplicaReader({ dbPath });
    const d = reader.details(["CTL-11"])["CTL-11"];
    expect(d.title).toBe("Non-finite estimate"); // the row IS served
    expect(d.estimate).toBe(null);
  });

  test("absent db → {} (fail-open)", () => {
    reader = createReplicaReader({ dbPath: join(tmpDir, "absent.db") });
    expect(reader.details(["CTL-1"])).toEqual({});
  });
});

describe("synthesizeStateType() — CTL-1806 D2, ladder order", () => {
  test("canceled_at wins over completed_at AND started_at", () => {
    expect(synthesizeStateType({ started_at: 1, completed_at: 2, canceled_at: 3 })).toBe("canceled");
  });
  test("completed_at wins over started_at (the 2215-row overlap)", () => {
    expect(synthesizeStateType({ started_at: 1, completed_at: 2, canceled_at: null })).toBe(
      "completed"
    );
  });
  test("started_at alone → started", () => {
    expect(synthesizeStateType({ started_at: 1, completed_at: null, canceled_at: null })).toBe(
      "started"
    );
  });
  test("no timestamps → backlog", () => {
    expect(synthesizeStateType({ started_at: null, completed_at: null, canceled_at: null })).toBe(
      "backlog"
    );
  });
  test("canceled_at wins over completed_at with no started_at", () => {
    // Exercised by ZERO rows in the live replica (no row sets both without a
    // start), so it is asserted here synthetically rather than left untested:
    // Linear can stamp completedAt and then cancel.
    expect(synthesizeStateType({ started_at: null, completed_at: 2, canceled_at: 3 })).toBe(
      "canceled"
    );
  });
  test("a non-object is null, never a fabricated category", () => {
    expect(synthesizeStateType(null)).toBe(null);
    expect(synthesizeStateType(undefined)).toBe(null);
    expect(synthesizeStateType("Done")).toBe(null);
  });
});

describe("synthesizeStateType() — CTL-1806 D2 GROUND-TRUTH ACCURACY", () => {
  const fixture = JSON.parse(
    readFileSync(join(HERE, "__fixtures__", "state-type-ground-truth.json"), "utf8")
  );
  const rows = fixture.rows;

  // ── Fail-closed guards on the fixture itself ──────────────────────────────
  // Without these, an emptied or truncated fixture makes the accuracy loop below
  // iterate zero times and PASS — the classic `[].every(p) === true` false clean.
  // These assertions are the positive control for the accuracy assertion.
  test("the fixture is non-degenerate (guards the accuracy check below)", () => {
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(50);
    const classes = new Set(rows.map((r) => r.groundTruthType));
    // Every class the synthesis can produce must be represented, or the accuracy
    // figure is measuring less than it claims to.
    for (const c of ["backlog", "completed", "canceled", "started"]) {
      expect(classes.has(c)).toBe(true);
    }
    // At least one row must carry each timestamp, or the ladder rungs are untested.
    expect(rows.some((r) => r.canceled_at != null)).toBe(true);
    expect(rows.some((r) => r.completed_at != null)).toBe(true);
    expect(rows.some((r) => r.started_at != null)).toBe(true);
  });

  test("EXACT on every class the consumer renders distinctly", () => {
    const misses = [];
    for (const r of rows) {
      const got = synthesizeStateType(r);
      if (got !== r.groundTruthType) {
        misses.push({ identifier: r.identifier, truth: r.groundTruthType, got, name: r.stateName });
      }
    }
    // The ONLY tolerated residual is a true `unstarted` collapsing to `backlog`:
    // stateIconSpec draws both as a MUTED ring differing only in stroke dash, so
    // it is a dash pattern and nothing else. Any OTHER miss is a real defect —
    // notably a completed/canceled miss, which would also flip the 24h cache TTL.
    for (const m of misses) {
      expect({ identifier: m.identifier, truth: m.truth, got: m.got }).toEqual({
        identifier: m.identifier,
        truth: "unstarted",
        got: "backlog",
      });
    }
    const distinct = rows.filter((r) => r.groundTruthType !== "unstarted");
    expect(distinct.length).toBeGreaterThan(0); // fail closed, not vacuously exact
    expect(misses.filter((m) => m.truth !== "unstarted").length).toBe(0);
  });

  test("EXACT on the terminal predicate that picks the 24h vs 5min cache TTL", () => {
    // linear-title-description-fallback's ttlForState keys on
    // type === "completed" || "canceled". A miss here is a quota regression
    // inside a quota-reduction change, so it is asserted separately.
    let compared = 0;
    for (const r of rows) {
      const truthTerminal = r.groundTruthType === "completed" || r.groundTruthType === "canceled";
      const got = synthesizeStateType(r);
      const synthTerminal = got === "completed" || got === "canceled";
      expect(synthTerminal).toBe(truthTerminal);
      compared++;
    }
    expect(compared).toBe(rows.length);
    expect(compared).toBeGreaterThan(0); // a zero-comparison pass is not a pass
  });
});

describe("linear-estimation-method — CTL-1806 D1: the degraded fetch is LABELLED", () => {
  // getEstimationMethod's fetch is a synchronous `curl` spawn. These cases point
  // PATH at an empty directory so curl cannot be found: spawnSync returns a
  // non-zero/absent status and the function fails open to null — with NO network
  // traffic — while the D3 emission, which is taken BEFORE the spawn, has already
  // been written. That ordering is the point: an emission placed after the call
  // is lost on exactly the failures worth knowing about.
  function isolated(fn) {
    const home = mkdtempSync(join(tmpdir(), "ctl1806-est-home-"));
    const dir = mkdtempSync(join(tmpdir(), "ctl1806-est-events-"));
    const emptyBin = mkdtempSync(join(tmpdir(), "ctl1806-est-bin-"));
    const prev = {
      HOME: process.env.HOME,
      CATALYST_DIR: process.env.CATALYST_DIR,
      PATH: process.env.PATH,
      TOKEN: process.env.LINEAR_API_TOKEN,
      KEY: process.env.LINEAR_API_KEY,
    };
    process.env.HOME = home;
    process.env.CATALYST_DIR = dir;
    process.env.PATH = emptyBin; // no curl → no outbound call, ever
    try {
      return fn({ dir });
    } finally {
      for (const [k, v] of Object.entries({
        HOME: prev.HOME,
        CATALYST_DIR: prev.CATALYST_DIR,
        PATH: prev.PATH,
        LINEAR_API_TOKEN: prev.TOKEN,
        LINEAR_API_KEY: prev.KEY,
      })) {
        if (v !== undefined) process.env[k] = v;
        else delete process.env[k];
      }
      for (const d of [home, dir, emptyBin]) rmSync(d, { recursive: true, force: true });
    }
  }

  function readEvents(dir) {
    const now = new Date();
    const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const p = join(dir, "events", `${ym}.jsonl`);
    let raw;
    try {
      raw = readFileSync(p, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e?.attributes?.["event.name"] === "catalyst.linear.read");
  }

  test("a cold cache emits catalyst.linear.read source=linearis op=team_method", async () => {
    const { getEstimationMethod, _resetMemoForTests } = await import("./linear-estimation-method.mjs");
    isolated(({ dir }) => {
      _resetMemoForTests();
      process.env.LINEAR_API_TOKEN = "lin_api_test_token";
      const m = getEstimationMethod("QQQ");
      expect(m).toBe(null); // curl unavailable → fail-open, never a guessed scale
      const events = readEvents(dir);
      expect(events.length).toBe(1);
      const a = events[0].attributes;
      // "linearis", NOT "linearis_miss": no replica was consulted, because the
      // replica has no teams table and carries no issueEstimation at all.
      expect(a["linear.read.source"]).toBe("linearis");
      expect(a["linear.read.op"]).toBe("team_method");
      expect(a["event.label"]).toBe("QQQ");
      expect(events[0].resource["service.name"]).toBe("catalyst.execution-core");
      _resetMemoForTests();
    });
  });

  test("no credential → result=failed (WARN), so a silently-null node is visible", async () => {
    const { getEstimationMethod, _resetMemoForTests } = await import("./linear-estimation-method.mjs");
    isolated(({ dir }) => {
      _resetMemoForTests();
      delete process.env.LINEAR_API_TOKEN;
      delete process.env.LINEAR_API_KEY;
      expect(getEstimationMethod("RRR")).toBe(null);
      const events = readEvents(dir);
      expect(events.length).toBe(1);
      expect(events[0].attributes["linear.read.result"]).toBe("failed");
      expect(events[0].severityText).toBe("WARN");
      _resetMemoForTests();
    });
  });

  test("ONE TTL: a warm shared cache emits NOTHING and never reaches the fetch", async () => {
    const { getEstimationMethod, writeTeamEstimationCache, _resetMemoForTests } = await import(
      "./linear-estimation-method.mjs"
    );
    isolated(({ dir }) => {
      _resetMemoForTests();
      writeTeamEstimationCache("SSS", { type: "tShirt", allowZero: true, extended: false });
      _resetMemoForTests(); // force the on-DISK read, not the memo
      const m = getEstimationMethod("SSS");
      expect(m?.type).toBe("tShirt");
      // A warm cache must produce no degraded read at all — that is the whole
      // bound D1 relies on (8 team keys per host per TTL window).
      expect(readEvents(dir).length).toBe(0);
      _resetMemoForTests();
    });
  });
});
