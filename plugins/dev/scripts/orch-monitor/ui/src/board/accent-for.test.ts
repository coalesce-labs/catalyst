// accent-for.test.ts — CTL-1153 (M2): unit tests for the accentFor repoAccents param.
// Imports from board-accent.ts (pure, no React) — Board.tsx re-exports for consumers.
import { describe, expect, it } from "bun:test";
import { accentFor } from "./board-accent";
import type { BoardActiveState } from "./types";

const C_BLUE = "#5e9ee8";

function ticket(overrides: Partial<{ phase: string; repo: string; type: string; activeState: BoardActiveState; status: string }> = {}) {
  return {
    phase: "implement",
    repo: "catalyst",
    type: "feature",
    activeState: null as BoardActiveState,
    status: "pending",
    ...overrides,
  };
}

describe("accentFor — phase colorBy", () => {
  it("returns the phase color for a known phase", () => {
    const result = accentFor(ticket({ phase: "implement" }), "phase");
    expect(result).toBe("#45c08a");
  });
  it("falls back to C.blue for an unknown phase", () => {
    expect(accentFor(ticket({ phase: "unknown-phase" }), "phase")).toBe(C_BLUE);
  });
  it("is unaffected by a repoAccents map", () => {
    const result = accentFor(ticket({ phase: "research" }), "phase", { catalyst: "#ff0000" });
    expect(result).toBe(C_BLUE); // research = C.blue
  });
});

describe("accentFor — repo colorBy (CTL-1153 M2)", () => {
  it("returns C.blue when no repoAccents provided", () => {
    expect(accentFor(ticket({ repo: "catalyst" }), "repo")).toBe(C_BLUE);
  });
  it("returns C.blue when repoAccents is an empty map", () => {
    expect(accentFor(ticket({ repo: "catalyst" }), "repo", {})).toBe(C_BLUE);
  });
  it("returns the mapped color from repoAccents when present", () => {
    expect(accentFor(ticket({ repo: "catalyst" }), "repo", { catalyst: "#a98ee3" })).toBe("#a98ee3");
  });
  it("falls back to C.blue when repo is missing from repoAccents", () => {
    expect(accentFor(ticket({ repo: "catalyst" }), "repo", { other: "#a98ee3" })).toBe(C_BLUE);
  });
  it("picks up any hex value from the map (not palette-constrained)", () => {
    expect(accentFor(ticket({ repo: "adva" }), "repo", { adva: "#ff00ff" })).toBe("#ff00ff");
  });
});

describe("accentFor — status colorBy", () => {
  it("returns the live cyan for an active ticket", () => {
    const live = accentFor(ticket({ activeState: "active" }), "status");
    expect(live).toBe("#53cde2");
  });
  it("returns red for stuck", () => {
    const result = accentFor(ticket({ activeState: "stuck" }), "status");
    expect(result).toBe("#e36b6b");
  });
  it("returns red for failed status", () => {
    const result = accentFor(ticket({ status: "failed", activeState: null }), "status");
    expect(result).toBe("#e36b6b");
  });
  it("returns fgDim CSS var for an idle ticket", () => {
    const result = accentFor(ticket({ activeState: null }), "status");
    expect(result).toBe("var(--fg-dim)");
  });
});
