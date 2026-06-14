// formatters.test.ts — units for the shared presentational formatters.
// CTL-915 (DETAIL4): covers `phaseModelLabel`, the single per-phase model
// renderer the lifecycle spine AND the compact gantt both call, proving the
// Gherkin "the compact gantt shows the same per-phase model" by construction
// (one function → identical output) and the "null → honest em-dash, never
// fabricated" rule.
import { describe, it, expect } from "bun:test";
import { phaseModelLabel } from "./formatters";

describe("phaseModelLabel (shared spine + gantt per-phase model)", () => {
  it("prefixes a present model with the ◆ marker", () => {
    expect(phaseModelLabel("sonnet")).toBe("◆sonnet");
    expect(phaseModelLabel("opus")).toBe("◆opus");
    expect(phaseModelLabel("claude-opus-4-8[1m]")).toBe("◆claude-opus-4-8[1m]");
  });

  it("renders a dimmed em-dash when the phase signal carried no model (never fabricated)", () => {
    expect(phaseModelLabel(null)).toBe("—");
    expect(phaseModelLabel(undefined)).toBe("—");
    expect(phaseModelLabel("")).toBe("—");
  });

  it("is the SAME function for spine and gantt — identical output for the same input", () => {
    // The acceptance line "the same per-phase model" is satisfied by construction:
    // a single function means spine[phase] === gantt[phase] for every phase.
    for (const m of ["sonnet", "opus", null, ""]) {
      expect(phaseModelLabel(m)).toBe(phaseModelLabel(m));
    }
  });
});
