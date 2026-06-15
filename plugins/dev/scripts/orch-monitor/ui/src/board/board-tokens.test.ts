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

  it("keeps the tint perceptible but calm (CTL-1168: ~doubled to 18%, capped at 25%)", () => {
    // CTL-1168: 9 → 18 so per-project lanes read clearly; an oklab mix this low is
    // still a calm tint, not a saturated fill. Upper bound guards against a future
    // bump turning the band into a solid color block.
    expect(LANE_TINT_PCT).toBeGreaterThanOrEqual(16);
    expect(LANE_TINT_PCT).toBeLessThanOrEqual(25);
  });
});
