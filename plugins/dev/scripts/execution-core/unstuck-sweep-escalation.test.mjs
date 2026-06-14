// unstuck-sweep-escalation.test.mjs — CTL-1064 Phase 6 escalation comment tests.

import { describe, test, expect } from "bun:test";
import { authorEscalationComment, summarizeRemediateCapHistory } from "./unstuck-sweep-escalation.mjs";

// ---------------------------------------------------------------------------
// authorEscalationComment
// ---------------------------------------------------------------------------
describe("authorEscalationComment (CTL-1064)", () => {
  test("empty-branch evidence (commitsAhead=0) → names the single decision", () => {
    const comment = authorEscalationComment({
      ticket: "CTL-1064",
      phase: "implement",
      commitsAhead: 0,
    });
    expect(comment.length).toBeGreaterThan(80);
    expect(comment).toContain("decision");
    expect(comment).toContain("0 commits");
    expect(comment).toContain("CTL-1064");
  });

  test("empty array commitsAhead → treated as zero", () => {
    const comment = authorEscalationComment({
      ticket: "CTL-X",
      phase: "implement",
      commitsAhead: [],
    });
    expect(comment).toContain("0 commits");
  });

  test("rebase_refused_dirty_tree with non-noise porcelainLines → names specific dirty files", () => {
    const comment = authorEscalationComment({
      ticket: "CTL-TEST",
      phase: "implement",
      reason: "rebase_refused_dirty_tree",
      porcelainLines: [" M src/foo.ts"],
    });
    expect(comment).toContain("src/foo.ts");
    expect(comment).toContain("CTL-TEST");
  });

  test("source_conflict_ctl708_unavailable → explains stub unavailable + frames as human-verified", () => {
    const comment = authorEscalationComment({
      ticket: "CTL-1025",
      phase: "implement",
      reason: "source_conflict_ctl708_unavailable",
      prState: "OPEN",
    });
    expect(comment).toContain("force-push");
    expect(comment).toContain("PR state: OPEN");
    expect(comment).toContain("Confirm");
  });

  test("unknown reason → 'not mechanically resolvable' + contains word whitelist", () => {
    const comment = authorEscalationComment({
      ticket: "CTL-X",
      phase: "verify",
      reason: "some_unknown_reason",
    });
    expect(comment).toContain("not mechanically resolvable");
    expect(comment).toContain("whitelist");
    expect(comment).toContain("Decision required");
  });

  test("non-empty string with subject + reason", () => {
    const comment = authorEscalationComment({ ticket: "CTL-X", phase: "plan", reason: "other" });
    expect(typeof comment).toBe("string");
    expect(comment.length).toBeGreaterThan(20);
  });

  test("does not throw on null fields", () => {
    expect(() => authorEscalationComment({ ticket: null, phase: null, reason: null })).not.toThrow();
    expect(() => authorEscalationComment({})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// summarizeRemediateCapHistory
// ---------------------------------------------------------------------------
describe("summarizeRemediateCapHistory (CTL-1064)", () => {
  test("empty history → empty string", () => {
    expect(summarizeRemediateCapHistory("CTL-X", [])).toBe("");
  });

  test("single round → names the round", () => {
    const s = summarizeRemediateCapHistory("CTL-X", [
      { round: 1, verifyFindings: "type errors", remediateChanges: "fixed types", reVerifyResult: "still failed" },
    ]);
    expect(s).toContain("Round 1");
    expect(s).toContain("type errors");
    expect(s).toContain("fixed types");
    expect(s).toContain("still failed");
  });

  test("three rounds → lists each (Round 1/2/3)", () => {
    const history = [
      { round: 1, verifyFindings: "A", remediateChanges: "B", reVerifyResult: "C" },
      { round: 2, verifyFindings: "D", remediateChanges: "E", reVerifyResult: "F" },
      { round: 3, verifyFindings: "G", remediateChanges: "H", reVerifyResult: "I" },
    ];
    const s = summarizeRemediateCapHistory("CTL-X", history);
    expect(s).toContain("Round 1");
    expect(s).toContain("Round 2");
    expect(s).toContain("Round 3");
  });

  test("missing fields → 'findings unavailable'", () => {
    const s = summarizeRemediateCapHistory("CTL-X", [{ round: 1 }]);
    expect(s).toContain("findings unavailable");
  });

  test("output contains the ticket id", () => {
    const s = summarizeRemediateCapHistory("CTL-MY-TICKET", [
      { round: 1, verifyFindings: "x", remediateChanges: "y", reVerifyResult: "z" },
    ]);
    expect(s).toContain("CTL-MY-TICKET");
  });

  test("pure — same input twice → identical output", () => {
    const history = [{ round: 1, verifyFindings: "a", remediateChanges: "b", reVerifyResult: "c" }];
    expect(summarizeRemediateCapHistory("CTL-X", history)).toBe(
      summarizeRemediateCapHistory("CTL-X", history)
    );
  });
});
