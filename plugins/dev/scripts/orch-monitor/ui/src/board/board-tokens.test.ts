import { describe, expect, it } from "bun:test";
import { laneTint, LANE_TINT_PCT, C } from "./board-tokens";

describe("laneTint", () => {
  it("returns the base unchanged when no hue is given", () => {
    expect(laneTint(undefined, C.subtle)).toBe(C.subtle);
    expect(laneTint(null, C.subtle)).toBe(C.subtle);
  });

  it("composes the hue over the base as an oklab color-mix at LANE_TINT_PCT", () => {
    const out = laneTint("#3a2a5a", C.subtle);
    expect(out).toBe(`color-mix(in oklab, #3a2a5a ${LANE_TINT_PCT}%, ${C.subtle})`);
  });

  it("uses oklab interpolation, never srgb", () => {
    expect(laneTint("#3a2a5a", C.subtle)).toContain("in oklab");
    expect(laneTint("#3a2a5a", C.subtle)).not.toContain("in srgb");
  });

  it("keeps the tint barely-there (3–6%)", () => {
    expect(LANE_TINT_PCT).toBeGreaterThanOrEqual(3);
    expect(LANE_TINT_PCT).toBeLessThanOrEqual(6);
  });
});
