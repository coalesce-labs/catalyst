import { describe, expect, it } from "bun:test";
import { laneSurfaceBg } from "./lane-surface";
import { C, LANE_TINT_PCT } from "./board-tokens";

const COLORS = { "owner/a": "#3a2a5a" };

describe("laneSurfaceBg", () => {
  it("tints a lane whose repo has a resolved color over s1", () => {
    expect(laneSurfaceBg("owner/a", COLORS)).toBe(
      `color-mix(in oklab, #3a2a5a ${LANE_TINT_PCT}%, ${C.s1})`,
    );
  });
  it("leaves a lane with no color exactly C.s1", () => {
    expect(laneSurfaceBg("owner/b", COLORS)).toBe(C.s1);
    expect(laneSurfaceBg(null, COLORS)).toBe(C.s1);
    expect(laneSurfaceBg("owner/a", {})).toBe(C.s1);
  });
});
