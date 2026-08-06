// ticket-discussion-reader.test.ts — CTL-1574.
//
// Drives readTicketDiscussion against a TEMP bun:sqlite db carrying the minimal
// subset of the CTC replica schema that `@catalyst-cloud/read-model`'s
// buildIssueDetail touches (issues / comments / issue_history / users / labels /
// issue_labels / relations / projects / cycles). Column definitions are copied
// from the live replica's `.schema` so the fixture exercises the real SQL rather
// than a shape we invented.
//
// The point of these cases is the FAILURE contract as much as the happy path: a
// malformed identifier, an unknown ticket, and a missing db must all come back
// `available:false` with empty arrays — never a throw into the route.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTicketDiscussion } from "../lib/ticket-discussion-reader.mjs";

let tmpRoot: string;
let dbPath: string;

// The replica subset buildIssueDetail reads. Trimmed to the columns the builders
// SELECT (plus the primary keys) — a narrower table would fail the real query.
const SCHEMA = `
CREATE TABLE issues (
  id text PRIMARY KEY NOT NULL, identifier text, title text, description text,
  state text, state_id text, assignee text, assignee_id text, priority integer,
  estimate real, project_id text, cycle_id text, team_id text, team_key text,
  team_name text, delegate_id text, delegate_name text, bot_actor_name text,
  bot_actor_type text, bot_actor_sub_type text, parent_id text,
  parent_identifier text, url text, started_at integer, completed_at integer,
  canceled_at integer, created_at integer, due_date text, priority_label text,
  sort_order real, updated_at integer, removed_at integer
);
CREATE TABLE comments (
  id text PRIMARY KEY NOT NULL, issue_id text, body text, updated_at integer,
  removed_at integer, author_id text, author_name text, author_avatar_url text,
  is_bot integer, parent_id text, created_at integer
);
CREATE TABLE issue_history (
  id text PRIMARY KEY NOT NULL, issue_id text NOT NULL, actor_id text,
  created_at integer, updated_at integer, from_state text, to_state text,
  from_assignee_id text, to_assignee_id text, from_priority integer,
  to_priority integer, from_estimate real, to_estimate real, from_title text,
  to_title text, from_cycle_id text, to_cycle_id text, from_project_id text,
  to_project_id text, from_parent_id text, to_parent_id text, from_team_id text,
  to_team_id text, from_due_date text, to_due_date text, added_label_ids text,
  removed_label_ids text, updated_description integer, archived integer,
  auto_archived integer, auto_closed integer, trashed integer
);
CREATE TABLE users (
  id text PRIMARY KEY NOT NULL, name text, display_name text, avatar_url text,
  type text, source text, updated_at integer
);
CREATE TABLE labels (
  id text PRIMARY KEY NOT NULL, name text, color text, updated_at integer,
  removed_at integer
);
CREATE TABLE issue_labels (
  issue_id text NOT NULL, label_id text NOT NULL, PRIMARY KEY (issue_id, label_id)
);
CREATE TABLE relations (
  id text PRIMARY KEY NOT NULL, type text, issue_identifier text,
  related_identifier text, updated_at integer
);
CREATE TABLE projects (
  id text PRIMARY KEY NOT NULL, name text, state text, description text,
  progress real, health text, updated_at integer, removed_at integer
);
CREATE TABLE cycles (
  id text PRIMARY KEY NOT NULL, number integer, name text, starts_at integer,
  ends_at integer, updated_at integer
);
`;

