// cloud-sync-telemetry.test.mjs — CTL-1395. Tests the pure freshness-telemetry helpers.
import { describe, test, expect } from "bun:test";
import { classifyStall, freshnessFields, readReplicaCounts } from "../cloud-sync-telemetry.mjs";

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

describe("classifyStall", () => {
  const STALL = 600_000;

  test("QUIET-BUT-HEALTHY: cursor stalled past the window but SDK status live → NOT a stall (no alert, no restart) — the Codex P1/P2 false-kill guard", () => {
    const c = classifyStall({ rows: 2878, stalledMs: STALL + 5_000, stallMs: STALL, status: "live" });
    expect(c.cursorStalled).toBe(true); // cursor IS silent
    expect(c.sdkUnhealthy).toBe(false); // but the socket is healthy
    expect(c.genuine).toBe(false);
    expect(c.alert).toBe(false);
    expect(c.restart).toBe(false);
    expect(c.displayStatus).toBe("live"); // reports its real status, not "stalled"
  });

  test("GENUINE: cursor stalled past the window AND an unhealthy SDK status → alert + self-heal restart", () => {
    for (const status of ["reconnecting", "error", "stopped"]) {
      const c = classifyStall({ rows: 2878, stalledMs: STALL + 1, stallMs: STALL, status });
      expect(c.cursorStalled).toBe(true);
      expect(c.sdkUnhealthy).toBe(true);
      expect(c.genuine).toBe(true);
      expect(c.alert).toBe(true);
      expect(c.restart).toBe(true);
      expect(c.displayStatus).toBe("stalled");
    }
  });

  test("unhealthy SDK status but cursor still advancing (within window) → NOT a stall (the SDK owns its own reconnect/backoff)", () => {
    const c = classifyStall({ rows: 2878, stalledMs: 5_000, stallMs: STALL, status: "reconnecting" });
    expect(c.cursorStalled).toBe(false);
    expect(c.genuine).toBe(false);
    expect(c.restart).toBe(false);
    expect(c.displayStatus).toBe("reconnecting");
  });

  test("pre-seed window (rows 0 / null) is never a stall — no cursor yet", () => {
    for (const rows of [0, null]) {
      const c = classifyStall({ rows, stalledMs: STALL + 60_000, stallMs: STALL, status: "error" });
      expect(c.cursorStalled).toBe(false);
      expect(c.genuine).toBe(false);
      expect(c.restart).toBe(false);
    }
  });

  test("healthy transient states (connecting/resyncing) are NOT liveness failures", () => {
    for (const status of ["connecting", "resyncing"]) {
      const c = classifyStall({ rows: 2878, stalledMs: STALL + 1, stallMs: STALL, status });
      expect(c.sdkUnhealthy).toBe(false);
      expect(c.genuine).toBe(false);
      expect(c.restart).toBe(false);
    }
  });

  test("defaults are safe — no args never throws and is not a stall", () => {
    const c = classifyStall();
    expect(c.genuine).toBe(false);
    expect(c.restart).toBe(false);
    expect(c.displayStatus).toBe("live");
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
