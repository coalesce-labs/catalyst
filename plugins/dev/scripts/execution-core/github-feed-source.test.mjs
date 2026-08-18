// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-source.test.mjs
//
// The keyset tests build a REAL SQLite database with the replica's actual DDL,
// because the defect they exist to catch — same-millisecond siblings dropped by `>`
// or re-read forever by `>=` — is a property of SQL comparison and ordering. A
// mocked reader cannot exhibit it, so a mocked test would pass against a broken
// query. Same reasoning as `linear-feed-source.test.mjs`.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_SETTLE_MS,
  PUSH_IS_LOSSY,
  REQUIRED_COLUMNS,
  STREAMS,
  STREAM_BY_KEY,
  UNBACKED_EVENT_NAMES,
  availableStreams,
  columnExists,
  checkSuiteHasPrAssociation,
  unbackedEventNames,
  buildStreamQuery,
  createGithubFeedSource,
  pushIsLossy,
  tableExists,
  positionAfter,
  settleCursor,
} from "./github-feed-source.mjs";

const tmp = mkdtempSync(join(tmpdir(), "gh-feed-source-"));
afterAll(() => {
  // Cleanup must never fail the suite: an aborted suite exits non-zero, which is
  // byte-identical to a caught mutant.
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** The replica's real DDL for the tables this module reads, verbatim from mini-2. */
const DDL = `
CREATE TABLE pull_requests (
  repo_id text NOT NULL, number integer NOT NULL, node_id text, state text, draft integer,
  merged integer, merged_at integer, head_sha text, base_ref text, mergeable integer,
  mergeable_state text, auto_merge integer, updated_at integer, synced_at integer,
  title text, body text, author_login text, author_avatar_url text, created_at integer,
  closed_at integer, comment_count integer, milestone_title text, head_ref text,
  linear_issue_identifier text, PRIMARY KEY(repo_id, number));
CREATE TABLE reviews (
  repo_id text NOT NULL, pr_number integer NOT NULL, review_id text PRIMARY KEY NOT NULL,
  user_id text, state text, submitted_at integer, body text);
CREATE TABLE pr_review_comments (
  id text PRIMARY KEY NOT NULL, repo_id text NOT NULL, pr_number integer NOT NULL,
  review_id text, commit_id text, path text, line integer, diff_hunk text,
  in_reply_to_id text, author_id text, body text, created_at integer, updated_at integer,
  removed_at integer);
CREATE TABLE pr_review_threads (
  id text PRIMARY KEY NOT NULL, repo_id text NOT NULL, pr_number integer NOT NULL,
  resolved integer, resolved_at integer, resolver_id text, first_comment_id text,
  comment_count integer, updated_at integer);
CREATE TABLE deployments (
  id text PRIMARY KEY NOT NULL, repo_id text NOT NULL, ref text, sha text, task text,
  environment text, production_environment integer, transient_environment integer,
  description text, creator_id text, created_at integer, updated_at integer);
CREATE TABLE deployment_statuses (
  id text PRIMARY KEY NOT NULL, repo_id text NOT NULL, deployment_id text NOT NULL,
  state text, environment text, target_url text, environment_url text, description text,
  creator_id text, created_at integer, updated_at integer);
CREATE TABLE pushes (
  repo_id text NOT NULL, ref text NOT NULL, before text, after text, forced integer,
  created integer, deleted integer, base_ref text, pusher_id text, head_commit_sha text,
  updated_at integer, PRIMARY KEY(repo_id, ref));
-- CTC-704 (schema 0.1.17): one row per DELIVERY, PK = GitHub's x-github-delivery id.
-- Verbatim from mini-2 after the pin.
CREATE TABLE push_events (
  delivery_id text PRIMARY KEY, repo_id text NOT NULL, ref text NOT NULL, before text,
  after text, forced integer, created integer, deleted integer, base_ref text,
  pusher_id text, head_commit_sha text, updated_at integer);
-- CTC-712 (schema 0.1.18): the suite row plus pull_request_numbers, migration
-- 0028_burly_nemesis. Verbatim from mini-2's DDL plus the additive column.
-- (No backticks in here: this block lives inside a template literal.)
CREATE TABLE check_suites (
  repo_id text NOT NULL, check_suite_id text PRIMARY KEY NOT NULL, head_sha text,
  head_branch text, status text, conclusion text, app_slug text,
  latest_check_runs_count integer, updated_at integer, pull_request_numbers text);
`;

/** The pre-0.1.17 DDL — every table EXCEPT push_events, for the un-pinned-host tests. */
const DDL_PRE_0_1_17 = DDL.slice(0, DDL.indexOf("-- CTC-704"));

/**
 * The 0.1.17 shape: `check_suites` EXISTS but has no `pull_request_numbers`.
 *
 * ⛔ THIS IS THE CASE `tableExists` CANNOT SEE, and it is the one every mini was in
 * this morning. Derived by deleting exactly the one column from the real DDL — not by
 * hand-writing a second table, which would drift from the first and could agree with
 * a broken `columnExists` for the wrong reason.
 */
const DDL_PRE_0118 = DDL.replace(", pull_request_numbers text)", ")");
// ⛔ Positive control on the FIXTURE: a derivation that silently matched nothing would
// make every "pre-0.1.18" test below run against a 0.1.18 replica and pass vacuously.
if (DDL_PRE_0118 === DDL) throw new Error("DDL_PRE_0118 derivation matched nothing");

let dbSeq = 0;
function freshDb(seed = () => {}) {
  const path = join(tmp, `replica-${dbSeq++}.db`);
  const db = new Database(path);
  db.exec(DDL);
  seed(db);
  db.close();
  return path;
}

describe("keyset pagination over a real SQLite replica", () => {
  // ⛔ THE CENTRAL PROPERTY. Four reviews share ONE millisecond. A `>` comparison on
  // a bare timestamp drops the siblings that were not in the first page; a `>=` one
  // never advances. Only the composite `(ts, id)` form pages them exactly once.
  const path = freshDb((db) => {
    const ins = db.prepare(
      "INSERT INTO reviews (repo_id, pr_number, review_id, user_id, state, submitted_at, body) VALUES (?,?,?,?,?,?,?)",
    );
    for (const id of ["r-a", "r-b", "r-c", "r-d"]) ins.run("o/r", 1, id, "github:x", "COMMENTED", 1000, "");
    ins.run("o/r", 1, "r-e", "github:x", "COMMENTED", 1001, "");
  });

  test("pages every same-millisecond sibling exactly once across a batch boundary", () => {
    const src = createGithubFeedSource({ dbPath: path, limit: 2 });
    const seen = [];
    let pos = null;
    for (let i = 0; i < 10; i++) {
      const rows = src.rowsSince("reviewSubmitted", pos);
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.review_id));
      pos = positionAfter(rows);
    }
    src.close();
    // Exactly once each, in key order — no drops (the `>` bug) and no repeats (`>=`).
    expect(seen).toEqual(["r-a", "r-b", "r-c", "r-d", "r-e"]);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test("a batch limit SMALLER than one millisecond's row count still advances", () => {
    // The `>=` wedge: 4 rows share ts=1000 and the limit is 1. A producer that
    // re-read the whole millisecond would return "r-a" forever.
    const src = createGithubFeedSource({ dbPath: path, limit: 1 });
    const seen = [];
    let pos = null;
    for (let i = 0; i < 12; i++) {
      const rows = src.rowsSince("reviewSubmitted", pos);
      if (rows.length === 0) break;
      seen.push(...rows.map((r) => r.review_id));
      pos = positionAfter(rows);
    }
    src.close();
    expect(seen).toEqual(["r-a", "r-b", "r-c", "r-d", "r-e"]);
  });

  test("positionAfter returns null for an empty page, so a sweep cannot advance past nothing", () => {
    expect(positionAfter([])).toBeNull();
    expect(positionAfter(null)).toBeNull();
  });
});

describe("stream predicates", () => {
  test("prClosed excludes merged PRs; prMerged is the one that claims them", () => {
    // ⛔ A merged PR also has closed_at set. Without the predicate the feed would
    // emit a `closed` for every merge — an edge the webhook path never emits.
    const path = freshDb((db) => {
      const ins = db.prepare(
        "INSERT INTO pull_requests (repo_id, number, merged, merged_at, closed_at, created_at) VALUES (?,?,?,?,?,?)",
      );
      ins.run("o/r", 1, 1, 500, 500, 100); // merged
      ins.run("o/r", 2, 0, null, 600, 100); // closed unmerged
    });
    const src = createGithubFeedSource({ dbPath: path });
    const closed = src.rowsSince("prClosed", null).map((r) => r.number);
    const merged = src.rowsSince("prMerged", null).map((r) => r.number);
    src.close();
    expect(closed).toEqual([2]);
    expect(merged).toEqual([1]);
  });

  test("threadResolved yields only resolved threads", () => {
    const path = freshDb((db) => {
      const ins = db.prepare(
        "INSERT INTO pr_review_threads (id, repo_id, pr_number, resolved, resolved_at) VALUES (?,?,?,?,?)",
      );
      ins.run("t1", "o/r", 1, 1, 500);
      ins.run("t2", "o/r", 1, 0, null);
    });
    const src = createGithubFeedSource({ dbPath: path });
    const ids = src.rowsSince("threadResolved", null).map((r) => r.id);
    src.close();
    expect(ids).toEqual(["t1"]);
  });

  test("every stream's query is syntactically valid against the real DDL", () => {
    // A stream whose SQL does not compile returns nothing at run time and looks
    // exactly like a quiet stream. This makes that failure loud at CI instead.
    const path = freshDb();
    const src = createGithubFeedSource({ dbPath: path });
    for (const s of STREAMS) {
      expect(() => src.rowsSince(s.key, null)).not.toThrow();
    }
    src.close();
  });
});

describe("settleCursor — the emit/cursor split", () => {
  const NOW = 10_000_000;
  const opts = (o = {}) => ({ now: NOW, settleMs: 1000, ...o });

  test("claims a page that ended at or before the horizon exactly", () => {
    const emitted = { lastCreatedAt: NOW - 5000, lastId: "z" };
    expect(settleCursor(emitted, opts())).toEqual({ lastCreatedAt: NOW - 5000, lastId: "z" });
  });

  test("⛔ does NOT claim a page that ended past the horizon — it claims the horizon", () => {
    // This is the whole point. Claiming `emitted` here is the silent-loss bug: a row
    // arriving later with an older stamp would be behind the cursor forever.
    const emitted = { lastCreatedAt: NOW - 10, lastId: "z" };
    expect(settleCursor(emitted, opts())).toEqual({ lastCreatedAt: NOW - 1000, lastId: "" });
  });

  test("advances on a busy page rather than wedging", () => {
    // The other failure: refusing to move at all when every page ends inside the
    // window would freeze the cursor permanently on an active repo.
    const prev = { lastCreatedAt: NOW - 9000, lastId: "a" };
    const out = settleCursor({ lastCreatedAt: NOW - 10, lastId: "z" }, opts({ previous: prev }));
    expect(out.lastCreatedAt).toBe(NOW - 1000);
    expect(out.lastCreatedAt).toBeGreaterThan(prev.lastCreatedAt);
  });

  test("⛔ never moves backwards, even if the clock steps back or settleMs grows", () => {
    const prev = { lastCreatedAt: NOW, lastId: "m" };
    // A clock step back of an hour.
    expect(settleCursor({ lastCreatedAt: NOW - 10, lastId: "z" }, opts({ now: NOW - 3_600_000, previous: prev })))
      .toEqual(prev);
    // A settle window widened to a day.
    expect(settleCursor({ lastCreatedAt: NOW - 10, lastId: "z" }, opts({ settleMs: 86_400_000, previous: prev })))
      .toEqual(prev);
  });

  test("a producer that has never read anything cannot claim a window it never looked at", () => {
    expect(settleCursor(null, opts())).toBeNull();
  });

  test("throws on a non-integer clock rather than silently computing a garbage horizon", () => {
    expect(() => settleCursor({ lastCreatedAt: 1 }, { now: undefined })).toThrow();
  });

  test("the default settle window exceeds the largest lag measured on the fleet (333s)", () => {
    // Sizing evidence lives in the module header. If someone shrinks this below the
    // measured tail, that is a decision that should have to edit a test.
    expect(DEFAULT_SETTLE_MS).toBeGreaterThan(333_000);
  });
});

describe("declared gaps are exported, not implied by a comment", () => {
  test("check_suite.completed is named as unbacked", () => {
    expect(UNBACKED_EVENT_NAMES).toContain("github.check_suite.completed");
  });
  test("⛔ an unbacked name is unbacked ON A REPLICA, not in the abstract", () => {
    // ⚠️ THIS INVARIANT CHANGED SHAPE WITH CTC-712 AND THE OLD FORM WOULD NOW BE
    // WRONG IN THE DANGEROUS DIRECTION. It read "no stream produces a name in
    // UNBACKED_EVENT_NAMES" — true only while an unbacked name had no stream at all.
    // `checkSuiteCompleted` produces `github.check_suite.completed` AND that name is
    // still in the STATIC list, because the static list is the answer for a caller
    // with no replica handle and the safe answer there is "uncovered". Keeping the
    // old assertion would have forced deleting the name from the static list, which
    // is exactly what suppresses smee on a host that cannot emit it.
    //
    // The real invariant is per replica: a name is unbacked here iff no stream this
    // replica SERVES produces it.
    const withCol = new Database(":memory:");
    withCol.run(DDL);
    const servedNames = new Set(availableStreams(withCol).map((x) => x.event).filter(Boolean));
    for (const n of unbackedEventNames(withCol)) expect(servedNames.has(n)).toBe(false);
    // Positive control: the resolution is not vacuous — this replica DOES serve it.
    expect(servedNames.has("github.check_suite.completed")).toBe(true);
    expect(unbackedEventNames(withCol)).toEqual([]);

    const noCol = new Database(":memory:");
    noCol.run(DDL_PRE_0118);
    const servedPre = new Set(availableStreams(noCol).map((x) => x.event).filter(Boolean));
    for (const n of unbackedEventNames(noCol)) expect(servedPre.has(n)).toBe(false);
    expect(servedPre.has("github.check_suite.completed")).toBe(false);
    expect(unbackedEventNames(noCol)).toEqual(["github.check_suite.completed"]);

    // ⛔ And with NO handle the answer is the SAFE one, not the optimistic one.
    expect(unbackedEventNames()).toEqual(["github.check_suite.completed"]);
    expect(UNBACKED_EVENT_NAMES).toEqual(["github.check_suite.completed"]);
  });
  test("the two push streams are the only ones keyed on a mutable column", () => {
    // ⚠️ `pushEvent` shares `updated_at` with `push` but is NOT lossy for it: its PK
    // is the delivery id, so the mutable timestamp is only the keyset's major
    // coordinate, never part of the row's identity. That distinction is what makes
    // one of them collapse and the other not.
    const mutable = STREAMS.filter((s) => s.tsCol === "updated_at").map((s) => s.key);
    expect(mutable.sort()).toEqual(["checkSuiteCompleted", "push", "pushEvent"]);
    // ⛔ SHARING THE COORDINATE IS NOT SHARING THE HAZARD, and the split is by PK.
    // `push` is keyed on the REF, so its PK is constant across every push and the
    // identity MUST fold the coordinate in. `checkSuiteCompleted` is keyed on the
    // SUITE, which is nearly per-edge — but a `rerequested` suite reuses its id and
    // completes twice, so it folds too. `pushEvent` is keyed on the DELIVERY, a
    // complete edge identity, so it must NOT fold: doing so would make a redelivery
    // of the same push look like a new one.
    expect(STREAM_BY_KEY.push.mutableRow).toBe(true);
    expect(STREAM_BY_KEY.checkSuiteCompleted.mutableRow).toBe(true);
    expect(STREAM_BY_KEY.pushEvent.mutableRow).toBeUndefined();
    // ⚠️ `edgeIdCols` is declared by `push` ALONE, and the asymmetry is the point.
    // Folding the coordinate is what both need; folding an extra COLUMN is needed only
    // where two distinct edges can share a millisecond. Two pushes to one ref can;
    // one suite cannot complete twice at one `updated_at`. A mutation showed the
    // conclusion-fold this stream briefly carried was unobservable, so it is gone.
    expect(STREAM_BY_KEY.push.edgeIdCols).toEqual(["after"]);
    expect(STREAM_BY_KEY.checkSuiteCompleted.edgeIdCols).toBeUndefined();
  });
});

describe("CTC-712 — a COLUMN is a capability, and its absence is not a table's absence", () => {
  const mk = (ddl) => { const db = new Database(":memory:"); db.run(ddl); return db; };

  test("columnExists distinguishes present / absent / no-such-table", () => {
    const at0118 = mk(DDL);
    const at0117 = mk(DDL_PRE_0118);
    expect(columnExists(at0118, "check_suites", "pull_request_numbers")).toBe(true);
    expect(columnExists(at0117, "check_suites", "pull_request_numbers")).toBe(false);
    // Positive control: the 0.1.17 fixture still HAS the table and its other columns,
    // so a `false` above is about the column and not about a missing fixture.
    expect(columnExists(at0117, "check_suites", "head_sha")).toBe(true);
    // A table that does not exist yields false rather than throwing.
    expect(columnExists(at0118, "no_such_table", "anything")).toBe(false);
  });

  test("⛔ a broken column probe would be INVISIBLE without this: SELECT * does not throw", () => {
    // The reason `tableExists` cannot stand in. On a 0.1.17 replica the stream's own
    // query runs happily and simply yields rows with the field undefined — there is no
    // `no such column` for anything to catch, so the producer would emit suite events
    // with no PR association and every count would read "emitted".
    const at0117 = mk(DDL_PRE_0118);
    at0117.run(
      "INSERT INTO check_suites (repo_id, check_suite_id, head_sha, status, conclusion, updated_at) VALUES ('o/r','s1','abc','completed','success',1000)",
    );
    const rows = at0117.prepare(buildStreamQuery("checkSuiteCompleted")).all({ $sinceMs: 0, $sinceId: "", $limit: 10 });
    expect(rows.length).toBe(1);                       // the query SUCCEEDED
    expect(rows[0].pull_request_numbers).toBeUndefined(); // and the association is simply gone
  });

  test("availableStreams serves checkSuiteCompleted only where the column exists", () => {
    expect(availableStreams(mk(DDL)).map((x) => x.key)).toContain("checkSuiteCompleted");
    expect(availableStreams(mk(DDL_PRE_0118)).map((x) => x.key)).not.toContain("checkSuiteCompleted");
    // ⚠️ And the rest of the streams are UNAFFECTED — a capability gate that quietly
    // shed its neighbours would look identical in the assertion above.
    const a = availableStreams(mk(DDL)).map((x) => x.key).filter((k) => k !== "checkSuiteCompleted");
    const b = availableStreams(mk(DDL_PRE_0118)).map((x) => x.key);
    expect(b).toEqual(a);
  });

  test("checkSuiteHasPrAssociation answers per replica", () => {
    expect(checkSuiteHasPrAssociation(mk(DDL))).toBe(true);
    expect(checkSuiteHasPrAssociation(mk(DDL_PRE_0118))).toBe(false);
    // A replica with no check_suites table at all is also "cannot", not a throw.
    expect(checkSuiteHasPrAssociation(mk(DDL_PRE_0_1_17))).toBe(false);
  });

  test("the keyset query pages completed suites in order and skips other statuses", () => {
    const db = mk(DDL);
    const ins = (id, ts, status) => db.run(
      `INSERT INTO check_suites (repo_id, check_suite_id, head_sha, status, conclusion, updated_at, pull_request_numbers)
       VALUES ('o/r','${id}','sha','${status}','success',${ts},'[7]')`,
    );
    ins("s1", 1000, "completed");
    ins("s2", 2000, "in_progress");   // must never page
    ins("s3", 3000, "completed");
    const rows = db.prepare(buildStreamQuery("checkSuiteCompleted")).all({ $sinceMs: 0, $sinceId: "", $limit: 10 });
    expect(rows.map((r) => r.__id)).toEqual(["s1", "s3"]);
    expect(rows.map((r) => r.__ts)).toEqual([1000, 3000]);
    // and the keyset advances past what it read
    const after = db.prepare(buildStreamQuery("checkSuiteCompleted")).all({ $sinceMs: 1000, $sinceId: "s1", $limit: 10 });
    expect(after.map((r) => r.__id)).toEqual(["s3"]);
  });
});

describe("live replica schema conformance", () => {
  // Three-valued on purpose: with no replica present this reports INCONCLUSIVE and
  // must be read as UNRUN, never as a pass. A column missing from the live schema is
  // a stream that silently returns nothing.
  // Resolved the way the daemon resolves it (`CATALYST_REPLICA_DB` > `CATALYST_DIR`
  // > `$HOME`), so this can be pointed at a 0.1.16 snapshot on a host whose own
  // replica is older — otherwise the check only ever reports INCONCLUSIVE and a
  // verdict it has never returned is not evidence of anything.
  const live =
    process.env.CATALYST_REPLICA_DB ??
    join(process.env.CATALYST_DIR ?? join(process.env.HOME ?? "", "catalyst"), "catalyst-replica.db");
  test("every REQUIRED_COLUMN exists on the host replica", () => {
    // ⛔ The guard must wrap the READ, not the construction. `createGithubFeedSource`
    // opens lazily, so an unreadable replica throws here rather than there — and the
    // first cut of this test put the try around the constructor, where it could never
    // fire. A guard that cannot fire for the case it exists for is not a guard.
    //
    // "Unreadable" is a real and easily-hit state, not a theoretical one: a readonly
    // open of a WAL-mode database with no `-shm` sidecar fails outright, because
    // SQLite cannot create the sidecar without write access. A live host always has
    // one (its writer maintains it); a copied snapshot does not.
    const src = createGithubFeedSource({ dbPath: live });
    try {
      const missing = [];
      for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
        let have;
        try {
          have = new Set(src.columnsOf(table));
        } catch (err) {
          console.log(`INCONCLUSIVE: cannot read ${live} (${err?.message ?? err}) — treat this test as unrun, not as a pass.`);
          return;
        }
        if (have.size === 0) {
          console.log(`INCONCLUSIVE: table ${table} absent from ${live} — treat as unrun.`);
          return;
        }
        for (const c of cols) if (!have.has(c)) missing.push(`${table}.${c}`);
      }
      expect(missing).toEqual([]);
    } finally {
      try { src.close(); } catch { /* never fail the suite in cleanup */ }
    }
  });
});

describe("buildStreamQuery", () => {
  test("uses the composite keyset form, never a bare watermark", () => {
    const sql = buildStreamQuery("reviewSubmitted");
    // Both halves of the OR must be present; either alone is one of the two bugs.
    expect(sql).toContain("submitted_at > $sinceMs");
    expect(sql).toContain("submitted_at = $sinceMs AND review_id > $sinceId");
    expect(sql).toContain("ORDER BY submitted_at ASC, review_id ASC");
  });
  test("refuses an unknown stream instead of returning a query that matches nothing", () => {
    expect(() => buildStreamQuery("nope")).toThrow();
  });
  test("STREAM_BY_KEY covers every stream", () => {
    expect(Object.keys(STREAM_BY_KEY).sort()).toEqual(STREAMS.map((s) => s.key).sort());
  });
});

describe("⛔ exactly ONE push stream is served, chosen from the replica (CTC-704)", () => {
  // Both streams carry the name `github.push`. Running both on a pinned host emits
  // every push TWICE — and their identities differ (`delivery_id` vs the folded
  // `repo_id@ref`), so the seen-set cannot collapse them: the duplicate reaches the
  // router as a second genuine-looking base-branch move and wakes every waiter again.
  // Running neither on an un-pinned host silently kills rebase detection.
  const pinned = () => { const db = new Database(":memory:"); db.exec(DDL); return db; };
  const unpinned = () => { const db = new Database(":memory:"); db.exec(DDL_PRE_0_1_17); return db; };

  test("tableExists answers from the replica, not from a version guess", () => {
    expect(tableExists(pinned(), "push_events")).toBe(true);
    expect(tableExists(unpinned(), "push_events")).toBe(false);
    expect(tableExists(pinned(), "pushes")).toBe(true);
    expect(tableExists(pinned(), "no_such_table")).toBe(false);
  });

  test("⭐ a PINNED replica (0.1.17) serves pushEvent and NOT push", () => {
    const keys = availableStreams(pinned()).map((s) => s.key);
    expect(keys).toContain("pushEvent");
    expect(keys).not.toContain("push");
  });

  test("⛔ an UN-PINNED replica serves push and NOT pushEvent — it is not left with neither", () => {
    // The canary leaves one host on the old pin by design (COORD-128 condition 2).
    // A lossy push stream is worse than a faithful one and much better than none,
    // while smee is still underneath.
    const keys = availableStreams(unpinned()).map((s) => s.key);
    expect(keys).toContain("push");
    expect(keys).not.toContain("pushEvent");
  });

  test("⛔ exactly one `github.push` producer in EITHER world — asserted as a count", () => {
    for (const mk of [pinned, unpinned]) {
      const pushers = availableStreams(mk()).filter((s) => s.event === "github.push");
      expect(pushers).toHaveLength(1);
    }
  });

  test("every other stream is unaffected by the pin", () => {
    // ⚠️ `checkSuiteCompleted` is excluded alongside the push pair, and for the SAME
    // reason rather than as a convenience: the "unpinned" fixture is pre-0.1.17, which
    // has no `check_suites` table at all, so that stream is legitimately capability-
    // gated between these two replicas too. What this test asserts is the narrower and
    // still-important claim — that the push supersession disturbs nothing ELSE.
    const gated = (k) => k.startsWith("push") || k === "checkSuiteCompleted";
    const a = availableStreams(pinned()).map((s) => s.key).filter((k) => !gated(k));
    const b = availableStreams(unpinned()).map((s) => s.key).filter((k) => !gated(k));
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(5);
  });

  test("⚠️ pushIsLossy tracks the REPLICA, so a mixed fleet cannot share one answer", () => {
    // It was a module constant. With one host pinned and one not, a constant is
    // wrong on exactly one of them — and the dispatch gate reads this to decide
    // whether `github.push` may suppress smee.
    expect(pushIsLossy(pinned())).toBe(false);
    expect(pushIsLossy(unpinned())).toBe(true);
  });

  test("the pushEvent keyset query runs against the real 0.1.17 DDL", () => {
    const db = pinned();
    db.prepare(`INSERT INTO push_events
        (delivery_id,repo_id,ref,before,after,forced,created,deleted,base_ref,pusher_id,head_commit_sha,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run("d1", "o/r", "refs/heads/main", "aaa", "bbb", 0, 0, 0, null, "github:x", "bbb", 1000);
    const rows = db.query(buildStreamQuery("pushEvent")).all({ $sinceMs: 0, $sinceId: "", $limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].__id).toBe("d1");
    expect(rows[0].__ts).toBe(1000);
  });

  test("⭐ two pushes to ONE ref both survive — the defect CTC-704 exists to fix", () => {
    const db = pinned();
    const ins = db.prepare(`INSERT INTO push_events
        (delivery_id,repo_id,ref,before,after,updated_at) VALUES (?,?,?,?,?,?)`);
    ins.run("d1", "o/r", "refs/heads/main", "aaa", "bbb", 1000);
    ins.run("d2", "o/r", "refs/heads/main", "bbb", "ccc", 1001);
    const rows = db.query(buildStreamQuery("pushEvent")).all({ $sinceMs: 0, $sinceId: "", $limit: 10 });
    expect(rows).toHaveLength(2);
    // ⛔ The control against the old table: the SAME two pushes in `pushes` leave one row.
    const up = db.prepare(`INSERT INTO pushes (repo_id,ref,before,after,updated_at) VALUES (?,?,?,?,?)
                           ON CONFLICT(repo_id,ref) DO UPDATE SET after=excluded.after, updated_at=excluded.updated_at`);
    up.run("o/r", "refs/heads/main", "aaa", "bbb", 1000);
    up.run("o/r", "refs/heads/main", "bbb", "ccc", 1001);
    expect(db.query("SELECT COUNT(*) c FROM pushes").get().c).toBe(1);
  });

  test("⚠️ a force-push BACK to a previous sha is still its own row", () => {
    // The case that collapses under COORD-127's proposed `(repo_id, ref, after)` key,
    // and the reason backend took the delivery id instead (CTC-704 §4.1).
    const db = pinned();
    const ins = db.prepare(`INSERT INTO push_events
        (delivery_id,repo_id,ref,before,after,forced,updated_at) VALUES (?,?,?,?,?,?,?)`);
    ins.run("d1", "o/r", "refs/heads/f", "000", "X", 0, 1000);
    ins.run("d2", "o/r", "refs/heads/f", "X", "Y", 0, 1001);
    ins.run("d3", "o/r", "refs/heads/f", "Y", "X", 1, 1002);
    const rows = db.query(buildStreamQuery("pushEvent")).all({ $sinceMs: 0, $sinceId: "", $limit: 10 });
    expect(rows).toHaveLength(3);
  });
});