/** Seed a replica with one issue, two comments and three history rows. */
function seed(): void {
  const db = new Database(dbPath, { create: true });
  db.exec(SCHEMA);
  db.run(
    "INSERT INTO issues (id, identifier, title, removed_at) VALUES (?, ?, ?, NULL)",
    ["issue-1", "CTL-1574", "Operators should see a ticket's activity feed"],
  );
  db.run("INSERT INTO users (id, name, avatar_url) VALUES (?, ?, ?)", [
    "user-1",
    "ryan",
    "https://example.invalid/a.png",
  ]);
  db.run("INSERT INTO labels (id, name, color, removed_at) VALUES (?, ?, ?, NULL)", [
    "label-1",
    "needs-human",
    "#e36b6b",
  ]);
  // Oldest-first by updated_at — the order buildIssueDetail returns.
  db.run(
    "INSERT INTO comments (id, issue_id, body, author_id, author_name, is_bot, updated_at, removed_at) VALUES (?,?,?,?,?,?,?,NULL)",
    ["comment-1", "issue-1", "First turn.", "user-1", "ryan", 0, 1000],
  );
  db.run(
    "INSERT INTO comments (id, issue_id, body, author_id, author_name, is_bot, updated_at, removed_at) VALUES (?,?,?,?,?,?,?,NULL)",
    ["comment-2", "issue-1", "Agent reply.", null, "Catalyst", 1, 3000],
  );
  // A REMOVED comment must not surface (the read-model filters removed_at).
  db.run(
    "INSERT INTO comments (id, issue_id, body, author_name, is_bot, updated_at, removed_at) VALUES (?,?,?,?,?,?,?)",
    ["comment-gone", "issue-1", "Deleted.", "ryan", 0, 2000, 2500],
  );
  db.run(
    "INSERT INTO issue_history (id, issue_id, actor_id, created_at) VALUES (?,?,?,?)",
    ["hist-0", "issue-1", "user-1", 500],
  );
  db.run(
    "INSERT INTO issue_history (id, issue_id, actor_id, created_at, from_state, to_state) VALUES (?,?,?,?,?,?)",
    ["hist-1", "issue-1", "user-1", 2000, "Backlog", "Implement"],
  );
  db.run(
    "INSERT INTO issue_history (id, issue_id, actor_id, created_at, added_label_ids) VALUES (?,?,?,?,?)",
    ["hist-2", "issue-1", "user-1", 4000, JSON.stringify(["label-1"])],
  );
  // Freshness-gate substrate (CTL-1574 review): a live writer heartbeat and a
  // completed seed cursor — the reader refuses stale/mid-reseed replicas.
  db.run("CREATE TABLE sync_meta (key text PRIMARY KEY NOT NULL, value text)");
  db.run("INSERT INTO sync_meta (key, value) VALUES ('cursor', 'cursor-1')");
  db.close();
  writeFileSync(`${dbPath}.writer.lock`, String(process.pid));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "ctl1574-"));
  dbPath = join(tmpRoot, "catalyst-replica.db");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("readTicketDiscussion", () => {
  it("returns the ticket's live comments oldest-first, with the author fields resolved", async () => {
    seed();
    const out = await readTicketDiscussion("CTL-1574", { dbPath });

    expect(out.available).toBe(true);
    expect(out.identifier).toBe("CTL-1574");
    expect(out.title).toBe("Operators should see a ticket's activity feed");
    expect(out.comments.map((c) => c.id)).toEqual(["comment-1", "comment-2"]);
    expect(out.comments[0]).toMatchObject({
      body: "First turn.",
      author_name: "ryan",
      is_bot: 0,
      updated_at: 1000,
    });
    expect(out.comments[1]).toMatchObject({ author_name: "Catalyst", is_bot: 1 });
  });

  it("returns the activity events oldest-first with actor + label ids resolved to display values", async () => {
    seed();
    const out = await readTicketDiscussion("CTL-1574", { dbPath });

    expect(out.activity.map((e) => e.id)).toEqual(["hist-0", "hist-1", "hist-2"]);
    // Actor resolved from users.
    expect(out.activity[0]).toMatchObject({
      actor_name: "ryan",
      actor_avatar_url: "https://example.invalid/a.png",
      created_at: 500,
    });
    // A state transition carries both ends as raw state NAMES.
    expect(out.activity[1]).toMatchObject({ from_state: "Backlog", to_state: "Implement" });
    // Label ids resolve to {id,name,color}; the untouched side stays [].
    expect(out.activity[2].added_labels).toEqual([
      { id: "label-1", name: "needs-human", color: "#e36b6b" },
    ]);
    expect(out.activity[2].removed_labels).toEqual([]);
  });

  it("reports an unknown ticket as unavailable rather than an empty discussion", async () => {
    seed();
    const out = await readTicketDiscussion("CTL-9999", { dbPath });

    expect(out).toEqual({
      available: false,
      identifier: null,
      title: null,
      createdAt: null,
      comments: [],
      activity: [],
    });
  });

  it("rejects a malformed identifier before touching the db", async () => {
    seed();
    // No opener is provided, and dbPath is omitted — a reader that ran any SQL
    // would fall through to the real replica. It must short-circuit on the regex.
    for (const bad of ["", "CTL", "CTL-", "-1574", "CTL_1574", "CTL-1574; DROP TABLE issues", "../etc"]) {
      const out = await readTicketDiscussion(bad);
      expect(out.available).toBe(false);
      expect(out.comments).toEqual([]);
      expect(out.activity).toEqual([]);
    }
  });

  it("reports unavailable when the writer heartbeat is stale (dead cloud-sync)", async () => {
    seed();
    const old = (Date.now() - 3_600_000) / 1000; // 1h-old heartbeat, threshold 5min
    utimesSync(`${dbPath}.writer.lock`, old, old);
    const out = await readTicketDiscussion("CTL-1574", { dbPath });
    expect(out.available).toBe(false);
    expect(out.comments).toEqual([]);
  });

  it("reports unavailable mid-reseed (sync_meta cursor absent)", async () => {
    seed();
    const db = new Database(dbPath);
    db.run("DELETE FROM sync_meta WHERE key = 'cursor'");
    db.close();
    const out = await readTicketDiscussion("CTL-1574", { dbPath });
    expect(out.available).toBe(false);
    expect(out.comments).toEqual([]);
  });

  it("normalizes ISO-string timestamps to ms epoch (mixed writer versions)", async () => {
    seed();
    const db = new Database(dbPath);
    db.run("UPDATE issues SET created_at = ? WHERE id = 'issue-1'", ["2026-07-30T12:00:00.000Z"]);
    db.run("UPDATE comments SET updated_at = ? WHERE id = 'comment-1'", ["1970-01-01T00:00:01.000Z"]);
    db.run("UPDATE issue_history SET created_at = ? WHERE id = 'hist-0'", ["1970-01-01T00:00:00.500Z"]);
    db.close();
    const out = await readTicketDiscussion("CTL-1574", { dbPath });
    expect(out.createdAt).toBe(Date.parse("2026-07-30T12:00:00.000Z"));
    // Look up by id — a string timestamp also perturbs SQLite's ORDER BY
    // (text sorts after integers), which is exactly why normalization matters.
    expect(out.comments.find((c) => c.id === "comment-1")).toMatchObject({ updated_at: 1000 });
    expect(out.activity.find((e) => e.id === "hist-0")).toMatchObject({ created_at: 500 });
  });

  it("degrades to unavailable when the replica file is missing", async () => {
    // Nothing seeded — the path does not exist.
    const out = await readTicketDiscussion("CTL-1574", { dbPath });
    expect(out.available).toBe(false);
    expect(out.comments).toEqual([]);
  });

  it("degrades to unavailable when opening the db throws", async () => {
    seed();
    const out = await readTicketDiscussion("CTL-1574", {
      dbPath,
      openDb: () => {
        throw new Error("locked");
      },
    });
    expect(out.available).toBe(false);
    expect(out.activity).toEqual([]);
  });

  it("degrades to unavailable when the db has no replica schema", async () => {
    const db = new Database(dbPath, { create: true });
    db.exec("CREATE TABLE unrelated (id text)");
    db.close();

    const out = await readTicketDiscussion("CTL-1574", { dbPath });
    expect(out.available).toBe(false);
  });
});
