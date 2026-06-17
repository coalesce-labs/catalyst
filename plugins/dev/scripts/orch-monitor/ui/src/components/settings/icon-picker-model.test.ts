// icon-picker-model.test.ts — unit tests for the glyph-aware icon picker model (CTL-1208, CTL-1226, CTL-1233).
// No DOM, no React — pure function tests.
// CTL-1233: model split into buildBasePickerItems + buildAllGlyphItems + filterPickerItems.
import { describe, it, expect } from "bun:test";
import {
  buildBasePickerItems,
  buildAllGlyphItems,
  filterPickerItems,
  resolveActiveIconLabel,
} from "./icon-picker-model";
import type { IconCandidate } from "@/lib/repo-icons";
import { PHOSPHOR_GLYPH_NAMES } from "@/lib/project-glyph-set";

const CANDS: IconCandidate[] = [
  { path: "public/favicon.svg", format: "svg", downloadUrl: "u1", dataUrl: "data:svg" },
  { path: "favicon.ico", format: "ico", downloadUrl: "u2", dataUrl: "data:ico" },
];

describe("buildBasePickerItems", () => {
  it("is Auto + favicons + 36 featured (no full set)", () => {
    const items = buildBasePickerItems([{ path: "a/favicon.svg", format: "svg", downloadUrl: "u", dataUrl: "data:," }]);
    expect(items.filter((i) => i.group === "auto")).toHaveLength(1);
    expect(items.filter((i) => i.group === "favicon")).toHaveLength(1);
    expect(items.filter((i) => i.group === "glyph" && i.featured)).toHaveLength(PHOSPHOR_GLYPH_NAMES.length);
    expect(items.some((i) => i.group === "glyph" && !i.featured)).toBe(false);
  });

  it("first featured is phosphor:git-fork (curated order preserved)", () => {
    const items = buildBasePickerItems([]);
    expect(items.find((i) => i.group === "glyph" && i.featured)?.value).toBe("phosphor:git-fork");
  });

  it("yields Auto as the first item with value null", () => {
    const items = buildBasePickerItems(CANDS);
    expect(items[0]).toMatchObject({ value: null, label: "Auto", group: "auto" });
  });

  it("yields one item per candidate with the candidate path as value", () => {
    const items = buildBasePickerItems(CANDS);
    const favItems = items.filter((i) => i.group === "favicon");
    expect(favItems).toHaveLength(2);
    expect(favItems[0].value).toBe("public/favicon.svg");
    expect(favItems[1].value).toBe("favicon.ico");
  });

  it("featured glyph items match the curated list (featured: true)", () => {
    const items = buildBasePickerItems(CANDS);
    const featured = items.filter((i) => i.group === "glyph" && i.featured === true);
    expect(featured).toHaveLength(PHOSPHOR_GLYPH_NAMES.length);
    for (const item of featured) {
      expect(PHOSPHOR_GLYPH_NAMES).toContain(item.name!);
    }
  });

  it("works with no candidates (only Auto + featured glyphs)", () => {
    const items = buildBasePickerItems([]);
    expect(items[0].group).toBe("auto");
    expect(items.filter((i) => i.group === "favicon")).toHaveLength(0);
    expect(items.filter((i) => i.group === "glyph").length).toBe(PHOSPHOR_GLYPH_NAMES.length);
  });
});

describe("buildAllGlyphItems", () => {
  it("maps loaded names minus featured into non-featured glyph items", () => {
    const items = buildAllGlyphItems(["airplane", "git-fork", "zz-fake"]);
    expect(items.map((i) => i.name)).toEqual(["airplane", "zz-fake"]); // featured excluded
    expect(items.every((i) => i.group === "glyph" && i.featured === false)).toBe(true);
    expect(items[0].value).toBe("phosphor:airplane");
  });

  it("returns empty array for empty input", () => {
    expect(buildAllGlyphItems([])).toHaveLength(0);
  });

  it("excludes all featured names", () => {
    const allNames = [...PHOSPHOR_GLYPH_NAMES, "airplane", "anchor"];
    const items = buildAllGlyphItems(allNames);
    for (const item of items) {
      expect(PHOSPHOR_GLYPH_NAMES).not.toContain(item.name);
    }
  });
});

describe("filterPickerItems", () => {
  // Note: "bug" is a featured name (in PHOSPHOR_GLYPH_NAMES), so buildAllGlyphItems would
  // exclude it. Use non-featured names: "airplane", "anchor", "archive".
  it("returns all items for an empty query", () => {
    const items = buildAllGlyphItems(["airplane", "anchor", "archive"]);
    expect(filterPickerItems(items, "")).toHaveLength(3);
  });

  it("substring-matches on searchKey, case-insensitive", () => {
    const items = buildAllGlyphItems(["airplane", "anchor", "archive"]);
    expect(filterPickerItems(items, "AN").map((i) => i.name)).toEqual(["airplane", "anchor"]);
  });

  it("returns empty array when nothing matches", () => {
    const items = buildAllGlyphItems(["airplane", "anchor"]);
    expect(filterPickerItems(items, "zzz")).toHaveLength(0);
  });

  it("trims whitespace from query", () => {
    const items = buildAllGlyphItems(["airplane", "anchor", "archive"]);
    expect(filterPickerItems(items, "  archive  ")).toHaveLength(1);
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
