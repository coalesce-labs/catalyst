// phosphor-featured.test.ts — verify the static featured icon map (CTL-1233).
import { describe, it, expect } from "bun:test";
import { FEATURED_ICONS } from "./phosphor-featured";
import { PHOSPHOR_GLYPH_NAMES } from "./project-glyph-set";

describe("FEATURED_ICONS", () => {
  it("has exactly one component per curated featured name", () => {
    for (const name of PHOSPHOR_GLYPH_NAMES) {
      expect(FEATURED_ICONS[name]).toBeTruthy();
    }
    expect(Object.keys(FEATURED_ICONS).length).toBe(PHOSPHOR_GLYPH_NAMES.length);
  });
});
