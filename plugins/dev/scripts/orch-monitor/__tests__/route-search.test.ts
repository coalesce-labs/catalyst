// route-search.test.ts — units for the typed search-param contract of the
// detail routes (CTL-881 / FND1). These encode the FND1 Gherkin acceptance
// scenarios "List-context survives a refresh or paste" and "A degraded
// deep-link with no context still works" against the PURE validator
// (ui/src/board/route-search.ts) — no React/router needed (same pattern as
// board-client.test.ts which units board-logic.ts directly).
import { describe, it, expect } from "bun:test";
import {
  validateDetailSearch,
  FROM_VALUES,
  LENS_VALUES,
  type DetailSearch,
} from "../ui/src/board/route-search";

describe("validateDetailSearch — typed contract (CTL-881)", () => {
  // Gherkin: "List-context survives a refresh or paste" — the full URL
  // /ticket/CTL-845?from=board&lens=linear&col=Implement&cursor=4 parses to all
  // four typed fields (from in board|stuck|recent, lens in linear|phase, col a
  // string, cursor a number).
  it("parses a full board-origin context with the right types", () => {
    const s = validateDetailSearch({ from: "board", lens: "linear", col: "Implement", cursor: 4 });
    expect(s).toEqual({ from: "board", lens: "linear", col: "Implement", cursor: 4 });
    expect(typeof s.cursor).toBe("number");
  });

  it("accepts cursor as a numeric string (hand-pasted URL form)", () => {
    const s = validateDetailSearch({ from: "stuck", lens: "phase", col: "implement", cursor: "7" });
    expect(s).toEqual({ from: "stuck", lens: "phase", col: "implement", cursor: 7 });
  });

  it("accepts every legal from value", () => {
    for (const from of FROM_VALUES) {
      expect(validateDetailSearch({ from }).from).toBe(from);
    }
  });

  it("accepts every legal lens value", () => {
    for (const lens of LENS_VALUES) {
      expect(validateDetailSearch({ lens }).lens).toBe(lens);
    }
  });

  it("treats col as an opaque string (any column name survives)", () => {
    expect(validateDetailSearch({ col: "Some Custom Column" }).col).toBe("Some Custom Column");
  });
});

describe("validateDetailSearch — safe-defaults / never-throws (CTL-881)", () => {
  // Gherkin: "unknown or malformed search params fall back to safe defaults
  // rather than throwing".
  it("drops an unknown from to undefined instead of throwing", () => {
    expect(validateDetailSearch({ from: "outerspace" })).toEqual({});
  });

  it("drops an unknown lens to undefined", () => {
    expect(validateDetailSearch({ lens: "kanban" })).toEqual({});
  });

  it("drops a non-string col (numbers/objects) to undefined", () => {
    expect(validateDetailSearch({ col: 42 })).toEqual({});
    expect(validateDetailSearch({ col: { x: 1 } })).toEqual({});
  });

  it("drops a non-numeric / malformed cursor to undefined", () => {
    expect(validateDetailSearch({ cursor: "abc" })).toEqual({});
    expect(validateDetailSearch({ cursor: NaN }).cursor).toBeUndefined();
    expect(validateDetailSearch({ cursor: Infinity }).cursor).toBeUndefined();
    expect(validateDetailSearch({ cursor: -1 }).cursor).toBeUndefined();
    expect(validateDetailSearch({ cursor: 2.5 }).cursor).toBeUndefined();
  });

  it("keeps the valid fields while dropping the malformed ones (partial URL)", () => {
    // col valid, cursor garbage, from valid, lens garbage → keep from+col only.
    const s = validateDetailSearch({ from: "recent", lens: "???", col: "PR", cursor: "x" });
    expect(s).toEqual({ from: "recent", col: "PR" });
  });

  it("never throws on hostile / non-object input", () => {
    const inputs: unknown[] = [null, undefined, "raw-string", 123, [], true];
    for (const input of inputs) {
      expect(() => validateDetailSearch(input)).not.toThrow();
      expect(validateDetailSearch(input)).toEqual({});
    }
  });
});

describe("validateDetailSearch — cold-link / degraded deep-link (CTL-881)", () => {
  // Gherkin: "A degraded deep-link with no context still works" — an empty
  // search object yields all-undefined context (a cold-link). FND2 adds pager
  // support for this case; FND1 only guarantees the contract parses cleanly.
  it("an empty search object is a valid cold-link (all fields absent)", () => {
    const s: DetailSearch = validateDetailSearch({});
    expect(s).toEqual({});
    expect(s.from).toBeUndefined();
    expect(s.lens).toBeUndefined();
    expect(s.col).toBeUndefined();
    expect(s.cursor).toBeUndefined();
  });
});
