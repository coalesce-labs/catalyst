// hung-detector.test.mjs — CTL-729 Phase 3 truth table.
// Pure IO-free tests; all inputs injected.

import { describe, test, expect } from "bun:test";
import { evaluateHungWorker } from "./hung-detector.mjs";

const NOW = Date.parse("2026-06-09T12:00:00Z");
const SIL = 30 * 60_000;        // 30 min silence threshold
const BUD = 2 * 60 * 60_000;    // 2 hour budget

// A HUNG implement worker — each test overrides one axis.
const makeInputs = (over = {}) => ({
  ticket: "CTL-692",
  phase: "implement",
  status: "running",
  nowMs: NOW,
  startedAtMs: NOW - BUD - 60_000,   // 1 minute past budget
  transcriptAgeMs: SIL + 60_000,     // 1 minute past silence threshold
  progressMark: 0,                   // 0 commits
  silenceMs: SIL,
  budgetMs: BUD,
  ...over,
});

describe("evaluateHungWorker — hung cases", () => {
  test("[hung] running + silent + 0commits + over-budget → kill-escalate", () => {
    const o = evaluateHungWorker(makeInputs());
    expect(o.action).toBe("kill-escalate");
    expect(o.reason).toMatch(/^hung_no_progress:implement:\d+m_0_commits$/);
    expect(o.elapsedMin).toBeGreaterThan(0);
  });
});

describe("evaluateHungWorker — spared cases", () => {
  test("[fresh] silence under threshold → none/transcript-fresh", () => {
    expect(evaluateHungWorker(makeInputs({ transcriptAgeMs: SIL - 1 })).reason).toBe("transcript-fresh");
  });
  test("[has-commit] >=1 commit → none/has-progress (non-fanout)", () => {
    expect(evaluateHungWorker(makeInputs({ progressMark: 2 })).reason).toBe("has-progress");
  });
  test("[under-budget] elapsed within budget → none/under-budget (ALL phases)", () => {
    expect(evaluateHungWorker(makeInputs({ startedAtMs: NOW - 60_000 })).reason).toBe("under-budget");
  });
});

describe("evaluateHungWorker — fanout phases (Gherkin 3)", () => {
  test("[research-fanout] 0 commits + over budget + silent → kill (commit gate waived)", () => {
    const o = evaluateHungWorker(makeInputs({
      phase: "research",
      progressMark: 0,
      budgetMs: 105 * 60_000,
      startedAtMs: NOW - 106 * 60_000,
    }));
    expect(o.action).toBe("kill-escalate");
  });
  test("[research-fresh] research + fresh subagent transcript → none (never killed)", () => {
    expect(
      evaluateHungWorker(makeInputs({ phase: "research", transcriptAgeMs: 1_000 })).action,
    ).toBe("none");
  });
  test("[research-under-budget] research silent but elapsed < budget → none (NOT killed early)", () => {
    expect(
      evaluateHungWorker(makeInputs({
        phase: "research",
        budgetMs: 105 * 60_000,
        startedAtMs: NOW - 35 * 60_000,
      })).reason,
    ).toBe("under-budget");
  });
  test("[plan-fanout] plan + fresh transcript → none", () => {
    expect(evaluateHungWorker(makeInputs({ phase: "plan", transcriptAgeMs: 1_000 })).action).toBe("none");
  });
  test("[plan-hung] plan + silent + over budget → kill (commit gate waived)", () => {
    const o = evaluateHungWorker(makeInputs({
      phase: "plan",
      progressMark: 0,
      budgetMs: 105 * 60_000,
      startedAtMs: NOW - 106 * 60_000,
    }));
    expect(o.action).toBe("kill-escalate");
  });
});

describe("evaluateHungWorker — terminal + status gates (Gherkin 4)", () => {
  test("[terminal] settled status → none", () => {
    for (const st of ["done", "failed", "stalled", "skipped", "complete"]) {
      expect(evaluateHungWorker(makeInputs({ status: st })).action).toBe("none");
    }
  });
  test("[status] only running/dispatched are candidates", () => {
    expect(evaluateHungWorker(makeInputs({ status: "preempted" })).action).toBe("none");
    expect(evaluateHungWorker(makeInputs({ status: "dispatched" })).action).toBe("kill-escalate");
  });
});

describe("evaluateHungWorker — fail-safe (missing data)", () => {
  test("[no-startedat] unparseable startedAt → none", () => {
    expect(evaluateHungWorker(makeInputs({ startedAtMs: null })).action).toBe("none");
    expect(evaluateHungWorker(makeInputs({ startedAtMs: NaN })).action).toBe("none");
  });
  test("[no-transcript] null transcriptAgeMs → none", () => {
    expect(evaluateHungWorker(makeInputs({ transcriptAgeMs: null })).action).toBe("none");
  });
});
