// Unit tests for the CTL-923 (BFF11) fence projection + held-since columns on
// ticket_state. The broker projects the cluster-claim catalyst://fence/<TICKET>
// attachment metadata (owner_host/catalyst_generation/phase/claimed_at) and the
// held-label applied-at timestamp into the durable cache so the read-model
// groups by node and renders a real hold duration WITHOUT a live Linear hit.
// Run: bun test plugins/dev/scripts/broker/ticket-fence.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertTicketDescriptor,
  getTicketDescriptor,
  getAllTicketDescriptors,
  upsertTicketFence,
  setTicketHeldSince,
  clearTicketHeldSince,
} from "./broker-state.mjs";

let tmpDir;
let dbPath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ticket-fence-test-"));
  dbPath = join(tmpDir, "test.db");
  openBrokerStateDb(dbPath);
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const FENCE = {
  ticket: "CTL-845",
  ownerHost: "mac-mini",
  generation: 3,
  phase: "implement",
  claimedAt: "2026-06-08T10:00:00.000Z",
};

// ─── fence projection ────────────────────────────────────────────────────────

describe("upsertTicketFence / getTicketDescriptor (Scenario: Fence metadata lands in the cache)", () => {
  test("full fence metadata round-trips onto the descriptor", () => {
    upsertTicketFence(FENCE);
    const d = getTicketDescriptor("CTL-845");
    expect(d.ownerHost).toBe("mac-mini");
    expect(d.generation).toBe(3);
    expect(d.fencePhase).toBe("implement");
    expect(d.claimedAt).toBe("2026-06-08T10:00:00.000Z");
  });

  test("a brand-new row is created if no descriptor exists yet", () => {
    // The fence can land before any other webhook for the ticket.
    expect(getTicketDescriptor("CTL-845")).toBeNull();
    upsertTicketFence(FENCE);
    const d = getTicketDescriptor("CTL-845");
    expect(d.ticket).toBe("CTL-845");
    expect(d.ownerHost).toBe("mac-mini");
    // descriptor fields it did not set stay null (honest absence)
    expect(d.state).toBeNull();
    expect(d.labels).toBeNull();
  });

  test("fence projection never clobbers existing descriptor fields", () => {
    upsertTicketDescriptor({ ticket: "CTL-845", state: "Implement", labels: ["feature"] });
    upsertTicketFence(FENCE);
    const d = getTicketDescriptor("CTL-845");
    expect(d.state).toBe("Implement");
    expect(d.labels).toEqual(["feature"]);
    expect(d.ownerHost).toBe("mac-mini");
    expect(d.generation).toBe(3);
  });

  test("key-presence: absent fields survive a partial fence upsert", () => {
    upsertTicketFence(FENCE);
    upsertTicketFence({ ticket: "CTL-845", generation: 4 });
    const d = getTicketDescriptor("CTL-845");
    expect(d.generation).toBe(4); // bumped
    expect(d.ownerHost).toBe("mac-mini"); // kept
    expect(d.fencePhase).toBe("implement"); // kept
  });

  test("explicit null CLEARS a fence field (release / takeover dropping the owner)", () => {
    upsertTicketFence(FENCE);
    upsertTicketFence({ ticket: "CTL-845", ownerHost: null, generation: null });
    const d = getTicketDescriptor("CTL-845");
    expect(d.ownerHost).toBeNull();
    expect(d.generation).toBeNull();
    expect(d.fencePhase).toBe("implement"); // untouched sibling
  });

  test("a takeover bumps the generation past the dead owner", () => {
    upsertTicketFence({ ...FENCE, ownerHost: "mac-mini", generation: 3 });
    upsertTicketFence({ ticket: "CTL-845", ownerHost: "mac-studio", generation: 4 });
    const d = getTicketDescriptor("CTL-845");
    expect(d.ownerHost).toBe("mac-studio");
    expect(d.generation).toBe(4);
  });

  test("upsert with no fence fields and no ticket is a safe no-op", () => {
    expect(() => upsertTicketFence({})).not.toThrow();
    expect(() => upsertTicketFence({ ticket: "CTL-845" })).not.toThrow();
    expect(getTicketDescriptor("CTL-845")).toBeNull();
  });

  test("bulk read carries ownerHost for node-grouping", () => {
    upsertTicketFence({ ticket: "CTL-1", ownerHost: "mac-mini", generation: 1 });
    upsertTicketFence({ ticket: "CTL-2", ownerHost: "mac-studio", generation: 1 });
    upsertTicketDescriptor({ ticket: "CTL-3", state: "Todo" }); // no fence
    const all = getAllTicketDescriptors();
    const byId = Object.fromEntries(all.map((d) => [d.ticket, d]));
    expect(byId["CTL-1"].ownerHost).toBe("mac-mini");
    expect(byId["CTL-2"].ownerHost).toBe("mac-studio");
    expect(byId["CTL-3"].ownerHost).toBeNull(); // honest null, never fabricated
  });
});

// ─── held-since capture ──────────────────────────────────────────────────────

