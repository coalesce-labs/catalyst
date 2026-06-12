// board-data-human-question.test.mjs — units for deriveHumanQuestion (CTL-1065).
// Covers the inbox sub-label source: scans phase signals newest-first and
// surfaces the most-recent explanation.human_question, null when none carry one.
//
//   cd plugins/dev/scripts/orch-monitor && bun test lib/board-data-human-question.test.mjs

import { describe, it, expect } from "bun:test";
import { deriveHumanQuestion } from "./board-data.mjs";

describe("CTL-1065: deriveHumanQuestion", () => {
  it("returns the human_question from a single signal that carries an explanation", () => {
    const sigs = [{ status: "running" }, { explanation: { human_question: "retry or hand off?" } }];
    expect(deriveHumanQuestion(sigs)).toBe("retry or hand off?");
  });

  it("scans newest-first — the highest-index explanation wins", () => {
    const sigs = [
      { explanation: { human_question: "OLD question?" } },
      { explanation: { human_question: "NEW question?" } },
    ];
    expect(deriveHumanQuestion(sigs)).toBe("NEW question?");
  });

  it("falls back to an earlier signal when the newest carries no explanation", () => {
    const sigs = [
      { explanation: { human_question: "earlier question?" } },
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
    const sigs = [null, "bogus", 42, { explanation: { human_question: "still found?" } }];
    expect(deriveHumanQuestion(sigs)).toBe("still found?");
  });

  it("ignores an explanation whose human_question is not a string", () => {
    const sigs = [{ explanation: { human_question: 123 } }, { explanation: {} }];
    expect(deriveHumanQuestion(sigs)).toBeNull();
  });
});
