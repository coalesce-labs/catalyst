// preface-section.test.ts — CTL-1103 Phase 3: verifies the preface data
// model used by PrefaceSection. Pure logic; no DOM rendering.
// Run: cd ui && bun test src/components/rulebook/preface-section.test.ts
import { describe, it, expect } from "bun:test";
import { prefaceIsComplete, type Preface } from "../../lib/rulebook-model";

const FULL_PREFACE: Preface = {
  problem:
    "The daemon must decide — continuously — which workers are alive.",
  datalog_primer:
    "Datalog is a logic programming language where rules derive new facts.",
};

describe("prefaceIsComplete", () => {
  it("returns true when both problem and datalog_primer are non-empty", () => {
    expect(prefaceIsComplete(FULL_PREFACE)).toBe(true);
  });

  it("returns false when problem is empty", () => {
    expect(prefaceIsComplete({ ...FULL_PREFACE, problem: "" })).toBe(false);
  });

  it("returns false when datalog_primer is empty", () => {
    expect(
      prefaceIsComplete({ ...FULL_PREFACE, datalog_primer: "" }),
    ).toBe(false);
  });

  it("returns false for a null/undefined preface (no throw)", () => {
    expect(prefaceIsComplete(null as unknown as Preface)).toBe(false);
    expect(prefaceIsComplete(undefined as unknown as Preface)).toBe(false);
  });
});
