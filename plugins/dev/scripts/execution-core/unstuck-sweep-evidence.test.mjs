// unstuck-sweep-evidence.test.mjs — CTL-1064 Phase 6 evidence collector tests.

import { describe, test, expect } from "bun:test";
import { captureDeepDiveEvidence } from "./unstuck-sweep-evidence.mjs";

describe("captureDeepDiveEvidence — pure collector (CTL-1064)", () => {
  const SUBJECT = "CTL-TEST/implement";

  test("returns structured envelope with all fields", () => {
    const result = captureDeepDiveEvidence(SUBJECT);
    expect(result).toHaveProperty("subject", SUBJECT);
    expect(result).toHaveProperty("ticket", "CTL-TEST");
    expect(result).toHaveProperty("phase", "implement");
    expect(result).toHaveProperty("signalJson");
    expect(result).toHaveProperty("porcelainLines");
    expect(result).toHaveProperty("prState");
    expect(result).toHaveProperty("remediateHistory");
    expect(result).toHaveProperty("capturedAt");
  });

  test("porcelainLines is noise-filtered (deleted node_modules absent)", () => {
    const result = captureDeepDiveEvidence(SUBJECT, {
      readSignal: () => ({ worktreePath: "/wt/CTL-TEST" }),
      runGitPorcelain: () => " M .catalyst/config.json\n D node_modules\n M src/foo.mjs",
    });
    // node_modules deletion and .catalyst/config.json filtered; src/foo.mjs kept
    expect(result.porcelainLines.some(l => l.includes("src/foo.mjs"))).toBe(true);
    expect(result.porcelainLines.some(l => l.includes(".catalyst/config.json"))).toBe(false);
  });

  test("prState:null when queryPR throws (still returns envelope)", () => {
    const result = captureDeepDiveEvidence(SUBJECT, {
      queryPR: () => { throw new Error("API unavailable"); },
    });
    expect(result.prState).toBeNull();
    expect(result.subject).toBe(SUBJECT);
  });

  test("empty remediateHistory when none found", () => {
    const result = captureDeepDiveEvidence(SUBJECT, {
      listRemediateEvents: () => [],
    });
    expect(result.remediateHistory).toEqual([]);
  });

  test("readSignal→null does not throw", () => {
    const result = captureDeepDiveEvidence(SUBJECT, {
      readSignal: () => null,
    });
    expect(result.signalJson).toBeNull();
  });

  test("all IO seams injected — no filesystem access in the function body", () => {
    // If all seams return null/[] and no IO is done, the function should still succeed
    const result = captureDeepDiveEvidence(SUBJECT, {
      readSignal: () => null,
      runGitPorcelain: () => null,
      queryPR: () => null,
      listRemediateEvents: () => [],
    });
    expect(result.porcelainLines).toEqual([]);
    expect(result.prState).toBeNull();
    expect(result.remediateHistory).toEqual([]);
  });

  test("listRemediateEvents throw → remediateHistory=[] (graceful)", () => {
    const result = captureDeepDiveEvidence(SUBJECT, {
      listRemediateEvents: () => { throw new Error("event log unavailable"); },
    });
    expect(result.remediateHistory).toEqual([]);
  });
});
