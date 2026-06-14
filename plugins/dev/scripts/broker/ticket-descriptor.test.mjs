// Unit tests for the CTL-821 Gateway descriptor schema (L1 child a).
// ticket_state grows from the 4-column routing index to the full descriptor
// {state, relations, labels, priority, resolution, assignee, uuid, updated_at}
// + a removed flag, via the CTL-402 additive-ALTER pattern, plus the
// UUID→identifier index that Linear's `remove` webhook payload requires
// (it carries only the entityId UUID, never the CTL-123 identifier).
// Run: bun test plugins/dev/scripts/broker/ticket-descriptor.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertTicketState,
  getTicketState,
  upsertTicketDescriptor,
  getTicketDescriptor,
  getAllTicketDescriptors,
  getTicketDescriptorByUuid,
  markTicketRemovedByUuid,
} from "./broker-state.mjs";

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ticket-descriptor-test-"));
  dbPath = join(tmpDir, "test.db");
  openBrokerStateDb(dbPath);
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const FULL = {
  ticket: "CTL-821",
  state: "Backlog",
  prNumber: 1400,
  relations: [{ type: "blocks", id: "CTL-780" }],
  labels: ["feature", "broker"],
  priority: 2,
  resolution: "exists",
  assignee: "ff78d890-7906-4c22-b2f5-020bd150c790",
  uuid: "11111111-2222-3333-4444-555555555555",
};

// ─── descriptor round-trip ───────────────────────────────────────────────────

describe("upsertTicketDescriptor / getTicketDescriptor", () => {
  test("full descriptor round-trips, removed defaults false", () => {
    upsertTicketDescriptor(FULL);
    const d = getTicketDescriptor("CTL-821");
    expect(d.ticket).toBe("CTL-821");
    expect(d.state).toBe("Backlog");
    expect(d.prNumber).toBe(1400);
    expect(d.relations).toEqual([{ type: "blocks", id: "CTL-780" }]);
    expect(d.labels).toEqual(["feature", "broker"]);
    expect(d.priority).toBe(2);
    expect(d.resolution).toBe("exists");
    expect(d.assignee).toBe(FULL.assignee);
    expect(d.uuid).toBe(FULL.uuid);
    expect(d.removed).toBe(false);
    expect(d.removedAt).toBeNull();
    expect(d.updatedAt).toBeTruthy();
  });

  test("key-presence: absent fields survive a partial upsert", () => {
    upsertTicketDescriptor(FULL);
    upsertTicketDescriptor({ ticket: "CTL-821", state: "Todo" });
    const d = getTicketDescriptor("CTL-821");
    expect(d.state).toBe("Todo");
    expect(d.labels).toEqual(["feature", "broker"]);
    expect(d.assignee).toBe(FULL.assignee);
    expect(d.uuid).toBe(FULL.uuid);
    expect(d.priority).toBe(2);
  });

  test("key-presence: explicit null CLEARS a field (Linear unassign webhook)", () => {
    upsertTicketDescriptor(FULL);
    upsertTicketDescriptor({ ticket: "CTL-821", assignee: null });
    const d = getTicketDescriptor("CTL-821");
    expect(d.assignee).toBeNull();
    // siblings untouched
    expect(d.uuid).toBe(FULL.uuid);
    expect(d.labels).toEqual(["feature", "broker"]);
  });

  test("priority can go back to 0 (Linear no-priority) and to null", () => {
    upsertTicketDescriptor(FULL);
    upsertTicketDescriptor({ ticket: "CTL-821", priority: 0 });
    expect(getTicketDescriptor("CTL-821").priority).toBe(0);
    upsertTicketDescriptor({ ticket: "CTL-821", priority: null });
    expect(getTicketDescriptor("CTL-821").priority).toBeNull();
  });

  test("pre-stringified JSON for relations/labels throws loud", () => {
    expect(() =>
      upsertTicketDescriptor({ ticket: "CTL-821", relations: '[{"type":"blocks"}]' })
    ).toThrow(TypeError);
    expect(() => upsertTicketDescriptor({ ticket: "CTL-821", labels: '["bug"]' })).toThrow(
      TypeError
    );
  });

  test("unknown ticket reads null", () => {
    expect(getTicketDescriptor("CTL-0")).toBeNull();
  });

  test("duplicate uuid on a second ticket fails loud (UNIQUE index)", () => {
    upsertTicketDescriptor(FULL);
    expect(() => upsertTicketDescriptor({ ticket: "CTL-999", uuid: FULL.uuid })).toThrow();
  });
});

// ─── bulk read (CTL-883 read-model cache) ────────────────────────────────────

