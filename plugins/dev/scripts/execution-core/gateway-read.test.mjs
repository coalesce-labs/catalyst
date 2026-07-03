// Tests for gateway-read.mjs (CTL-823) — the daemon's readonly client over
// the broker's durable descriptor store. The fixture DB is built with the
// REAL broker module (cross-package import, test-setup only) so the schema
// under test is the actual CTL-821 schema, not a hand-rolled imitation.
// Run: bun test plugins/dev/scripts/execution-core/gateway-read.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  upsertTicketDescriptor,
  upsertTicketFence,
  markTicketRemovedByUuid,
} from "../broker/broker-state.mjs";
import {
  createGatewayReader,
  descriptorAgeMs,
  claimedAtAgeMs,
  gatewayLabelsHit,
  gatewayFence,
} from "./gateway-read.mjs";

let tmpDir;
let dbPath;
let reader;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gateway-read-test-"));
  dbPath = join(tmpDir, "filter-state.db");
});

afterEach(() => {
  reader?.close();
  reader = null;
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function seed() {
  openBrokerStateDb(dbPath);
  upsertTicketDescriptor({
    ticket: "CTL-1",
    state: "Todo",
    priority: 2,
    assignee: "user-1",
    labels: ["feature"],
    uuid: "u-1",
  });
}

describe("createGatewayReader", () => {
  test("reads a descriptor written by the broker (concurrent WAL reader)", () => {
    seed(); // broker handle stays OPEN — proves reader works alongside the writer
    reader = createGatewayReader({ dbPath });
    const d = reader.getDescriptor("CTL-1");
    expect(d.state).toBe("Todo");
    expect(d.priority).toBe(2);
    expect(d.assignee).toBe("user-1");
    expect(d.labels).toEqual(["feature"]);
    expect(d.uuid).toBe("u-1");
    expect(d.removed).toBe(false);
    expect(d.updatedAt).toBeTruthy();
  });

  test("sees the broker's removed flag", () => {
    seed();
    markTicketRemovedByUuid("u-1");
    reader = createGatewayReader({ dbPath });
    expect(reader.getDescriptor("CTL-1").removed).toBe(true);
  });

  test("absent row reads null (NOT a non-existence proof)", () => {
    seed();
    reader = createGatewayReader({ dbPath });
    expect(reader.getDescriptor("CTL-404")).toBeNull();
  });

  test("missing DB file fails open with null, then recovers once created", () => {
    reader = createGatewayReader({ dbPath });
    expect(reader.getDescriptor("CTL-1")).toBeNull();
    seed(); // broker creates + migrates the DB after the failed read
    expect(reader.getDescriptor("CTL-1")?.state).toBe("Todo");
  });

  test("pre-CTL-821 legacy schema reads legacy fields, nulls for the rest", () => {
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`
      CREATE TABLE ticket_state (
        ticket       TEXT PRIMARY KEY,
        linear_state TEXT,
        pr_number    INTEGER,
        updated_at   TEXT NOT NULL
      )
    `);
    legacy.run(`INSERT INTO ticket_state VALUES ('CTL-9', 'Done', 7, '2026-01-01T00:00:00Z')`);
    legacy.close();
    reader = createGatewayReader({ dbPath });
    const d = reader.getDescriptor("CTL-9");
    expect(d.state).toBe("Done");
    expect(d.prNumber).toBe(7);
    expect(d.uuid).toBeNull();
    expect(d.removed).toBe(false);
  });

  test("empty/falsy ticket reads null without touching the DB", () => {
    reader = createGatewayReader({ dbPath });
    expect(reader.getDescriptor("")).toBeNull();
    expect(reader.getDescriptor(null)).toBeNull();
  });
});

describe("descriptorAgeMs", () => {
  test("computes age from updatedAt", () => {
    const now = Date.parse("2026-06-07T00:01:00Z");
    expect(descriptorAgeMs({ updatedAt: "2026-06-07T00:00:00Z" }, now)).toBe(60_000);
  });

  test("absent or unparseable updatedAt is Infinity (fails safe as stale)", () => {
    expect(descriptorAgeMs({})).toBe(Infinity);
    expect(descriptorAgeMs(null)).toBe(Infinity);
    expect(descriptorAgeMs({ updatedAt: "not a date" })).toBe(Infinity);
  });
});

describe("handle recovery (dropHandle on query failure)", () => {
  test("DB exists but lacks ticket_state → null; recovers after the broker migrates", () => {
    // open-succeeded-then-query-threw path: an empty DB file opens fine but
    // the SELECT throws. The catch MUST drop the handle so the next call
    // re-opens and sees the broker's migration.
    const empty = new Database(dbPath, { create: true });
    empty.run(`CREATE TABLE unrelated (x INTEGER)`);
    empty.close();
    reader = createGatewayReader({ dbPath });
    expect(reader.getDescriptor("CTL-1")).toBeNull();
    seed(); // broker migrates the SAME file in place (ALTER/CREATE IF NOT EXISTS)
    expect(reader.getDescriptor("CTL-1")?.state).toBe("Todo");
  });
});

describe("gatewayLabelsHit (CTL-1079)", () => {
  const gwWith = (descriptor) => ({ getDescriptor: () => descriptor });

  test("cache hit: returns { ok: true, labels } when row has a labels array", () => {
    const gw = gwWith({ ticket: "CTL-1", removed: false, labels: ["needs-human", "feature"] });
    expect(gatewayLabelsHit(gw, "CTL-1")).toEqual({ ok: true, labels: ["needs-human", "feature"] });
  });

  test("empty labels array is still a hit (explicit empty set)", () => {
    const gw = gwWith({ ticket: "CTL-1", removed: false, labels: [] });
    expect(gatewayLabelsHit(gw, "CTL-1")).toEqual({ ok: true, labels: [] });
  });

  test("miss: null gateway → null", () => {
    expect(gatewayLabelsHit(null, "CTL-1")).toBeNull();
    expect(gatewayLabelsHit(undefined, "CTL-1")).toBeNull();
  });

  test("miss: gateway without getDescriptor → null", () => {
    expect(gatewayLabelsHit({}, "CTL-1")).toBeNull();
  });

  test("miss: absent row (getDescriptor returns null) → null", () => {
    expect(gatewayLabelsHit(gwWith(null), "CTL-1")).toBeNull();
  });

  test("miss: tombstoned row (removed: true) → null", () => {
    const gw = gwWith({ ticket: "CTL-1", removed: true, labels: ["needs-human"] });
    expect(gatewayLabelsHit(gw, "CTL-1")).toBeNull();
  });

  test("miss: labels column null/not-an-array → null", () => {
    expect(gatewayLabelsHit(gwWith({ removed: false, labels: null }), "CTL-1")).toBeNull();
    expect(gatewayLabelsHit(gwWith({ removed: false, labels: "needs-human" }), "CTL-1")).toBeNull();
  });

  test("never throws: getDescriptor that throws → null", () => {
    const gw = { getDescriptor: () => { throw new Error("db gone"); } };
    expect(gatewayLabelsHit(gw, "CTL-1")).toBeNull();
  });
});

// ─── CTL-863: fence read migration ───────────────────────────────────────────

describe("getDescriptor surfaces the fence columns (CTL-863)", () => {
  test("a fenced row exposes ownerHost/generation/fencePhase/claimedAt", () => {
    openBrokerStateDb(dbPath);
    upsertTicketFence({
      ticket: "CTL-1",
      ownerHost: "mini",
      generation: 7,
      phase: "implement",
      claimedAt: "2026-07-03T10:00:00Z",
    });
    reader = createGatewayReader({ dbPath });
    const d = reader.getDescriptor("CTL-1");
    expect(d.ownerHost).toBe("mini");
    expect(d.generation).toBe(7);
    expect(d.fencePhase).toBe("implement");
    expect(d.claimedAt).toBe("2026-07-03T10:00:00Z");
  });

  test("legacy pre-CTL-923 schema (no fence columns) → nulls, not a throw", () => {
    const legacy = new Database(dbPath, { create: true });
    legacy.run(`
      CREATE TABLE ticket_state (
        ticket       TEXT PRIMARY KEY,
        linear_state TEXT,
        pr_number    INTEGER,
        updated_at   TEXT NOT NULL
      )
    `);
    legacy.run(`INSERT INTO ticket_state VALUES ('CTL-9', 'Done', 7, '2026-01-01T00:00:00Z')`);
    legacy.close();
    reader = createGatewayReader({ dbPath });
    const d = reader.getDescriptor("CTL-9");
    expect(d.ownerHost).toBeNull();
    expect(d.generation).toBeNull();
    expect(d.fencePhase).toBeNull();
    expect(d.claimedAt).toBeNull();
  });
});

describe("gatewayFence (CTL-863)", () => {
  const gwWith = (descriptor) => ({ getDescriptor: () => descriptor });

  test("maps a fenced descriptor into the guard's { ownerHost, generation, phase, claimedAt } shape", () => {
    const gw = gwWith({
      removed: false,
      ownerHost: "mini",
      generation: 5,
      fencePhase: "pr",
      claimedAt: "2026-07-03T10:00:00Z",
    });
    expect(gatewayFence(gw, "CTL-1")).toEqual({
      ownerHost: "mini",
      generation: 5,
      phase: "pr",
      claimedAt: "2026-07-03T10:00:00Z",
    });
  });

  test("a released fence (ownerHost cleared to null) → null (no fence to trust)", () => {
    const gw = gwWith({ removed: false, ownerHost: null, generation: null });
    expect(gatewayFence(gw, "CTL-1")).toBeNull();
  });

  test("miss: null gateway / no getDescriptor / absent row / tombstone → null", () => {
    expect(gatewayFence(null, "CTL-1")).toBeNull();
    expect(gatewayFence({}, "CTL-1")).toBeNull();
    expect(gatewayFence(gwWith(null), "CTL-1")).toBeNull();
    expect(gatewayFence(gwWith({ removed: true, ownerHost: "mini", generation: 5 }), "CTL-1")).toBeNull();
  });

  test("never throws: getDescriptor that throws → null", () => {
    expect(gatewayFence({ getDescriptor: () => { throw new Error("x"); } }, "CTL-1")).toBeNull();
  });
});

describe("claimedAtAgeMs — keyed on claimed_at, NOT updated_at (finding 6)", () => {
  test("computes age from claimedAt", () => {
    const now = Date.parse("2026-07-03T00:01:00Z");
    expect(claimedAtAgeMs({ claimedAt: "2026-07-03T00:00:00Z" }, now)).toBe(60_000);
  });

  test("a fresh updated_at does NOT freshen a stale fence (uses claimedAt only)", () => {
    const now = Date.parse("2026-07-03T01:00:00Z");
    // The descriptor's updatedAt is 'now' (webhook just touched the row) but the
    // fence was claimed an hour ago → claimedAtAgeMs must report the OLD age.
    const fence = { claimedAt: "2026-07-03T00:00:00Z", updatedAt: "2026-07-03T01:00:00Z" };
    expect(claimedAtAgeMs(fence, now)).toBe(3_600_000);
  });

  test("absent/unparseable claimedAt → Infinity (fails safe as stale → escalate)", () => {
    expect(claimedAtAgeMs({})).toBe(Infinity);
    expect(claimedAtAgeMs(null)).toBe(Infinity);
    expect(claimedAtAgeMs({ claimedAt: "not a date" })).toBe(Infinity);
  });
});
