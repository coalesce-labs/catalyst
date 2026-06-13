// board-data-explanation.test.mjs — units for deriveExplanation (CTL-1110).
// Covers the detail-pane CTA-led card data source: scans phase signals
// newest-first and surfaces the six extended explanation fields as a nested
// object, null when none carry extended fields.
//
//   cd plugins/dev/scripts/orch-monitor && bun test lib/board-data-explanation.test.mjs

import { describe, it, expect } from "bun:test";
import { deriveExplanation } from "./board-data.mjs";

describe("CTL-1110: deriveExplanation", () => {
  it("returns the six extended fields from a signal carrying them", () => {
    const sigs = [
      { status: "running" },
      { explanation: {
          human_question: "decide?", call_to_action: "Decide: fix or descope.",
          outcome: "Operators see capacity.", problem: "capacityReader not passed.",
          why_you: "Fixes need judgment.", why_not_auto: "3 attempts failed.",
          what_to_do: "Review why fixes failed.",
        } },
    ];
    expect(deriveExplanation(sigs)).toEqual({
      call_to_action: "Decide: fix or descope.",
      outcome: "Operators see capacity.",
      problem: "capacityReader not passed.",
      why_you: "Fixes need judgment.",
      why_not_auto: "3 attempts failed.",
      what_to_do: "Review why fixes failed.",
    });
  });

  it("scans newest-first — the highest-index extended explanation wins", () => {
    const sigs = [
      { explanation: { call_to_action: "OLD" } },
      { explanation: { call_to_action: "NEW" } },
    ];
    expect(deriveExplanation(sigs)?.call_to_action).toBe("NEW");
  });

  it("projects absent sub-fields to null (graceful partial)", () => {
    const sigs = [{ explanation: { call_to_action: "Decide.", what_to_do: "Pick an option." } }];
    expect(deriveExplanation(sigs)).toEqual({
      call_to_action: "Decide.", outcome: null, problem: null,
      why_you: null, why_not_auto: null, what_to_do: "Pick an option.",
    });
  });

  it("returns null when the only explanation carries just the canonical five fields", () => {
    const sigs = [{ explanation: { human_question: "q?", what_failed: "x", why_gave_up: "y" } }];
    expect(deriveExplanation(sigs)).toBeNull();
  });

  it("returns null when no signal carries an explanation, and for an empty array", () => {
    expect(deriveExplanation([{ status: "running" }])).toBeNull();
    expect(deriveExplanation([])).toBeNull();
  });

  it("ignores non-object / null entries and non-string sub-fields without throwing", () => {
    const sigs = [null, "bogus", 42, { explanation: { call_to_action: 123, outcome: "ok" } }];
    expect(deriveExplanation(sigs)).toEqual({
      call_to_action: null, outcome: "ok", problem: null,
      why_you: null, why_not_auto: null, what_to_do: null,
    });
  });
});