describe("getAllTicketDescriptors", () => {
  test("returns every present descriptor in one pass, ticket-sorted", () => {
    upsertTicketDescriptor({ ticket: "CTL-3", state: "Implement", priority: 2 });
    upsertTicketDescriptor({ ticket: "CTL-1", state: "Done", labels: ["feature"] });
    upsertTicketDescriptor({ ticket: "CTL-2", state: "PR", assignee: "bot" });
    const all = getAllTicketDescriptors();
    expect(all.map((d) => d.ticket)).toEqual(["CTL-1", "CTL-2", "CTL-3"]);
    const byId = Object.fromEntries(all.map((d) => [d.ticket, d]));
    expect(byId["CTL-1"].labels).toEqual(["feature"]);
    expect(byId["CTL-2"].assignee).toBe("bot");
    expect(byId["CTL-3"].priority).toBe(2);
  });

  test("empty table yields an empty array", () => {
    expect(getAllTicketDescriptors()).toEqual([]);
  });

  test("removed rows are excluded by default, included on request", () => {
    upsertTicketDescriptor({ ticket: "CTL-10", uuid: "u-10", state: "Done" });
    upsertTicketDescriptor({ ticket: "CTL-11", uuid: "u-11", state: "Todo" });
    markTicketRemovedByUuid("u-10");
    const present = getAllTicketDescriptors();
    expect(present.map((d) => d.ticket)).toEqual(["CTL-11"]);
    const withRemoved = getAllTicketDescriptors({ includeRemoved: true });
    expect(withRemoved.map((d) => d.ticket)).toEqual(["CTL-10", "CTL-11"]);
    expect(withRemoved.find((d) => d.ticket === "CTL-10").removed).toBe(true);
  });
});

// ─── UUID → identifier index ─────────────────────────────────────────────────

describe("getTicketDescriptorByUuid", () => {
  test("resolves a descriptor row by its Linear entityId UUID", () => {
    upsertTicketDescriptor(FULL);
    const d = getTicketDescriptorByUuid(FULL.uuid);
    expect(d?.ticket).toBe("CTL-821");
  });

  test("unknown uuid resolves null", () => {
    expect(getTicketDescriptorByUuid("dead-beef")).toBeNull();
  });

  test("matches uuid only — a ticket IDENTIFIER does not resolve", () => {
    upsertTicketDescriptor(FULL);
    expect(getTicketDescriptorByUuid("CTL-821")).toBeNull();
  });
});

// ─── removed flag lifecycle ──────────────────────────────────────────────────

describe("markTicketRemovedByUuid", () => {
  test("flags the row removed and returns the resolved identifier", () => {
    upsertTicketDescriptor(FULL);
    const res = markTicketRemovedByUuid(FULL.uuid);
    expect(res).toEqual({ ticket: "CTL-821" });
    const d = getTicketDescriptor("CTL-821");
    expect(d.removed).toBe(true);
    expect(d.removedAt).toBeTruthy();
  });

  test("unknown uuid is a null no-op", () => {
    expect(markTicketRemovedByUuid("not-there")).toBeNull();
  });

  test("a later upsert with removed:false resurrects (archive→unarchive)", () => {
    upsertTicketDescriptor(FULL);
    markTicketRemovedByUuid(FULL.uuid);
    upsertTicketDescriptor({ ticket: "CTL-821", removed: false });
    const d = getTicketDescriptor("CTL-821");
    expect(d.removed).toBe(false);
    expect(d.removedAt).toBeNull();
  });

  test("upsert without removed never clears an existing removed flag", () => {
    upsertTicketDescriptor(FULL);
    markTicketRemovedByUuid(FULL.uuid);
    upsertTicketDescriptor({ ticket: "CTL-821", state: "Canceled" });
    expect(getTicketDescriptor("CTL-821").removed).toBe(true);
  });

  test("removed_at is sticky — a duplicate removal keeps the FIRST timestamp", () => {
    upsertTicketDescriptor(FULL);
    markTicketRemovedByUuid(FULL.uuid);
    const first = getTicketDescriptor("CTL-821").removedAt;
    Bun.sleepSync(5); // ensure a later wall-clock would differ if overwritten
    markTicketRemovedByUuid(FULL.uuid);
    upsertTicketDescriptor({ ticket: "CTL-821", removed: true });
    expect(getTicketDescriptor("CTL-821").removedAt).toBe(first);
  });

  test("insert-then-remove path: brand-new row with removed:true lands removed", () => {
    upsertTicketDescriptor({ ticket: "CTL-NEW", uuid: "u-new", removed: true });
    const d = getTicketDescriptor("CTL-NEW");
    expect(d.removed).toBe(true);
    expect(d.removedAt).toBeTruthy();
  });
});

