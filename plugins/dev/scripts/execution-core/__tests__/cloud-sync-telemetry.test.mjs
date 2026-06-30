// cloud-sync-telemetry.test.mjs — CTL-1395. Tests the pure freshness-telemetry helpers.
import { describe, test, expect } from "bun:test";
import { freshnessFields, readReplicaCounts } from "../cloud-sync-telemetry.mjs";

const NOW = 1_800_000_000_000;

describe("freshnessFields", () => {
  test("staleness = whole seconds since maxUpdatedMs", () => {
    const f = freshnessFields({ rows: 2878, maxUpdatedMs: NOW - 90_000, status: "live", cursor: 311476, hostName: "mini", now: NOW });
    expect(f["catalyst.linear.replica.staleness"]).toBe(90);
    expect(f["catalyst.linear.replica.rows"]).toBe(2878);
    expect(f["catalyst.linear.replica.status"]).toBe("live");
    expect(f["catalyst.linear.replica.cursor"]).toBe(311476);
    expect(f["host.name"]).toBe("mini");
  });

  test("staleness is null (not a bogus number) when maxUpdatedMs is null / 0 / NaN", () => {
    for (const mx of [null, undefined, 0, NaN, "nope"]) {
      expect(freshnessFields({ maxUpdatedMs: mx, now: NOW })["catalyst.linear.replica.staleness"]).toBeNull();
    }
  });

  test("staleness never negative (clamped to 0) for a future timestamp", () => {
    expect(freshnessFields({ maxUpdatedMs: NOW + 5_000, now: NOW })["catalyst.linear.replica.staleness"]).toBe(0);
  });

  test("rows: null stays null; a value coerces to a number", () => {
    expect(freshnessFields({ rows: null, now: NOW })["catalyst.linear.replica.rows"]).toBeNull();
    expect(freshnessFields({ rows: "45805", now: NOW })["catalyst.linear.replica.rows"]).toBe(45805);
    expect(freshnessFields({ rows: 0, now: NOW })["catalyst.linear.replica.rows"]).toBe(0);
  });

  test("missing optional fields → nulls, never throws", () => {
    const f = freshnessFields();
    expect(f["catalyst.linear.replica.status"]).toBeNull();
    expect(f["catalyst.linear.replica.cursor"]).toBeNull();
    expect(f["host.name"]).toBeNull();
  });

  test("carries no secret-shaped keys/values (NAME-only telemetry)", () => {
    const f = freshnessFields({ rows: 1, maxUpdatedMs: NOW, status: "live", cursor: 1, hostName: "mini", now: NOW });
    expect(JSON.stringify(f)).not.toMatch(/token|secret|lin_|Bearer/i);
  });
});

describe("readReplicaCounts", () => {
  test("HIT: reads COUNT + MAX(updated_at) via the SqlExecutor", () => {
    const sql = { exec: () => ({ toArray: () => [{ n: 2878, mx: NOW - 1000 }] }) };
    expect(readReplicaCounts(sql)).toEqual({ rows: 2878, maxUpdatedMs: NOW - 1000 });
  });

  test("empty table → rows 0, maxUpdatedMs null", () => {
    const sql = { exec: () => ({ toArray: () => [{ n: 0, mx: null }] }) };
    expect(readReplicaCounts(sql)).toEqual({ rows: 0, maxUpdatedMs: null });
  });

  test("FAIL-OPEN: a throwing executor (locked/mid-apply DB) → both null, never throws", () => {
    const sql = { exec: () => { throw new Error("database is locked"); } };
    expect(readReplicaCounts(sql)).toEqual({ rows: null, maxUpdatedMs: null });
  });
});
