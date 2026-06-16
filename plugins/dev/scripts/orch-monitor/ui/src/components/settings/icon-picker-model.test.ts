// icon-picker-model.test.ts — unit tests for the glyph-aware icon picker model (CTL-1208).
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
    const items = buildIconPickerItems(CANDS, PHOSPHOR_GLYPH_NAMES);
    expect(items[0]).toMatchObject({ value: null, label: "Auto", group: "auto" });
  });

  it("yields one item per candidate with the candidate path as value", () => {
    const items = buildIconPickerItems(CANDS, PHOSPHOR_GLYPH_NAMES);
    const favItems = items.filter((i) => i.group === "favicon");
    expect(favItems).toHaveLength(2);
    expect(favItems[0].value).toBe("public/favicon.svg");
    expect(favItems[1].value).toBe("favicon.ico");
  });

  it("yields one glyph item per curated glyph name with phosphor: value", () => {
    const items = buildIconPickerItems(CANDS, PHOSPHOR_GLYPH_NAMES);
    const glyphItems = items.filter((i) => i.group === "glyph");
    expect(glyphItems).toHaveLength(PHOSPHOR_GLYPH_NAMES.length);
    for (const item of glyphItems) {
      expect(item.value).toMatch(/^phosphor:/);
    }
  });

  it("first glyph item is phosphor:git-fork (first in the curated list)", () => {
    const items = buildIconPickerItems(CANDS, PHOSPHOR_GLYPH_NAMES);
    const firstGlyph = items.find((i) => i.group === "glyph");
    expect(firstGlyph?.value).toBe("phosphor:git-fork");
    expect(firstGlyph?.name).toBe("git-fork");
  });

  it("works with no candidates (only Auto + glyphs)", () => {
    const items = buildIconPickerItems([], PHOSPHOR_GLYPH_NAMES);
    expect(items[0].group).toBe("auto");
    expect(items.filter((i) => i.group === "favicon")).toHaveLength(0);
    expect(items.filter((i) => i.group === "glyph")).toHaveLength(PHOSPHOR_GLYPH_NAMES.length);
  });

  it("total item count is 1 + candidates.length + glyphs.length", () => {
    const items = buildIconPickerItems(CANDS, PHOSPHOR_GLYPH_NAMES);
    expect(items).toHaveLength(1 + CANDS.length + PHOSPHOR_GLYPH_NAMES.length);
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

  it("returns a favicon label for a path string", () => {
    const label = resolveActiveIconLabel("public/favicon.svg");
    expect(label).toContain("favicon");
  });
});
