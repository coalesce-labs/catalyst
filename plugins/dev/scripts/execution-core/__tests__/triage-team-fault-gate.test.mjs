import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bumpTriageDispatchCount, dispatchTriage, TRIAGE_DISPATCH_CAP } from "../monitor.mjs";

let orchDir;
beforeEach(() => { orchDir = mkdtempSync(join(tmpdir(), "cat140-monitor-")); });
afterEach(() => rmSync(orchDir, { recursive: true, force: true }));

const opts = (over = {}) => ({
  orchDir,
  dispatch: mock(() => ({ code: 0 })),
  hosts: ["local"], hostName: "local",
  isDraining: () => false,
  appendEvent: () => {},
  applyAssignee: () => ({ applied: true }),
  stampWorkerLabel: () => {},
  isTeamTriageStateFaulted: () => false,
  shouldProbeTeamTriageState: () => false,
  markTeamTriageStateProbe: () => {},
  recordTeamTriageStateWrite: () => {},
  applyTriageStatus: () => ({ applied: true, verified: true, from_state: "Todo", to_state: "Triage", reason: null }),
  ...over,
});

describe("dispatchTriage under a latched team fault (CAT-140)", () => {
  test("state-absent outcome is fed to the team recorder", () => {
    const record = mock(() => {});
    const o = opts({
      recordTeamTriageStateWrite: record,
      applyTriageStatus: () => ({ applied: false, verified: false, from_state: "Todo", to_state: "Triage", reason: "state-absent" }),
    });
    expect(dispatchTriage("CAT-140", o)).toBe(true);
    expect(record).toHaveBeenCalledWith("CAT", { reason: "state-absent", verified: false, expectedState: "Triage" });
  });

  test("inside the reprobe window holds without dispatch or count bump", () => {
    const o = opts({ isTeamTriageStateFaulted: () => true, shouldProbeTeamTriageState: () => false });
    expect(dispatchTriage("CAT-140", o)).toBe(false);
    expect(o.dispatch).not.toHaveBeenCalled();
  });

  test("past the reprobe window admits and marks one probe", () => {
    let due = true;
    const mark = mock(() => { due = false; });
    const o = opts({ isTeamTriageStateFaulted: () => true, shouldProbeTeamTriageState: () => due, markTeamTriageStateProbe: mark });
    expect(dispatchTriage("CAT-140", o)).toBe(true);
    expect(dispatchTriage("CAT-141", o)).toBe(false);
    expect(mark).toHaveBeenCalledTimes(1);
    expect(o.dispatch).toHaveBeenCalledTimes(1);
  });

  test("a due fault probe bypasses the per-ticket cap without parking needs-human", () => {
    for (let i = 0; i < TRIAGE_DISPATCH_CAP; i += 1) bumpTriageDispatchCount(orchDir, "CAT-140");
    const labelNeedsHuman = mock(() => {});
    const o = opts({ isTeamTriageStateFaulted: () => true, shouldProbeTeamTriageState: () => true, labelNeedsHuman });
    expect(dispatchTriage("CAT-140", o)).toBe(true);
    expect(labelNeedsHuman).not.toHaveBeenCalled();
    expect(o.dispatch).toHaveBeenCalledTimes(1);
  });

  test("a probe window is not consumed when a later capacity gate rejects dispatch", () => {
    const mark = mock(() => {});
    const o = opts({
      isTeamTriageStateFaulted: () => true,
      shouldProbeTeamTriageState: () => true,
      markTeamTriageStateProbe: mark,
      budget: { remaining: 0 },
    });
    expect(dispatchTriage("CAT-140", o)).toBe(false);
    expect(mark).not.toHaveBeenCalled();
  });

  test("unfaulted ticket at cap retains the existing park", () => {
    for (let i = 0; i < TRIAGE_DISPATCH_CAP; i += 1) bumpTriageDispatchCount(orchDir, "CAT-140");
    const labelNeedsHuman = mock(() => {});
    expect(dispatchTriage("CAT-140", opts({ labelNeedsHuman }))).toBe(false);
    expect(labelNeedsHuman).toHaveBeenCalledTimes(1);
  });

  test("fault seam throws fail open", () => {
    const o = opts({ isTeamTriageStateFaulted: () => { throw new Error("bad marker"); } });
    expect(dispatchTriage("CAT-140", o)).toBe(true);
    expect(o.dispatch).toHaveBeenCalledTimes(1);
  });
});
