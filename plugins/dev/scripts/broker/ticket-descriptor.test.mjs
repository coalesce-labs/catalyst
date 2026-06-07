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

  test("partial upsert is COALESCE-sticky — absent fields survive", () => {
    upsertTicketDescriptor(FULL);
    upsertTicketDescriptor({ ticket: "CTL-821", state: "Todo" });
    const d = getTicketDescriptor("CTL-821");
    expect(d.state).toBe("Todo");
    expect(d.labels).toEqual(["feature", "broker"]);
    expect(d.assignee).toBe(FULL.assignee);
    expect(d.uuid).toBe(FULL.uuid);
    expect(d.priority).toBe(2);
  });

  test("unknown ticket reads null", () => {
    expect(getTicketDescriptor("CTL-0")).toBeNull();
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
