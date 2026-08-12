// webhook-replica-writer.test.mjs — CAT-152. Real temp-file bun:sqlite DBs
// (applyMigrations/applyDelta need a real engine), never the fleet's actual
// ~/catalyst/catalyst-replica.db, never a live Linear API call.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createWebhookReplicaWriter, defaultListIssues } from "./webhook-replica-writer.mjs";

describe("defaultListIssues", () => {
  test("builds the bounded single-page linearis argv and parses .nodes[]", () => {
    let captured;
    const spawn = (bin, args) => {
      captured = { bin, args };
      return { status: 0, stdout: JSON.stringify({ nodes: [{ identifier: "CTL-1" }] }) };
    };
    const rows = defaultListIssues("CTL", { spawn });
    expect(captured.bin).toBe("linearis");
    expect(captured.args).toEqual(["issues", "list", "--team", "CTL", "--limit", "200"]);
    expect(rows).toEqual([{ identifier: "CTL-1" }]);
  });

  test("fail-open: non-zero exit → []", () => {
    const spawn = () => ({ status: 1, stdout: "" });
    expect(defaultListIssues("CTL", { spawn })).toEqual([]);
  });

  test("fail-open: unparseable stdout → []", () => {
    const spawn = () => ({ status: 0, stdout: "not json" });
    expect(defaultListIssues("CTL", { spawn })).toEqual([]);
  });
});

describe("createWebhookReplicaWriter", () => {
  let dir, dbPath;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cat152-"));
    dbPath = join(dir, "replica.db");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("construction creates the writer lock and the sync_meta table", () => {
    const writer = createWebhookReplicaWriter({ dbPath, ownerKey: "test-host-account" });
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_meta'").get();
    expect(row?.name).toBe("sync_meta");
    db.close();
    writer.close();
  });

  test("a second writer on the SAME dbPath with a DIFFERENT ownerKey throws (single-writer contract)", () => {
    const w1 = createWebhookReplicaWriter({ dbPath, ownerKey: "host-a" });
    expect(() => createWebhookReplicaWriter({ dbPath, ownerKey: "host-b" })).toThrow();
    w1.close();
  });

  test("reclaiming a crashed predecessor's lock (SAME ownerKey, stale pid) does not throw with the default log", () => {
    // Regression for a fleet incident: a stale lock file left behind by a
    // dead process with the SAME ownerKey (as happens on every restart of
    // this writer) hits claimWriterLock's FAST-RECLAIM path, which calls
    // `log?.("info", ...)`. The old default (`log = console`) isn't callable
    // that way and threw a TypeError instead of reclaiming — wedging the
    // replica: every write after a restart silently failed forever.
    const lockPath = `${dbPath}.writer.lock`;
    writeFileSync(lockPath, JSON.stringify({
      pid: 999999, owner: "999999-deadbeef", heartbeat: Date.now(), ownerKey: "same-host-account",
    }));
    let writer;
    expect(() => {
      writer = createWebhookReplicaWriter({ dbPath, ownerKey: "same-host-account" });
    }).not.toThrow();
    writer.close();
  });

  test("applyEvent(issue) writes a queryable row via applyDelta", () => {
    const writer = createWebhookReplicaWriter({ dbPath, ownerKey: "test-host-account" });
    writer.applyEvent({
      kind: "issue", action: "create", ticket: "CTL-210", issueId: "uuid-1",
      data: { id: "uuid-1", identifier: "CTL-210", title: "Webhook replica", state: { name: "Todo" }, priority: 2 },
    });
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT identifier, title, state, priority FROM issues WHERE identifier='CTL-210'").get();
    expect(row).toEqual({ identifier: "CTL-210", title: "Webhook replica", state: "Todo", priority: 2 });
    db.close();
    writer.close();
  });

  test("applyEvent(issue) with labels also writes issue_labels + labels rows", () => {
    const writer = createWebhookReplicaWriter({ dbPath, ownerKey: "test-host-account" });
    writer.applyEvent({
      kind: "issue", action: "update", ticket: "CTL-210", issueId: "uuid-1",
      data: { id: "uuid-1", identifier: "CTL-210", title: "t", state: { name: "Todo" },
        labels: [{ id: "lbl-1", name: "bug", color: "#f00" }] },
    });
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT name FROM labels WHERE id='lbl-1'").get()).toEqual({ name: "bug" });
    expect(db.query("SELECT issue_id, label_id FROM issue_labels").get()).toEqual({ issue_id: "uuid-1", label_id: "lbl-1" });
    db.close();
    writer.close();
  });

  test("applyEvent(issue, remove) soft-deletes the row (removed_at set)", () => {
    const writer = createWebhookReplicaWriter({ dbPath, ownerKey: "test-host-account" });
    writer.applyEvent({ kind: "issue", action: "create", ticket: "CTL-210", issueId: "uuid-1",
      data: { id: "uuid-1", identifier: "CTL-210", title: "t", state: { name: "Todo" } } });
    writer.applyEvent({ kind: "issue", action: "remove", issueId: "uuid-1", data: {} });
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT removed_at FROM issues WHERE identifier='CTL-210'").get();
    expect(row.removed_at).not.toBeNull();
    db.close();
    writer.close();
  });

  test("applyEvent(comment) writes a queryable comments row", () => {
    const writer = createWebhookReplicaWriter({ dbPath, ownerKey: "test-host-account" });
    writer.applyEvent({ kind: "comment", action: "create", ticket: "CTL-210", commentId: "c-1", issueId: "uuid-1",
      data: { id: "c-1", issueId: "uuid-1", body: "hi", user: { id: "u1", name: "A" } } });
    const db = new Database(dbPath, { readonly: true });
    expect(db.query("SELECT body FROM comments WHERE id='c-1'").get()).toEqual({ body: "hi" });
    db.close();
    writer.close();
  });

  test("applyEvent ignores an out-of-scope kind (e.g. cycle) without throwing", () => {
    const writer = createWebhookReplicaWriter({ dbPath, ownerKey: "test-host-account" });
    expect(() => writer.applyEvent({ kind: "cycle", action: "create", cycleId: "cy-1", data: {} })).not.toThrow();
    writer.close();
  });

  test("backfillTeam writes a non-empty sync_meta.cursor via a single bounded listIssues call", async () => {
    const writer = createWebhookReplicaWriter({ dbPath, ownerKey: "test-host-account" });
    const fakeListIssues = async () => [
      { id: "uuid-9", identifier: "CTL-9", title: "seeded", state: { name: "Todo" } },
    ];
    await writer.backfillTeam("CTL", { listIssues: fakeListIssues });
    const db = new Database(dbPath, { readonly: true });
    const cursorRow = db.query("SELECT value FROM sync_meta WHERE key='cursor'").get();
    expect(cursorRow?.value?.length).toBeGreaterThan(0);
    expect(db.query("SELECT identifier FROM issues WHERE identifier='CTL-9'").get()).toEqual({ identifier: "CTL-9" });
    db.close();
    writer.close();
  });

  test("backfillTeam never calls listIssues more than once per call (bounded, single page)", async () => {
    const writer = createWebhookReplicaWriter({ dbPath, ownerKey: "test-host-account" });
    let calls = 0;
    const fakeListIssues = async () => { calls += 1; return []; };
    await writer.backfillTeam("CTL", { listIssues: fakeListIssues });
    expect(calls).toBe(1);
    writer.close();
  });
});
