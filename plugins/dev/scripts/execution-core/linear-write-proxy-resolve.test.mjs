// linear-write-proxy-resolve.test.mjs — CTL-1889 increment 1.
// Run: cd plugins/dev/scripts/execution-core && bun test linear-write-proxy-resolve.test.mjs
//
// The resolver is the one component here whose DEFAULT must be refusal. Every other
// replica reader in this tree is fail-open by design; on the write path that posture
// would mean "fall through to a direct Linear write under this host's own app-actor",
// which is the thing CTL-1889 exists to remove. So the assertions below are mostly
// NEGATIVE: they prove that a miss, an ambiguity, a malformed row and an unreadable
// database each produce a NAMED refusal rather than a value.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxyResolver } from "./linear-write-proxy-resolve.mjs";

const ISSUE = "24af09c0-b42f-4ba9-a51a-df8866fd668c";
const TEAM = "f317bf00-653d-48d8-8a8b-1656b3534d7a";
const STATE = "75138f5b-9ec9-4e3c-bdf6-d7130ca084b3";
const LABEL = "83e8124b-34bb-4204-988f-7bd0e3e670ab";

let dir;
let dbPath;

/**
 * A replica shaped like the real one — the columns this resolver actually reads, PLUS
 * the two things the freshness gate demands: a live writer heartbeat and a non-empty
 * `sync_meta.cursor`. A fixture without them is not a healthy replica, and every
 * resolution below would (correctly) refuse.
 */