// ─── additive migration on an existing legacy DB ─────────────────────────────

describe("schema migration", () => {
  test("ALTER-on-existing-DB preserves legacy rows; descriptor fields default null", () => {
    closeBrokerStateDb();
    rmSync(dbPath, { force: true });
    // Hand-create a LEGACY 4-column ticket_state with one row, as a pre-CTL-821
    // filter-state.db would have it.
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`
      CREATE TABLE ticket_state (
        ticket       TEXT PRIMARY KEY,
        linear_state TEXT,
        pr_number    INTEGER,
        updated_at   TEXT NOT NULL
      )
    `);
    legacy.run(`INSERT INTO ticket_state VALUES ('CTL-100', 'Done', 999, '2026-01-01T00:00:00Z')`);
    legacy.close();

    openBrokerStateDb(dbPath);
    const d = getTicketDescriptor("CTL-100");
    expect(d.state).toBe("Done");
    expect(d.prNumber).toBe(999);
    expect(d.relations).toBeNull();
    expect(d.labels).toBeNull();
    expect(d.assignee).toBeNull();
    expect(d.uuid).toBeNull();
    expect(d.removed).toBe(false);
    // and the migrated row accepts descriptor writes
    upsertTicketDescriptor({ ticket: "CTL-100", uuid: "u-100", labels: ["bug"] });
    expect(getTicketDescriptorByUuid("u-100")?.ticket).toBe("CTL-100");
  });

  test("re-opening an already-migrated DB is a no-op (idempotent ALTERs)", () => {
    upsertTicketDescriptor(FULL);
    closeBrokerStateDb();
    openBrokerStateDb(dbPath);
    expect(getTicketDescriptor("CTL-821").uuid).toBe(FULL.uuid);
  });

  test("PARTIALLY-migrated DB (aborted earlier boot) self-heals on open", () => {
    closeBrokerStateDb();
    rmSync(dbPath, { force: true });
    // Legacy 4 columns plus a SUBSET of the new ones — as if a prior boot's
    // ALTER loop died midway. The next open must add only the missing columns.
    const partial = new Database(dbPath, { create: true });
    partial.run(`
      CREATE TABLE ticket_state (
        ticket       TEXT PRIMARY KEY,
        linear_state TEXT,
        pr_number    INTEGER,
        updated_at   TEXT NOT NULL,
        relations    TEXT,
        labels       TEXT,
        priority     INTEGER
      )
    `);
    partial.run(
      `INSERT INTO ticket_state (ticket, linear_state, pr_number, updated_at, labels)
       VALUES ('CTL-200', 'Todo', NULL, '2026-01-01T00:00:00Z', '["bug"]')`
    );
    partial.close();

    openBrokerStateDb(dbPath);
    const d = getTicketDescriptor("CTL-200");
    expect(d.state).toBe("Todo");
    expect(d.labels).toEqual(["bug"]);
    expect(d.assignee).toBeNull();
    expect(d.removed).toBe(false);
    upsertTicketDescriptor({ ticket: "CTL-200", uuid: "u-200", assignee: "bot" });
    expect(getTicketDescriptorByUuid("u-200")?.assignee).toBe("bot");
  });

  test("corrupt JSON in a descriptor column reads null, never throws", () => {
    upsertTicketDescriptor(FULL);
    closeBrokerStateDb();
    const raw = new Database(dbPath);
    raw.run(`UPDATE ticket_state SET relations = '{not json' WHERE ticket = 'CTL-821'`);
    raw.close();
    openBrokerStateDb(dbPath);
    const d = getTicketDescriptor("CTL-821");
    expect(d.relations).toBeNull();
    expect(d.labels).toEqual(["feature", "broker"]);
  });
});

// ─── legacy API interop ──────────────────────────────────────────────────────

describe("legacy ticket_state API interop", () => {
  test("upsertTicketState still works and never clobbers descriptor fields", () => {
    upsertTicketDescriptor(FULL);
    upsertTicketState({ ticket: "CTL-821", linearState: "PR", prNumber: 1401 });
    const d = getTicketDescriptor("CTL-821");
    expect(d.state).toBe("PR");
    expect(d.prNumber).toBe(1401);
    expect(d.labels).toEqual(["feature", "broker"]);
    expect(d.uuid).toBe(FULL.uuid);
    const legacyView = getTicketState("CTL-821");
    expect(legacyView.linearState).toBe("PR");
    expect(legacyView.prNumber).toBe(1401);
  });
});
