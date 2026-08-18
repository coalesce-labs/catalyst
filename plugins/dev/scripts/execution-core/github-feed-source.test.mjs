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
  buildStreamQuery,
  createGithubFeedSource,
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
`;

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
  test("no stream claims to produce an unbacked name", () => {
    const produced = new Set(STREAMS.map((s) => s.event).filter(Boolean));
    for (const n of UNBACKED_EVENT_NAMES) expect(produced.has(n)).toBe(false);
  });
  test("push is declared lossy, and is the only stream keyed on a mutable column", () => {
    expect(PUSH_IS_LOSSY).toBe(true);
    const mutable = STREAMS.filter((s) => s.tsCol === "updated_at").map((s) => s.key);
    expect(mutable).toEqual(["push"]);
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
