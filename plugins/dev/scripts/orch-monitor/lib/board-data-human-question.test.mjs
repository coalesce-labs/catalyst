// board-data-human-question.test.mjs — CTL-1130: deriveHumanQuestion reads call_to_action.
// Covers the inbox sub-label source: scans phase signals newest-first and
// surfaces the most-recent explanation.call_to_action, null when none carry one.
//
//   cd plugins/dev/scripts/orch-monitor && bun test lib/board-data-human-question.test.mjs

import { describe, it, expect } from "bun:test";
import { deriveHumanQuestion } from "./board-data.mjs";

describe("CTL-1130: deriveHumanQuestion reads call_to_action", () => {
  it("returns the call_to_action from a single signal that carries an explanation", () => {
    const sigs = [{ status: "running" }, { explanation: { call_to_action: "retry or hand off?" } }];
    expect(deriveHumanQuestion(sigs)).toBe("retry or hand off?");
  });

  it("scans newest-first — the highest-index call_to_action wins", () => {
    const sigs = [
      { explanation: { call_to_action: "OLD question?" } },
      { explanation: { call_to_action: "NEW question?" } },
    ];
    expect(deriveHumanQuestion(sigs)).toBe("NEW question?");
  });

  it("falls back to an earlier signal when the newest carries no explanation", () => {
    const sigs = [
      { explanation: { call_to_action: "earlier question?" } },
      { status: "running" },
    ];
    expect(deriveHumanQuestion(sigs)).toBe("earlier question?");
  });

  it("returns null when no signal carries an explanation", () => {
    expect(deriveHumanQuestion([{ status: "running" }, { status: "failed" }])).toBeNull();
  });

  it("returns null for an empty array", () => {
    expect(deriveHumanQuestion([])).toBeNull();
  });

  it("ignores non-object / null entries without throwing", () => {
    const sigs = [null, "bogus", 42, { explanation: { call_to_action: "still found?" } }];
    expect(deriveHumanQuestion(sigs)).toBe("still found?");
  });

  it("ignores an explanation whose call_to_action is not a string", () => {
    const sigs = [{ explanation: { call_to_action: 123 } }, { explanation: {} }];
    expect(deriveHumanQuestion(sigs)).toBeNull();
  });

  it("does NOT read human_question (old field name is dead)", () => {
    const sigs = [{ explanation: { human_question: "old field" } }];
    expect(deriveHumanQuestion(sigs)).toBeNull();
  });
});