function seed({ issues = true, states = true, labels = true, seeded = true, writerAgeMs = 0 } = {}) {
  const db = new Database(dbPath);
  db.run("CREATE TABLE sync_meta (key TEXT, value TEXT)");
  if (seeded) db.run("INSERT INTO sync_meta VALUES ('cursor','1155205')");
  else db.run("INSERT INTO sync_meta VALUES ('cursor','')"); // mid-reseed: cleared, not absent
  db.run("CREATE TABLE issues (id TEXT, identifier TEXT, team_id TEXT, removed_at INTEGER)");
  db.run("CREATE TABLE workflow_states (id TEXT, team_id TEXT, name TEXT, archived_at INTEGER)");
  db.run("CREATE TABLE labels (id TEXT, name TEXT, removed_at INTEGER)");
  if (issues) {
    db.run("INSERT INTO issues VALUES (?,?,?,NULL)", [ISSUE, "CTL-1889", TEAM]);
    db.run("INSERT INTO issues VALUES (?,?,?,?)", ["dead", "CTL-DEAD", TEAM, 1]);
  }
  if (states) {
    db.run("INSERT INTO workflow_states VALUES (?,?,?,NULL)", [STATE, TEAM, "Implement"]);
    db.run("INSERT INTO workflow_states VALUES (?,?,?,?)", ["old", TEAM, "Retired", 1]);
  }
  if (labels) {
    db.run("INSERT INTO labels VALUES (?,?,NULL)", [LABEL, "needs-human"]);
    // The measured real-world hazard: one NAME, several team-scoped rows.
    db.run("INSERT INTO labels VALUES (?,?,NULL)", ["dup-a", "schema"]);
    db.run("INSERT INTO labels VALUES (?,?,NULL)", ["dup-b", "schema"]);
  }
  db.close();
  writeFileSync(`${dbPath}.writer.lock`, JSON.stringify({ pid: 1, ownerKey: "test" }));
  if (writerAgeMs > 0) {
    const t = (Date.now() - writerAgeMs) / 1000;
    utimesSync(`${dbPath}.writer.lock`, t, t);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctl1889-"));
  dbPath = join(dir, "replica.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the happy path — so the refusals below are not a dead instrument", () => {
  test("identifier → issueId + teamId", () => {
    seed();
    expect(createProxyResolver({ dbPath }).issue("CTL-1889")).toEqual({
      ok: true,
      issueId: ISSUE,
      teamId: TEAM,
    });
  });

  test("(teamId, stateName) → stateId", () => {
    seed();
    expect(createProxyResolver({ dbPath }).stateId(TEAM, "Implement")).toEqual({ ok: true, stateId: STATE });
  });

  test("label names → ids, in the order given", () => {
    seed();
    const db = new Database(dbPath);
    db.run("INSERT INTO labels VALUES (?,?,NULL)", ["second", "blocked"]);
    db.close();
    expect(createProxyResolver({ dbPath }).labelIds(["needs-human", "blocked"])).toEqual({
      ok: true,
      labelIds: [LABEL, "second"],
    });
  });
});

describe("⛔ every failure is NAMED, and none of them is a value", () => {
  test("an unknown ticket is a named miss, not undefined", () => {
    seed();
    expect(createProxyResolver({ dbPath }).issue("CTL-404")).toEqual({
      ok: false,
      reason: "issue-not-in-replica",
    });
  });

  test("a REMOVED issue is a miss — a deleted ticket is not a write target", () => {
    seed();
    expect(createProxyResolver({ dbPath }).issue("CTL-DEAD").ok).toBe(false);
  });

  test("an ARCHIVED workflow state is a miss — it cannot be transitioned to", () => {
    seed();
    expect(createProxyResolver({ dbPath }).stateId(TEAM, "Retired")).toEqual({
      ok: false,
      reason: "state-not-in-replica",
    });
  });

  test("a state name from ANOTHER team does not resolve (resolution is team-scoped)", () => {
    seed();
    expect(createProxyResolver({ dbPath }).stateId("some-other-team", "Implement").ok).toBe(false);
  });

  test("⭐ an AMBIGUOUS label name REFUSES — it is never resolved to a first hit", () => {
    seed();
    const r = createProxyResolver({ dbPath }).labelIds(["schema"]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("label-ambiguous");
    // The name is carried so an operator reading the log knows WHICH label was refused.
    expect(r.detail).toBe("schema");
  });

  test("⭐ a batch is ALL-OR-NOTHING: one bad name refuses the whole write", () => {
    seed();
    // A partial batch would apply some labels and silently drop the rest, which reads
    // as success at every call site — the exact silent-partial-failure this refuses.
    expect(createProxyResolver({ dbPath }).labelIds(["needs-human", "nope"])).toMatchObject({
      ok: false,
      reason: "label-not-in-replica",
    });
  });

  test("an ABSENT database is a named refusal, never an empty success", () => {
    // No database means no writer lock either, so the liveness half refuses first. The
    // point of the assertion is that it REFUSES and says why — not which half caught it.
    const r = createProxyResolver({ dbPath: join(dir, "does-not-exist.db") }).issue("CTL-1889");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("replica-stale");
  });

  test("a CORRUPT database is a named refusal", () => {
    seed();
    writeFileSync(dbPath, "this is not a sqlite file"); // keep the lock; break the file
    expect(createProxyResolver({ dbPath }).issue("CTL-1889")).toMatchObject({
      ok: false,
      reason: "replica-unreadable",
    });
  });

  test("a database MISSING the table is a named refusal, not a zero-row 'miss'", () => {
    // A schema-less replica is the CTL-1919 shape: the writer had never created
    // workflow_states on that host for five hours. "No such table" must not read as
    // "no such state" — both refuse, but only one of them is about the ticket.
    seed({ states: false });
    const db = new Database(dbPath);
    db.run("DROP TABLE workflow_states");
    db.close();
    expect(createProxyResolver({ dbPath }).stateId(TEAM, "Implement")).toMatchObject({
      ok: false,
      reason: "replica-unreadable",
    });
  });

  test("a row with a NULL id refuses rather than emitting a null into the payload", () => {
    seed({ issues: false });
    const db = new Database(dbPath);
    db.run("INSERT INTO issues VALUES (NULL,?,?,NULL)", ["CTL-NULL", TEAM]);
    db.close();
    expect(createProxyResolver({ dbPath }).issue("CTL-NULL")).toEqual({
      ok: false,
      reason: "issue-id-missing",
    });
  });

  test("a row with no team_id refuses — state resolution would silently mis-scope", () => {
    seed({ issues: false });
    const db = new Database(dbPath);
    db.run("INSERT INTO issues VALUES (?,?,NULL,NULL)", ["x", "CTL-NOTEAM"]);
    db.close();
    expect(createProxyResolver({ dbPath }).issue("CTL-NOTEAM")).toEqual({
      ok: false,
      reason: "issue-team-missing",
    });
  });

  test.each([
    ["", "issue-identifier-invalid"],
    ["   ", "issue-identifier-invalid"],
    [null, "issue-identifier-invalid"],
    [undefined, "issue-identifier-invalid"],
    [42, "issue-identifier-invalid"],
  ])("a junk identifier (%p) refuses by name", (input, reason) => {
    seed();
    expect(createProxyResolver({ dbPath }).issue(input)).toEqual({ ok: false, reason });
  });

  test.each([[[]], [null], ["needs-human"], [undefined]])(
    "a non-array / empty label list (%p) refuses rather than sending an empty batch",
    (input) => {
      seed();
      expect(createProxyResolver({ dbPath }).labelIds(input)).toEqual({
        ok: false,
        reason: "label-names-empty",
      });
    },
  );
});

describe("⛔ the freshness gate (Codex P1 on #3489) — an ungated read is a stale read", () => {
  test("a DEAD writer refuses, even though every row still looks perfectly healthy", () => {
    // The whole hazard: the rows are fine. Nothing about the data says the writer died
    // ten hours ago, which is why the heartbeat has to be consulted rather than the rows.
    seed({ writerAgeMs: 10 * 60 * 1000 });
    expect(createProxyResolver({ dbPath }).issue("CTL-1889")).toEqual({
      ok: false,
      reason: "replica-stale",
    });
  });

  test("NEGATIVE CONTROL: the same rows resolve when the heartbeat is fresh", () => {
    seed({ writerAgeMs: 10 * 60 * 1000 });
    expect(createProxyResolver({ dbPath }).issue("CTL-1889").ok).toBe(false);
    // Touch ONLY the heartbeat — not one row changes. That is what makes this a control
    // for the gate rather than a second test of the query.
    const t = Date.now() / 1000;
    utimesSync(`${dbPath}.writer.lock`, t, t);
    expect(createProxyResolver({ dbPath }).issue("CTL-1889").ok).toBe(true);
  });

  test("the staleness ceiling honours CATALYST_LINEAR_REPLICA_STALE_MS", () => {
    seed({ writerAgeMs: 10 * 60 * 1000 });
    const r = createProxyResolver({ dbPath, env: { CATALYST_LINEAR_REPLICA_STALE_MS: "3600000" } });
    expect(r.issue("CTL-1889").ok).toBe(true);
  });

  test("a MID-RESEED replica (cursor cleared) refuses — named apart from stale/unreadable", () => {
    seed({ seeded: false });
    expect(createProxyResolver({ dbPath }).issue("CTL-1889")).toEqual({
      ok: false,
      reason: "replica-reseeding",
    });
  });

  test("⭐ THE HAZARD ITSELF: a half-restored duplicate must not resolve as unique", () => {
    // `schema` really has several team-scoped rows. Mid-reseed only one may be back, so
    // the ambiguity guard — which is a row COUNT — would see 1 and hand out a UUID that
    // belongs to whichever team happened to restore first. The seed gate is what stops
    // that being a silently wrong write rather than a refusal.
    seed({ seeded: false, labels: false });
    const db = new Database(dbPath);
    db.run("INSERT INTO labels VALUES (?,?,NULL)", ["dup-a", "schema"]); // only ONE copy back
    db.close();
    expect(createProxyResolver({ dbPath }).labelIds(["schema"])).toMatchObject({
      ok: false,
      reason: "replica-reseeding",
    });
  });

  test("NEGATIVE CONTROL: with the seed complete, that same single row DOES resolve", () => {
    // Proving the refusal above came from the gate and not from the row shape — once the
    // cursor is set, one row is a legitimate unique match.
    seed({ labels: false });
    const db = new Database(dbPath);
    db.run("INSERT INTO labels VALUES (?,?,NULL)", ["dup-a", "schema"]);
    db.close();
    expect(createProxyResolver({ dbPath }).labelIds(["schema"])).toEqual({
      ok: true,
      labelIds: ["dup-a"],
    });
  });
});

describe("handle discipline", () => {
  test("a resolver recovers after the database is replaced underneath it", () => {
    // The replica writer re-seeds and migrates this file while the daemon holds it
    // open, so a thrown read must DROP the handle rather than poison every later call.
    seed();
    writeFileSync(dbPath, "garbage");
    const r = createProxyResolver({ dbPath });
    expect(r.issue("CTL-1889").ok).toBe(false);
    rmSync(dbPath);
    seed();
    expect(r.issue("CTL-1889")).toEqual({ ok: true, issueId: ISSUE, teamId: TEAM });
  });
});