describe("setTicketHeldSince / clearTicketHeldSince (Scenario: Held-since timestamp is captured)", () => {
  test("stamps the supplied applied-at timestamp", () => {
    setTicketHeldSince("CTL-845", "2026-06-08T09:00:00.000Z");
    expect(getTicketDescriptor("CTL-845").heldSince).toBe("2026-06-08T09:00:00.000Z");
  });

  test("falls back to now() when no timestamp is supplied", () => {
    const before = new Date().toISOString();
    setTicketHeldSince("CTL-845");
    const hs = getTicketDescriptor("CTL-845").heldSince;
    expect(hs).toBeTruthy();
    expect(hs >= before).toBe(true);
  });

  test("held_since is STICKY — a duplicate hold keeps the FIRST timestamp", () => {
    setTicketHeldSince("CTL-845", "2026-06-08T09:00:00.000Z");
    Bun.sleepSync(5);
    setTicketHeldSince("CTL-845", "2026-06-08T11:00:00.000Z");
    // first hold start survives so the duration measures from the real start
    expect(getTicketDescriptor("CTL-845").heldSince).toBe("2026-06-08T09:00:00.000Z");
  });

  test("clear nulls held_since; the next hold re-stamps fresh", () => {
    setTicketHeldSince("CTL-845", "2026-06-08T09:00:00.000Z");
    clearTicketHeldSince("CTL-845");
    expect(getTicketDescriptor("CTL-845").heldSince).toBeNull();
    setTicketHeldSince("CTL-845", "2026-06-08T12:00:00.000Z");
    expect(getTicketDescriptor("CTL-845").heldSince).toBe("2026-06-08T12:00:00.000Z");
  });

  test("held_since never clobbers descriptor or fence fields", () => {
    upsertTicketFence(FENCE);
    upsertTicketDescriptor({ ticket: "CTL-845", labels: ["blocked"] });
    setTicketHeldSince("CTL-845", "2026-06-08T09:00:00.000Z");
    const d = getTicketDescriptor("CTL-845");
    expect(d.heldSince).toBe("2026-06-08T09:00:00.000Z");
    expect(d.ownerHost).toBe("mac-mini");
    expect(d.labels).toEqual(["blocked"]);
  });

  test("clear on an absent / already-clear row is a safe no-op", () => {
    expect(() => clearTicketHeldSince("CTL-ghost")).not.toThrow();
    expect(getTicketDescriptor("CTL-ghost")).toBeNull();
  });

  test("a held-since-only stamp creates the row with null everything else", () => {
    setTicketHeldSince("CTL-NEW", "2026-06-08T09:00:00.000Z");
    const d = getTicketDescriptor("CTL-NEW");
    expect(d.heldSince).toBe("2026-06-08T09:00:00.000Z");
    expect(d.ownerHost).toBeNull();
    expect(d.state).toBeNull();
  });
});

// ─── Scenario: Absent data is honest ─────────────────────────────────────────

describe("Scenario: Absent data is honest", () => {
  test("a plain descriptor with no fence/held label has null fence + held fields", () => {
    upsertTicketDescriptor({ ticket: "CTL-300", state: "Todo", labels: ["feature"] });
    const d = getTicketDescriptor("CTL-300");
    expect(d.ownerHost).toBeNull();
    expect(d.generation).toBeNull();
    expect(d.fencePhase).toBeNull();
    expect(d.claimedAt).toBeNull();
    expect(d.heldSince).toBeNull();
  });
});

// ─── additive migration ──────────────────────────────────────────────────────

describe("schema migration (additive ALTERs, CTL-821 pattern)", () => {
  test("legacy DB without fence columns migrates in place, fields default null", () => {
    closeBrokerStateDb();
    rmSync(dbPath, { force: true });
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`
      CREATE TABLE ticket_state (
        ticket       TEXT PRIMARY KEY,
        linear_state TEXT,
        pr_number    INTEGER,
        updated_at   TEXT NOT NULL,
        labels       TEXT
      )
    `);
    legacy.run(
      `INSERT INTO ticket_state (ticket, linear_state, pr_number, updated_at, labels)
       VALUES ('CTL-100', 'Implement', NULL, '2026-01-01T00:00:00Z', '["feature"]')`
    );
    legacy.close();

    openBrokerStateDb(dbPath);
    const d = getTicketDescriptor("CTL-100");
    expect(d.state).toBe("Implement");
    expect(d.labels).toEqual(["feature"]);
    expect(d.ownerHost).toBeNull();
    expect(d.generation).toBeNull();
    expect(d.heldSince).toBeNull();
    // and the migrated row accepts fence + held writes
    upsertTicketFence({ ticket: "CTL-100", ownerHost: "mac-mini", generation: 2 });
    setTicketHeldSince("CTL-100", "2026-06-08T09:00:00.000Z");
    const after = getTicketDescriptor("CTL-100");
    expect(after.ownerHost).toBe("mac-mini");
    expect(after.heldSince).toBe("2026-06-08T09:00:00.000Z");
  });

  test("re-opening an already-migrated DB is idempotent", () => {
    upsertTicketFence(FENCE);
    closeBrokerStateDb();
    openBrokerStateDb(dbPath);
    expect(getTicketDescriptor("CTL-845").ownerHost).toBe("mac-mini");
  });
});
