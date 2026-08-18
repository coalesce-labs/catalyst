// Run: cd plugins/dev/scripts/execution-core && bun test github-feed-sweep.test.mjs
//
// Real SQLite for both the replica and the suppression set, and real cursor files.
// The properties under test are about what survives a SECOND tick, which a mocked
// store cannot exhibit.

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGithubFeedSource } from "./github-feed-source.mjs";
import { createSeenStore } from "./github-feed-seen.mjs";
import { emptyCounts, runGithubSweep, streamCursorPath } from "./github-feed-sweep.mjs";
import { countsClean } from "./cloud-feed-timer.mjs";
import { githubSweepUnreadyReason } from "./github-feed-sweep.mjs";

const tmp = mkdtempSync(join(tmpdir(), "gh-feed-sweep-"));
afterAll(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* never fail in cleanup */ }
});

const DDL = `
CREATE TABLE pull_requests (
  repo_id text NOT NULL, number integer NOT NULL, state text, draft integer, merged integer,
  merged_at integer, head_sha text, base_ref text, mergeable integer, updated_at integer,
  synced_at integer, title text, body text, author_login text, created_at integer,
  closed_at integer, head_ref text, linear_issue_identifier text,
  PRIMARY KEY(repo_id, number));
CREATE TABLE reviews (repo_id text NOT NULL, pr_number integer NOT NULL,
  review_id text PRIMARY KEY NOT NULL, user_id text, state text, submitted_at integer, body text);
CREATE TABLE pr_review_comments (id text PRIMARY KEY NOT NULL, repo_id text NOT NULL,
  pr_number integer NOT NULL, review_id text, commit_id text, path text, line integer,
  diff_hunk text, in_reply_to_id text, author_id text, body text, created_at integer,
  updated_at integer, removed_at integer);
CREATE TABLE pr_review_threads (id text PRIMARY KEY NOT NULL, repo_id text NOT NULL,
  pr_number integer NOT NULL, resolved integer, resolved_at integer, resolver_id text,
  first_comment_id text, comment_count integer, updated_at integer);
CREATE TABLE deployments (id text PRIMARY KEY NOT NULL, repo_id text NOT NULL, ref text,
  sha text, task text, environment text, production_environment integer,
  transient_environment integer, description text, creator_id text, created_at integer,
  updated_at integer);
CREATE TABLE deployment_statuses (id text PRIMARY KEY NOT NULL, repo_id text NOT NULL,
  deployment_id text NOT NULL, state text, environment text, target_url text,
  environment_url text, description text, creator_id text, created_at integer, updated_at integer);
CREATE TABLE pushes (repo_id text NOT NULL, ref text NOT NULL, before text, after text,
  forced integer, created integer, deleted integer, base_ref text, pusher_id text,
  head_commit_sha text, updated_at integer, PRIMARY KEY(repo_id, ref));
`;

const SEAMS = {
  now: () => new Date("2026-08-18T00:00:00.000Z"),
  newId: () => "id0", newTrace: () => "t0", newSpan: () => "s0",
};

