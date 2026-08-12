import { describe, expect, test } from "bun:test";
import {
  classifyStallReason,
  describeSkip,
  summarizeSkips,
  hasStarvingWork,
} from "./dispatch-skip.mjs";

describe("dispatch skip attribution", () => {
  test("classifies known reasons and fails closed", () => {
    for (const reason of ["needs_human", "escalation-ask-cap", "remediate-cycle-cap-exhausted", "phantom-ticket"])
      expect(classifyStallReason(reason)).toBe("operator-owned");
    for (const reason of ["boot-resume-gate-expired", "dispatch-circuit-breaker", "prior-artifact-retry-exhausted", "no-probe-for-phase"])
      expect(classifyStallReason(reason)).toBe("machine-owned");
    for (const reason of [null, "", "new-reason", 7]) expect(classifyStallReason(reason)).toBe("unknown");
  });

  test("describes the live signal and reason precedence", () => {
    const entry = describeSkip({
      signals: { research: "failed", implement: "stalled" },
      raw: { implement: { failureReason: "failure", attentionReason: "attention", stalledReason: "stall" } },
    });
    expect(entry).toEqual({ status: "stalled", phase: "implement", reason: "failure", class: "unknown" });
    expect(describeSkip({ signals: {}, raw: null }).class).toBe("unknown");
  });

  test("summarizes uncapped counts while capping details", () => {
    const entries = [
      { ticket: "CAT-1", class: "operator-owned" },
      { ticket: "CAT-2", class: "machine-owned" },
      { ticket: "CAT-3", class: "unknown" },
    ];
    expect(summarizeSkips(entries, { cap: 2 })).toEqual({
      entries: entries.slice(0, 2), count: 3, operatorOwned: 1, machineOwned: 1, unknown: 1,
    });
  });

  test("operator parks do not count as starvation", () => {
    expect(hasStarvingWork({ readyIds: ["CAT-1"], skips: [{ ticket: "CAT-1", class: "operator-owned" }] })).toBe(false);
    expect(hasStarvingWork({ readyIds: ["CAT-1"], skips: [{ ticket: "CAT-1", class: "machine-owned" }] })).toBe(true);
    expect(hasStarvingWork({ readyIds: ["CAT-1", "CAT-2"], skips: [{ ticket: "CAT-1", class: "operator-owned" }] })).toBe(true);
    expect(hasStarvingWork({ readyIds: [], skips: [] })).toBe(false);
  });
});
