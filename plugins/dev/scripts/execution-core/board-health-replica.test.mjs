import { describe, expect, test } from "bun:test";
import { assembleBoardState, evaluateInvariants, buildBoardContext, buildBoardScanEvent, decideBoardHealth } from "./board-health.mjs";

const NOW = 1_786_000_000_000;
const empty = { dbPresent: true, sizeBytes: 99_999, isSqlite: true, tables: ["issues", "sync_meta"], issueRows: 0, teams: [], registeredTeams: ["CAT"], cursor: "c", lockMtimeMs: NOW - 1_000, sampledAt: new Date(NOW - 1_000).toISOString() };
const board = (mode, snapshot = empty) => assembleBoardState({ mode: "shadow", replicaMode: mode, getReplicaState: () => snapshot, now: () => NOW });

describe("replicaHealth", () => {
  test("shadow names emptiness without failing", () => expect(evaluateInvariants(board("shadow")).replicaHealth).toMatchObject({ ok: true, observable: false, state: "empty", issueRows: 0 }));
  test("enforce makes empty observable and failing", () => expect(evaluateInvariants(board("enforce")).replicaHealth).toMatchObject({ ok: false, observable: true, failed: 1, state: "empty" }));
  test("off does not read and preserves the legacy key set", () => {
    let reads = 0; const b = assembleBoardState({ mode: "off", replicaMode: "off", getReplicaState: () => { reads++; return empty; }, now: () => NOW });
    expect(reads).toBe(0); expect(Object.keys(evaluateInvariants(b, { mode: "off" }))).not.toContain("replicaHealth");
  });
  test("publication carries bounded replica evidence", () => {
    const b = board("shadow"); const invariants = evaluateInvariants(b); const decision = decideBoardHealth(invariants, b);
    expect(buildBoardContext(b, invariants).replica).toMatchObject({ state: "empty", issueRows: 0 });
    expect(buildBoardScanEvent({ mode: "shadow", invariants, decision, board: b }).details).toMatchObject({ replicaIssueRows: 0, replicaTeamCoveragePct: null, replicaState: "empty" });
  });
});
