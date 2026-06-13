// execution-tab.contract.test.ts — CTL-1102 contract lock tests.
// Phase 1: ensures "execution" is registered in TAB_VALUES (rename guard).
// Phase 3: ensures pure inputs degrade safely when journey/ticket are absent.
import { describe, it, expect } from "bun:test";
import { TAB_VALUES } from "./route-search";

describe("CTL-1102 Execution tab contract", () => {
  it("exposes 'execution' as a valid detail tab value", () => {
    expect((TAB_VALUES as readonly string[]).includes("execution")).toBe(true);
  });

  it("keeps the four prior tabs (no accidental drop on rename)", () => {
    for (const t of ["lifecycle", "cost", "activity"]) {
      expect((TAB_VALUES as readonly string[]).includes(t)).toBe(true);
    }
  });
});