let seq = 0;
/** A fresh, isolated world: replica + suppression set + orchDir for cursor files. */
function world(seed = () => {}) {
  const dir = join(tmp, `w${seq++}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "replica.db");
  const db = new Database(dbPath, { create: true });
  db.exec(DDL);
  seed(db);
  db.close();
  const source = createGithubFeedSource({ dbPath });
  const seen = createSeenStore({ path: join(dir, "seen.db") });
  const emitted = [];
  const sink = (ev) => emitted.push(ev);
  return { dir, dbPath, source, seen, sink, emitted, close: () => { source.close(); seen.close(); } };
}

const addReview = (db, id, ts) =>
  db.prepare("INSERT INTO reviews (repo_id,pr_number,review_id,user_id,state,submitted_at,body) VALUES (?,?,?,?,?,?,?)")
    .run("o/r", 7, id, "github:alice", "COMMENTED", ts, "b");

const sweep = (w, now, extra = {}) =>
  runGithubSweep({
    source: w.source, seen: w.seen, sink: w.sink, orchDir: w.dir,
    now, settleMs: 1000, streams: ["reviewSubmitted"], seams: SEAMS, ...extra,
  });

describe("⭐ the property the whole design exists for: a late arrival is not lost", () => {
  test("a row inserted AFTER the tick that passed its timestamp is still emitted", () => {
    const NOW = 10_000_000;
    const w = world((db) => addReview(db, "r-early", NOW - 100));
    try {
      // Tick 1 emits r-early. Its timestamp is INSIDE the settle window, so the
      // durable cursor is held at the horizon rather than at the row.
      const c1 = sweep(w, NOW);
      expect(c1.emitted).toBe(1);

      // Now a row arrives carrying an OLDER stamp than one already emitted — the
      // exact out-of-order ingestion measured at 37% >60s on the live fleet.
      const db = new Database(w.dbPath);
      addReview(db, "r-late", NOW - 500);
      db.close();

      // ⛔ A producer that had advanced its cursor to `r-early` would never see it.
      const c2 = sweep(w, NOW + 1);
      expect(c2.emitted).toBe(1);
      expect(w.emitted.map((e) => e.attributes["vcs.pr.number"])).toEqual([7, 7]);
      expect(c2.suppressed).toBe(1); // r-early re-read and correctly suppressed
    } finally { w.close(); }
  });

  test("re-reading the settle window emits nothing twice", () => {
    const NOW = 10_000_000;
    const w = world((db) => { addReview(db, "a", NOW - 100); addReview(db, "b", NOW - 90); });
    try {
      expect(sweep(w, NOW).emitted).toBe(2);
      for (let i = 1; i <= 4; i++) {
        const c = sweep(w, NOW + i);
        expect(c.emitted).toBe(0);
        expect(c.suppressed).toBe(2);
      }
      expect(w.emitted.length).toBe(2);
    } finally { w.close(); }
  });

  test("entries strictly older than the cursor are pruned — the set is bounded by the window, not by uptime", () => {
    const NOW = 10_000_000;
    const w = world((db) => { addReview(db, "a", NOW - 900); addReview(db, "b", NOW - 500); });
    try {
      sweep(w, NOW);
      expect(w.seen.size()).toBe(2);
      // A much later tick: the cursor advances to the newest row, so everything
      // strictly older than it can never be re-read and is dropped.
      sweep(w, NOW + 1_000_000);
      expect(w.seen.size()).toBe(1);

      // ⚠️ The one entry left sits exactly ON the cursor's timestamp. Pruning is
      // `ts < cursor`, never `<=`: a row sharing that millisecond with a HIGHER id is
      // still re-readable (the tie-break is `ts = since AND id > sinceId`), and a
      // timestamp-only prune cannot tell it apart from one already passed. Keeping it
      // is the conservative direction.
      //
      // ⭐ And it does not linger: an IDLE tick reads nothing, which is itself proof
      // that everything at or before the horizon has arrived, so the cursor advances
      // to the horizon and the set drains completely. The retention bound is
      // therefore one settle window in the worst case and zero at rest — bounded by
      // the window, never by uptime.
      sweep(w, NOW + 2_000_000);
      expect(w.seen.size()).toBe(0);
    } finally { w.close(); }
  });
});

describe("⛔ P1 regression (Codex #3513): consecutive pushes to one ref both reach the log", () => {
  test("a second push to the SAME ref is emitted, not suppressed as a re-read", () => {
    // This is the test that would have caught it. `pushes` is keyed (repo_id, ref)
    // and REWRITTEN per push, so the row's PK is constant — the seen-set suppressed
    // every push after the first, per ref, for as long as the entry lived. The unit
    // test on identity is necessary but not sufficient: only driving two sweeps over
    // a MUTATED row shows the suppression actually happening.
    const NOW = 10_000_000;
    const w = world((db) => {
      db.prepare("INSERT INTO pushes (repo_id,ref,before,after,updated_at) VALUES (?,?,?,?,?)")
        .run("o/r", "refs/heads/main", "sha0", "sha1", NOW - 500);
    });
    try {
      const opts = { source: w.source, seen: w.seen, sink: w.sink, orchDir: w.dir,
        settleMs: 1000, streams: ["push"], seams: SEAMS };
      expect(runGithubSweep({ ...opts, now: NOW }).emitted).toBe(1);

      // The SAME row is now rewritten in place by a second push — exactly what the
      // mirror does, and why the PK is not an edge identity here.
      const db2 = new Database(w.dbPath);
      db2.prepare("UPDATE pushes SET before=?, after=?, updated_at=? WHERE repo_id=? AND ref=?")
        .run("sha1", "sha2", NOW - 400, "o/r", "refs/heads/main");
      db2.close();

      const c2 = runGithubSweep({ ...opts, now: NOW + 1 });
      expect(c2.emitted).toBe(1);
      expect(c2.suppressed).toBe(0);
      expect(w.emitted.map((e) => e.body.payload.headSha)).toEqual(["sha1", "sha2"]);
    } finally { w.close(); }
  });

  test("an UNCHANGED push row is still suppressed on re-read", () => {
    // The other direction — the fix must not defeat suppression entirely, or every
    // settle-window re-read becomes a duplicate wake.
    const NOW = 10_000_000;
    const w = world((db) => {
      db.prepare("INSERT INTO pushes (repo_id,ref,before,after,updated_at) VALUES (?,?,?,?,?)")
        .run("o/r", "refs/heads/main", "sha0", "sha1", NOW - 500);
    });
    try {
      const opts = { source: w.source, seen: w.seen, sink: w.sink, orchDir: w.dir,
        settleMs: 1000, streams: ["push"], seams: SEAMS };
      expect(runGithubSweep({ ...opts, now: NOW }).emitted).toBe(1);
      const c2 = runGithubSweep({ ...opts, now: NOW + 1 });
      expect(c2.emitted).toBe(0);
      expect(c2.suppressed).toBe(1);
    } finally { w.close(); }
  });
});

describe("⛔ declines never reach byFailure — this is the CTL-1909 property", () => {
  test("an uncovered stream declines and readiness stays armed", () => {
    const NOW = 10_000_000;
    const w = world((db) => {
      db.prepare("INSERT INTO pull_requests (repo_id,number,merged,merged_at,created_at) VALUES (?,?,?,?,?)")
        .run("o/r", 7, 1, NOW - 500, NOW - 900);
    });
    try {
      const c = sweep(w, NOW, { streams: ["prMerged"] });
      expect(c.declined).toBe(1);
      expect(c.failed).toBe(0);
      expect(Object.keys(c.byReason)[0]).toContain("CTC-691");
      // The gate the daemon actually runs, imported rather than restated — a
      // hand-built copy could agree with this fixture and disagree with production.
      expect(countsClean(c)).toBe(true);
    } finally { w.close(); }
  });

  test("a malformed row declines; readiness is unaffected", () => {
    const NOW = 10_000_000;
    const w = world((db) => addReview(db, "ok", NOW - 100));
    try {
      const db2 = new Database(w.dbPath);
      // No pr_number -> the consumer could not use it -> decline, not failure.
      db2.prepare("INSERT INTO reviews (repo_id,pr_number,review_id,user_id,state,submitted_at) VALUES (?,?,?,?,?,?)")
        .run("o/r", 0, "bad", "github:a", "COMMENTED", NOW - 99);
      db2.close();
      const c = sweep(w, NOW);
      expect(c.emitted).toBe(1);
      expect(c.declined).toBe(1);
      expect(c.failed).toBe(0);
      expect(countsClean(c)).toBe(true);
    } finally { w.close(); }
  });

  test("a stream that throws is a FAILURE, is contained, and un-arms readiness", () => {
    const NOW = 10_000_000;
    const w = world((db) => addReview(db, "a", NOW - 100));
    try {
      const exploding = {
        rowsSince: (k, ...rest) => {
          if (k === "push") throw Object.assign(new Error("boom"), { code: "SQLITE_CORRUPT" });
          return w.source.rowsSince(k, ...rest);
        },
        positionAfter: w.source.positionAfter,
      };
      const c = runGithubSweep({
        source: exploding, seen: w.seen, sink: w.sink, orchDir: w.dir, now: NOW,
        settleMs: 1000, streams: ["push", "reviewSubmitted"], seams: SEAMS,
      });
      expect(c.failed).toBe(1);
      expect(Object.keys(c.byFailure)[0]).toContain("push");
      // Contained: the other stream still made progress.
      expect(c.emitted).toBe(1);
      expect(countsClean(c)).toBe(false);
    } finally { w.close(); }
  });

  test("emptyCounts carries byFailure PRESENT and empty", () => {
    // An absent byFailure reads as not-clean on purpose: "nothing wrong" and "could
    // not look" must not be byte-identical.
    const c = emptyCounts();
    expect(c.byFailure).toEqual({});
    expect(countsClean(c)).toBe(true);
    const stripped = { ...c }; delete stripped.byFailure;
    expect(countsClean(stripped)).toBe(false);
  });
});

describe("⛔ first-run detection is PER STREAM, not per producer", () => {
  test("a cold start across many streams raises no cursor-reset declines", () => {
    // A single global everRan flag meant the first stream to emit set it, and every
    // other stream on the SAME first run then read its absent cursor as a LOST one.
    // Measured on a real replica replay: 8 spurious cursor-vanished declines in one
    // cold start — which is exactly how a genuine cursor loss gets lost in the noise.
    const NOW = 10_000_000;
    const w = world((db) => {
      addReview(db, "a", NOW - 500);
      db.prepare("INSERT INTO pushes (repo_id,ref,before,after,updated_at) VALUES (?,?,?,?,?)")
        .run("o/r", "refs/heads/main", "b1", "a1", NOW - 500);
      db.prepare("INSERT INTO pr_review_comments (id,repo_id,pr_number,author_id,body,created_at) VALUES (?,?,?,?,?,?)")
        .run("c1", "o/r", 7, "github:alice", "x", NOW - 500);
    });
    try {
      const c = runGithubSweep({
        source: w.source, seen: w.seen, sink: w.sink, orchDir: w.dir, now: NOW,
        settleMs: 1000, streams: ["reviewSubmitted", "push", "reviewCommentCreated"], seams: SEAMS,
      });
      expect(c.emitted).toBe(3);
      const resets = Object.keys(c.byReason).filter((r) => r.startsWith("cursor-reset"));
      expect(resets).toEqual([]);
    } finally { w.close(); }
  });

  test("and a stream that HAS run keeps its own flag", () => {
    const NOW = 10_000_000;
    const w = world((db) => addReview(db, "a", NOW - 500));
    try {
      sweep(w, NOW);
      expect(w.seen.everRan("reviewSubmitted")).toBe(true);
      // A stream that never emitted must NOT inherit it — that inheritance is the bug.
      expect(w.seen.everRan("push")).toBe(false);
    } finally { w.close(); }
  });
});

describe("⛔ P1 (Codex #3520): the prune is scoped to its own stream", () => {
  test("a stream with a NEWER cursor does not delete a slower stream's entries", () => {
    // The seen table is shared; the cursors are not. An unscoped prune let the
    // faster stream delete entries the slower one can still re-read, so its next
    // sweep re-emitted them with fresh envelope ids — and the broker dedups on that
    // id, so it wakes twice.
    const NOW = 10_000_000;
    const w = world((db) => {
      addReview(db, "old", NOW - 900);
      db.prepare("INSERT INTO pushes (repo_id,ref,before,after,updated_at) VALUES (?,?,?,?,?)")
        .run("o/r", "refs/heads/main", "b1", "a1", NOW - 100);
    });
    try {
      const opts = { source: w.source, seen: w.seen, sink: w.sink, orchDir: w.dir,
        settleMs: 1000, seams: SEAMS };
      // BOTH streams sweep at NOW so each lands an entry AND a durable cursor. The
      // push stream must actually acquire one here — without it, its later sweep
      // reads nothing, writes no cursor and prunes nothing, and this test passes
      // whether or not the prune is scoped. (That is exactly how the first cut of
      // this test failed to catch the bug it was written for.)
      runGithubSweep({ ...opts, now: NOW, streams: ["reviewSubmitted", "push"] });
      expect(w.seen.size("reviewSubmitted")).toBe(1);
      expect(w.seen.size("push")).toBe(1);

      // Push alone now sweeps far in the future. It reads nothing new, so its cursor
      // advances to the horizon — way past the review entry at NOW-900 — and it
      // prunes. An UNSCOPED prune deletes the review entry here.
      runGithubSweep({ ...opts, now: NOW + 1_000_000, streams: ["push"] });

      // ⛔ The review entry must survive: reviews' own cursor has not passed it, so
      // that row is still re-readable and re-emitting it would double-wake.
      expect(w.seen.size("reviewSubmitted")).toBe(1);

      // ⭐ CONTROL — the precondition for the bug must actually hold, or this test
      // proves nothing. Push's durable cursor has to be PAST the review entry's
      // timestamp, because that is exactly what makes an unscoped
      // `DELETE ... WHERE ts < cursor` delete it. Assert that rather than assuming it:
      // the first cut of this test let push read nothing, so it wrote no cursor,
      // pruned nothing, and passed under the mutant.
      const pushCursor = JSON.parse(readFileSync(streamCursorPath(w.dir, "push"), "utf8"));
      expect(pushCursor.lastCreatedAt).toBeGreaterThan(NOW - 900);
    } finally { w.close(); }
  });

  test("a stream still prunes its OWN entries — the scoping must not disable pruning", () => {
    const NOW = 10_000_000;
    const w = world((db) => { addReview(db, "a", NOW - 900); addReview(db, "b", NOW - 500); });
    try {
      sweep(w, NOW);
      expect(w.seen.size("reviewSubmitted")).toBe(2);
      sweep(w, NOW + 1_000_000);
      expect(w.seen.size("reviewSubmitted")).toBe(1);
    } finally { w.close(); }
  });

  test("an unscoped add or prune is REFUSED rather than silently mis-scoped", () => {
    const w = world();
    try {
      expect(() => w.seen.add("gh:x:1", 1)).toThrow();
      expect(() => w.seen.pruneBefore(1)).toThrow();
    } finally { w.close(); }
  });
});

describe("⛔ P2 (Codex #3520): a stream that only DECLINES has still run", () => {
  test("everRan is set from the durable cursor, not from an emission", () => {
    // A decline-only stream advances its cursor, and that advance IS proof it ran.
    // Keyed on `emitted > 0` it stayed flagged first-run, so a later cursor loss
    // cold-started it and permanently skipped the reset lookback window.
    const NOW = 10_000_000;
    const w = world((db) => {
      db.prepare("INSERT INTO pull_requests (repo_id,number,merged,merged_at,created_at) VALUES (?,?,?,?,?)")
        .run("o/r", 7, 1, NOW - 500, NOW - 900);
    });
    try {
      const c = sweep(w, NOW, { streams: ["prMerged"] });
      expect(c.emitted).toBe(0);
      expect(c.declined).toBe(1);
      expect(w.seen.everRan("prMerged")).toBe(true);
    } finally { w.close(); }
  });

  test("a stream that read nothing at all is still first-run", () => {
    // The control: the flag must not become "always true", or a genuine first run
    // takes the bounded-lookback reset path forever.
    const NOW = 10_000_000;
    const w = world();
    try {
      sweep(w, NOW, { streams: ["prMerged"] });
      expect(w.seen.everRan("prMerged")).toBe(false);
    } finally { w.close(); }
  });
});

describe("cursor ordering and durability", () => {
  test("the durable cursor is held BEHIND the emitted position", () => {
    const NOW = 10_000_000;
    const w = world((db) => addReview(db, "a", NOW - 100));
    try {
      sweep(w, NOW);
      const p = streamCursorPath(w.dir, "reviewSubmitted");
      expect(existsSync(p)).toBe(true);
      const cur = JSON.parse(readFileSync(p, "utf8"));
      // Held at the horizon (NOW-1000), NOT at the emitted row (NOW-100).
      expect(cur.lastCreatedAt).toBe(NOW - 1000);
      expect(cur.lastCreatedAt).toBeLessThan(NOW - 100);
    } finally { w.close(); }
  });

  test("a failed sink leaves the cursor unmoved, so the next tick re-reads", () => {
    const NOW = 10_000_000;
    const w = world((db) => addReview(db, "a", NOW - 500));
    try {
      expect(() => runGithubSweep({
        source: w.source, seen: w.seen,
        sink: () => { throw new Error("log unavailable"); },
        orchDir: w.dir, now: NOW, settleMs: 1000, streams: ["reviewSubmitted"], seams: SEAMS,
      })).not.toThrow();
      // No cursor was written, and nothing was marked seen — so a healthy next tick
      // re-emits. Losing progress is recoverable; advancing past an unemitted row is not.
      expect(existsSync(streamCursorPath(w.dir, "reviewSubmitted"))).toBe(false);
      expect(w.seen.size()).toBe(0);
      expect(sweep(w, NOW).emitted).toBe(1);
    } finally { w.close(); }
  });

  test("cursors are per stream — one stream's position does not move another's", () => {
    const NOW = 10_000_000;
    const w = world((db) => {
      addReview(db, "a", NOW - 500);
      db.prepare("INSERT INTO pushes (repo_id,ref,before,after,updated_at) VALUES (?,?,?,?,?)")
        .run("o/r", "refs/heads/main", "b1", "a1", NOW - 500);
    });
    try {
      runGithubSweep({
        source: w.source, seen: w.seen, sink: w.sink, orchDir: w.dir, now: NOW,
        settleMs: 1000, streams: ["reviewSubmitted", "push"], seams: SEAMS,
      });
      expect(existsSync(streamCursorPath(w.dir, "reviewSubmitted"))).toBe(true);
      expect(existsSync(streamCursorPath(w.dir, "push"))).toBe(true);
      expect(streamCursorPath(w.dir, "push")).not.toBe(streamCursorPath(w.dir, "reviewSubmitted"));
    } finally { w.close(); }
  });
});

describe("readiness reads these counts the way the daemon does", () => {
  test("a clean sweep yields no unready reason", () => {
    const NOW = 10_000_000;
    const w = world((db) => addReview(db, "a", NOW - 500));
    try {
      const counts = sweep(w, NOW);
      // sweepUnreadyReason is imported from the module the daemon runs, not restated.
      expect(githubSweepUnreadyReason({ counts, stoppedEarly: false }, { healthy: true })).toBeNull();
      // Fail-closed rungs: absent report / absent counts / unhealthy feed all un-arm.
      expect(githubSweepUnreadyReason(null, { healthy: true })).toBe("no-report");
      expect(githubSweepUnreadyReason({}, { healthy: true })).toBe("no-sweep");
      expect(githubSweepUnreadyReason({ counts }, { healthy: false, reason: "stall" }))
        .toBe("feed-unhealthy:stall");
    } finally { w.close(); }
  });
});
