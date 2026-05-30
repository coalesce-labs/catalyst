// workflow-descriptor.test.mjs — the PROVENANCE-SWAP DRIFT GUARD.
//
// Asserts every constant derived from lib/workflow.default.json is byte-equal to
// the historical literal that phase-fsm.mjs + scheduler.mjs hardcoded as of
// d09fb2b2 (BEFORE the swap). Re-sourcing those files from the descriptor is then
// a provable zero-behavior-change swap. If you intentionally change the pipeline,
// the GOLDEN values below must change in the same commit — that is the point.

import { describe, test, expect } from "bun:test";
import * as wd from "./workflow-descriptor.mjs";

// GOLDEN — transcribed verbatim from the historical literals.
const GOLDEN_PHASES = [
  "triage", "research", "plan", "implement", "verify",
  "review", "pr", "monitor-merge", "monitor-deploy",
];
const GOLDEN_NEXT_PHASE = {
  triage: "research", research: "plan", plan: "implement", implement: "verify",
  verify: "review", review: "pr", pr: "monitor-merge",
  "monitor-merge": "monitor-deploy", "monitor-deploy": "done",
};
const GOLDEN_PHASE_LINEAR_KEY = {
  triage: null, research: "research", plan: "planning", implement: "inProgress",
  verify: "verifying", review: "reviewing", pr: "inReview",
  "monitor-merge": "inReview", "monitor-deploy": "inReview", remediate: "remediating",
};
const GOLDEN_STAGE_RANK = {
  triage: 0, research: 1, plan: 2, implement: 3, verify: 5,
  review: 6, pr: 7, "monitor-merge": 8, "monitor-deploy": 9, remediate: 4,
};

describe("workflow-descriptor provenance swap — drift guard", () => {
  test("PHASES (value + order)", () => {
    expect(wd.PHASES).toEqual(GOLDEN_PHASES);
  });
  test("NEXT_PHASE (incl. terminal → done)", () => {
    expect(wd.NEXT_PHASE).toEqual(GOLDEN_NEXT_PHASE);
  });
  test("PHASE_LINEAR_KEY (incl. ancillary remediate)", () => {
    expect(wd.PHASE_LINEAR_KEY).toEqual(GOLDEN_PHASE_LINEAR_KEY);
  });
  test("STAGE_RANK values (non-dense; remediate=4)", () => {
    expect(wd.STAGE_RANK).toEqual(GOLDEN_STAGE_RANK);
  });
  test("STAGE_RANK key ORDER is [...PHASES, remediate] (preemption + frozen-order contract)", () => {
    expect(Object.keys(wd.STAGE_RANK)).toEqual([...GOLDEN_PHASES, "remediate"]);
  });
  test("STAGE_RANK is frozen", () => {
    expect(Object.isFrozen(wd.STAGE_RANK)).toBe(true);
  });
  test("TERMINAL_PHASE", () => {
    expect(wd.TERMINAL_PHASE).toBe("monitor-deploy");
  });
  test("NEW_WORK_ENTRY_PHASE", () => {
    expect(wd.NEW_WORK_ENTRY_PHASE).toBe("research");
  });
  test("NON_PREEMPTABLE_PHASES", () => {
    expect([...wd.NON_PREEMPTABLE_PHASES].sort()).toEqual(["monitor-deploy", "triage"]);
  });
  test("ANCILLARY_PHASES", () => {
    expect(wd.ANCILLARY_PHASES).toEqual(["remediate"]);
  });
  test("REMEDIATE_PHASE", () => {
    expect(wd.REMEDIATE_PHASE).toBe("remediate");
  });
  test("REMEDIATE_CYCLE_CAP", () => {
    expect(wd.REMEDIATE_CYCLE_CAP).toBe(3);
  });
});
