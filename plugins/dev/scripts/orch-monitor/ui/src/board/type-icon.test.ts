// type-icon.test.ts — CTL-1022: the shared ticket-type symbol map is the single
// source for the board card's type pill (and any future type-symbol surface).
// Every known type must resolve a distinct icon + its board-tokens color + label,
// and any unknown/empty value must fail soft to the neutral dot fallback (icon:
// null) so a stray triage value never renders a broken card.
import { describe, expect, it } from "bun:test";
import { typeSymbol, KNOWN_TYPES } from "./type-icon";
import { TYPE } from "./board-tokens";

const FALLBACK_COLOR = "#9ba6b5"; // C.fgMuted

describe("typeSymbol", () => {
  it("exposes exactly the six known types", () => {
    expect(KNOWN_TYPES.sort()).toEqual(["bug", "chore", "docs", "feature", "refactor", "test"]);
  });

  for (const type of ["feature", "bug", "refactor", "chore", "docs", "test"]) {
    it(`resolves "${type}" to an icon, its TYPE color, and a label`, () => {
      const s = typeSymbol(type);
      expect(s.icon).not.toBeNull();
      // a lucide component is a renderable (forwardRef object or function)
      expect(["function", "object"]).toContain(typeof s.icon);
      expect(s.color).toBe(TYPE[type] as string);
      expect(s.label.length).toBeGreaterThan(0);
      // label is a human-readable Title-Case word, not the raw key
      expect(s.label[0]).toBe((s.label[0] ?? "").toUpperCase());
    });
  }

  it("maps each known type to its expected label", () => {
    expect(typeSymbol("feature").label).toBe("Feature");
    expect(typeSymbol("bug").label).toBe("Bug");
    expect(typeSymbol("refactor").label).toBe("Refactor");
    expect(typeSymbol("chore").label).toBe("Chore");
    expect(typeSymbol("docs").label).toBe("Docs");
    expect(typeSymbol("test").label).toBe("Test");
  });

  it("is case-insensitive on known keys", () => {
    const upper = typeSymbol("FEATURE");
    const lower = typeSymbol("feature");
    expect(upper.icon).toBe(lower.icon);
    expect(upper.color).toBe(lower.color);
    expect(upper.label).toBe(lower.label);
  });

  it("gives distinct icons to distinct known types", () => {
    const icons = KNOWN_TYPES.map((t) => typeSymbol(t).icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("falls back to a neutral dot (icon: null) for an unknown type", () => {
    const s = typeSymbol("task");
    expect(s.icon).toBeNull();
    expect(s.color).toBe(FALLBACK_COLOR);
  });

  it("falls back for empty, null, and undefined without throwing", () => {
    for (const v of ["", null, undefined]) {
      const s = typeSymbol(v);
      expect(s.icon).toBeNull();
      expect(s.color).toBe(FALLBACK_COLOR);
      expect(s.label).toBe("Unknown");
    }
  });
});
