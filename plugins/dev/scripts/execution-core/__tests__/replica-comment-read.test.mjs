// replica-comment-read.test.mjs — CTL-1958. The credential-free "latest human
// comment" + issue-id replica reader that replaces the app-actor GraphQL read in
// linear-reply.mjs / linear-ack.mjs.
//
// Run: cd plugins/dev/scripts/execution-core && bun test replica-comment-read
//
// The leaf's contract is the OPPOSITE of replica-read.mjs's fail-open one: an
// absent/unreadable replica is a LOUD, NAMED throw (it is the only read path the
// tools have left once the mint is deleted), while "DB fine, no matching human
// comment" is a clean null. Both are asserted below.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readLatestHumanComment,
  readIssueId,
  isReplicaCurrent,
  ReplicaUnavailableError,
  DEFAULT_ASK_HUMAN_ID,
} from "../replica-comment-read.mjs";

const HUMAN = "c2a8cc92-cab6-4536-9500-0f24abdf702b";
const OTHER_HUMAN = "99999999-0000-0000-0000-000000000000";

let dir;
let dbPath;

// Seed a minimal issues+comments replica shaped like the live one (measured schema:
// comments carries id, issue_id, body, updated_at, removed_at, author_id,
// author_name, author_avatar_url, is_bot, parent_id, created_at).
function seed(rows) {
  const db = new Database(dbPath);
  db.run(`CREATE TABLE issues (id TEXT PRIMARY KEY, identifier TEXT, title TEXT, removed_at INTEGER)`);
  db.run(
    `CREATE TABLE comments (id TEXT PRIMARY KEY, issue_id TEXT, body TEXT, updated_at INTEGER,
       removed_at INTEGER, author_id TEXT, author_name TEXT, author_avatar_url TEXT,
       is_bot INTEGER, parent_id TEXT, created_at INTEGER)`
  );
  db.run(`INSERT INTO issues (id, identifier, title, removed_at) VALUES (?,?,?,?)`, [
    "issue-1",
    "CTL-1",
    "Test issue",
    null,
  ]);
  const stmt = db.prepare(
    `INSERT INTO comments (id, issue_id, body, removed_at, author_id, is_bot, parent_id, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  for (const r of rows) {
    stmt.run(
      r.id,
      r.issue_id ?? "issue-1",
      r.body ?? "b",
      r.removed_at ?? null,
      r.author_id ?? HUMAN,
      r.is_bot ?? 0,
      r.parent_id ?? null,
      r.created_at
    );
  }
  db.close();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctl1958-"));
  dbPath = join(dir, "catalyst-replica.db");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readLatestHumanComment", () => {
  test("1. returns {id, parentId} for the newest matching human comment", async () => {
    seed([
      { id: "c-old", author_id: HUMAN, is_bot: 0, created_at: 100 },
      { id: "c-new", author_id: HUMAN, is_bot: 0, created_at: 300 },
      { id: "c-mid", author_id: HUMAN, is_bot: 0, created_at: 200 },
    ]);
    const got = await readLatestHumanComment({ dbPath, identifier: "CTL-1", humanId: HUMAN });
    expect(got).toEqual({ id: "c-new", parentId: "c-new" });
  });

  test("2. parentId is parent_id when set, else the comment's own id (thread-root rule)", async () => {
    seed([{ id: "c-reply", author_id: HUMAN, parent_id: "c-root", created_at: 500 }]);
    const got = await readLatestHumanComment({ dbPath, identifier: "CTL-1", humanId: HUMAN });
    expect(got).toEqual({ id: "c-reply", parentId: "c-root" });
  });

  test("2b. an empty-string parent_id (replica's root shape) resolves to own id, NOT ''", async () => {
    seed([{ id: "c-root", author_id: HUMAN, parent_id: "", created_at: 500 }]);
    const got = await readLatestHumanComment({ dbPath, identifier: "CTL-1", humanId: HUMAN });
    expect(got).toEqual({ id: "c-root", parentId: "c-root" });
  });

  test("3. returns null when the issue has no matching human comment (never throws)", async () => {
    seed([{ id: "c-bot", author_id: HUMAN, is_bot: 1, created_at: 100 }]);
    const got = await readLatestHumanComment({ dbPath, identifier: "CTL-1", humanId: HUMAN });
    expect(got).toBeNull();
  });

  test("4. ignores is_bot=1 and other-author rows (positive control)", async () => {
    seed([
      { id: "c-bot", author_id: HUMAN, is_bot: 1, created_at: 900 }, // newest, but a bot
      { id: "c-other", author_id: OTHER_HUMAN, is_bot: 0, created_at: 800 }, // human, wrong id
      { id: "c-target", author_id: HUMAN, is_bot: 0, created_at: 700 }, // the one we want
    ]);
    const got = await readLatestHumanComment({ dbPath, identifier: "CTL-1", humanId: HUMAN });
    expect(got).toEqual({ id: "c-target", parentId: "c-target" });
  });

  test("5. ignores removed_at IS NOT NULL rows", async () => {
    seed([
      { id: "c-removed", author_id: HUMAN, is_bot: 0, removed_at: 1234, created_at: 900 },
      { id: "c-live", author_id: HUMAN, is_bot: 0, created_at: 400 },
    ]);
    const got = await readLatestHumanComment({ dbPath, identifier: "CTL-1", humanId: HUMAN });
    expect(got).toEqual({ id: "c-live", parentId: "c-live" });
  });

  test("6. throws a NAMED error (not a falsy sentinel) when the DB is absent/unreadable", async () => {
    const missing = join(dir, "does-not-exist.db");
    let thrown;
    try {
      await readLatestHumanComment({ dbPath: missing, identifier: "CTL-1", humanId: HUMAN });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ReplicaUnavailableError);
    expect(thrown.name).toBe("ReplicaUnavailableError");
    expect(thrown.dbPath).toBe(missing);
  });

  test("humanId defaults to the ASK_HUMAN_ID sentinel", async () => {
    expect(DEFAULT_ASK_HUMAN_ID).toBe(HUMAN);
    seed([{ id: "c-def", author_id: HUMAN, is_bot: 0, created_at: 600 }]);
    const got = await readLatestHumanComment({ dbPath, identifier: "CTL-1" });
    expect(got).toEqual({ id: "c-def", parentId: "c-def" });
  });
});

describe("readIssueId", () => {
  test("returns the issue's internal id for a live identifier, null when absent", async () => {
    seed([{ id: "c-1", author_id: HUMAN, created_at: 1 }]);
    expect(await readIssueId({ dbPath, identifier: "CTL-1" })).toBe("issue-1");
    expect(await readIssueId({ dbPath, identifier: "CTL-404" })).toBeNull();
  });

  test("throws a NAMED error when the DB is absent/unreadable", async () => {
    const missing = join(dir, "nope.db");
    let thrown;
    try {
      await readIssueId({ dbPath: missing, identifier: "CTL-1" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ReplicaUnavailableError);
  });
});

describe("isReplicaCurrent (freshness — reused isReplicaFresh gate)", () => {
  test("7. a just-written replica is current; a backdated one surfaces as stale", async () => {
    seed([{ id: "c-1", author_id: HUMAN, created_at: 1 }]);
    expect(isReplicaCurrent(dbPath)).toBe(true);
    // Backdate the file mtime well past the default 5-min threshold.
    const old = new Date(Date.now() - 30 * 60 * 1000);
    utimesSync(dbPath, old, old);
    expect(isReplicaCurrent(dbPath)).toBe(false);
  });

  test("an absent replica is not current (never throws here — the read path throws)", () => {
    expect(isReplicaCurrent(join(dir, "absent.db"))).toBe(false);
  });
});
