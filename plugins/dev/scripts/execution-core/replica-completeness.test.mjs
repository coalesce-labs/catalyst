import { describe, expect, test } from "bun:test";
import { evaluateReplicaCompleteness, REPLICA_COMPLETENESS_DEFAULTS } from "./replica-completeness.mjs";

const NOW = 1_786_000_000_000;
const snap = (over = {}) => ({
  dbPresent: true, sizeBytes: 1_171_456, isSqlite: true,
  tables: ["issues", "sync_meta", "labels"], issueRows: 269,
  teams: ["CAT", "VAN"], registeredTeams: ["CAT", "VAN"],
  cursor: "seeded:VAN:1786382209856", sampledAt: new Date(NOW - 1_000).toISOString(),
  lockMtimeMs: NOW - 5_000, ...over,
});

describe("evaluateReplicaCompleteness", () => {
  test("unknown inputs never create a false pass", () => {
    expect(evaluateReplicaCompleteness(null, {}, NOW).state).toBe("unknown");
    expect(evaluateReplicaCompleteness(snap(), {}, NaN).state).toBe("unknown");
  });
  test("classifies absent, unusable schema, and empty databases", () => {
    expect(evaluateReplicaCompleteness(snap({ dbPresent: false }), {}, NOW)).toMatchObject({ state: "absent", issueRows: null });
    for (const over of [{ sizeBytes: 0 }, { isSqlite: false }, { tables: ["sync_meta"] }]) {
      expect(evaluateReplicaCompleteness(snap(over), {}, NOW).state).toBe("no-schema");
    }
    expect(evaluateReplicaCompleteness(snap({ issueRows: 0, teams: [] }), {}, NOW)).toMatchObject({ state: "empty", issueRows: 0 });
  });
  test("empty outranks a stale heartbeat", () => {
    expect(evaluateReplicaCompleteness(snap({ issueRows: 0, lockMtimeMs: NOW - 86_400_000 }), {}, NOW).state).toBe("empty");
  });
  test("classifies populated stale databases", () => {
    expect(evaluateReplicaCompleteness(snap({ lockMtimeMs: NOW - 86_400_000 }), {}, NOW)).toMatchObject({ state: "stale", lockAgeMs: 86_400_000 });
  });
  test("reports partial registered-team coverage", () => {
    const q = evaluateReplicaCompleteness(snap({ registeredTeams: ["CAT", "VAN", "COP"] }), {}, NOW);
    expect(q.state).toBe("partial"); expect(q.missingTeams).toEqual(["COP"]); expect(q.teamCoveragePct).toBeCloseTo(66.7, 1);
  });
  test("missing lock and empty registry do not fabricate evidence", () => {
    expect(evaluateReplicaCompleteness(snap({ lockMtimeMs: null }), {}, NOW)).toMatchObject({ state: "ok", lockAgeMs: null });
    expect(evaluateReplicaCompleteness(snap({ registeredTeams: [] }), {}, NOW)).toMatchObject({ state: "ok", teamCoveragePct: null, missingTeams: [] });
  });
  test("stale snapshots are unknown", () => {
    expect(evaluateReplicaCompleteness(snap({ sampledAt: new Date(NOW - 3_600_000).toISOString() }), {}, NOW)).toMatchObject({ state: "unknown", stale: true });
  });
  test("honors an explicit zero threshold", () => {
    expect(evaluateReplicaCompleteness(snap(), { lockStaleMs: 0 }, NOW).state).toBe("stale");
    expect(REPLICA_COMPLETENESS_DEFAULTS.lockStaleMs).toBeGreaterThan(0);
  });
});
