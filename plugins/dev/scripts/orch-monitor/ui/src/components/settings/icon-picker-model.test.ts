// icon-picker-model.test.ts — unit tests for the glyph-aware icon picker model (CTL-1208, CTL-1226).
// No DOM, no React — pure function tests.
import { describe, it, expect } from "bun:test";
import { buildIconPickerItems, resolveActiveIconLabel } from "./icon-picker-model";
import type { IconCandidate } from "@/lib/repo-icons";
import { PHOSPHOR_GLYPH_NAMES } from "@/lib/project-glyph-set";

const CANDS: IconCandidate[] = [
  { path: "public/favicon.svg", format: "svg", downloadUrl: "u1", dataUrl: "data:svg" },
  { path: "favicon.ico", format: "ico", downloadUrl: "u2", dataUrl: "data:ico" },
];

describe("buildIconPickerItems", () => {
  it("yields Auto as the first item with value null", () => {
    const items = buildIconPickerItems(CANDS);
    expect(items[0]).toMatchObject({ value: null, label: "Auto", group: "auto" });
  });

  it("yields one item per candidate with the candidate path as value", () => {
    const items = buildIconPickerItems(CANDS);
    const favItems = items.filter((i) => i.group === "favicon");
    expect(favItems).toHaveLength(2);
    expect(favItems[0].value).toBe("public/favicon.svg");
    expect(favItems[1].value).toBe("favicon.ico");
  });

  it("featured glyph items match the curated list (featured: true)", () => {
    const items = buildIconPickerItems(CANDS);
    const featured = items.filter((i) => i.group === "glyph" && i.featured === true);
    expect(featured).toHaveLength(PHOSPHOR_GLYPH_NAMES.length);
    for (const item of featured) {
      expect(PHOSPHOR_GLYPH_NAMES).toContain(item.name);
    }
  });

  it("non-featured glyph items cover the full icon set beyond the curated list", () => {
    const items = buildIconPickerItems(CANDS);
    const allGlyphs = items.filter((i) => i.group === "glyph");
    expect(allGlyphs.length).toBeGreaterThan(1000);
    const nonFeatured = allGlyphs.filter((i) => !i.featured);
    expect(nonFeatured.length).toBeGreaterThan(1000 - PHOSPHOR_GLYPH_NAMES.length);
  });

  it("featured items come before non-featured items in the glyph group", () => {
    const items = buildIconPickerItems(CANDS);
    const glyphItems = items.filter((i) => i.group === "glyph");
    let seenNonFeatured = false;
    for (const item of glyphItems) {
      if (!item.featured) seenNonFeatured = true;
      if (seenNonFeatured) expect(item.featured).toBeFalsy();
    }
  });

  it("first featured glyph is phosphor:git-fork (curated order preserved)", () => {
    const items = buildIconPickerItems(CANDS);
    const firstGlyph = items.find((i) => i.group === "glyph");
    expect(firstGlyph?.value).toBe("phosphor:git-fork");
    expect(firstGlyph?.name).toBe("git-fork");
    expect(firstGlyph?.featured).toBe(true);
  });

  it("no duplicate glyph values (curated names appear exactly once)", () => {
    const items = buildIconPickerItems(CANDS);
    const values = items.filter((i) => i.group === "glyph").map((i) => i.value);
    expect(new Set(values).size).toBe(values.length);
    // Each curated name appears exactly once
    for (const name of PHOSPHOR_GLYPH_NAMES) {
      const count = values.filter((v) => v === `phosphor:${name}`).length;
      expect(count).toBe(1);
    }
  });

  it("works with no candidates (only Auto + glyphs)", () => {
    const items = buildIconPickerItems([]);
    expect(items[0].group).toBe("auto");
    expect(items.filter((i) => i.group === "favicon")).toHaveLength(0);
    expect(items.filter((i) => i.group === "glyph").length).toBeGreaterThan(100);
  });

  it("total item count is 1 + candidates + full glyph set (> 1000 glyphs)", () => {
    const items = buildIconPickerItems(CANDS);
    const glyphCount = items.filter((i) => i.group === "glyph").length;
    expect(items).toHaveLength(1 + CANDS.length + glyphCount);
    expect(glyphCount).toBeGreaterThan(1000);
  });
});

describe("resolveActiveIconLabel", () => {
  it("returns 'Auto' for null", () => {
    expect(resolveActiveIconLabel(null)).toBe("Auto");
  });

  it("returns a human-readable glyph label for a phosphor: ref (hyphens → spaces)", () => {
    const label = resolveActiveIconLabel("phosphor:git-fork");
    expect(label).toBe("git fork");
  });

  it("returns a label for a non-curated full-set ref (airplane)", () => {
    expect(resolveActiveIconLabel("phosphor:airplane")).toBe("airplane");
  });

  it("returns a favicon label for a path string", () => {
    const label = resolveActiveIconLabel("public/favicon.svg");
    expect(label).toContain("favicon");
  });
});
