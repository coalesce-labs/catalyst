// project-glyph-set.test.ts — unit tests for the curated Phosphor glyph set (CTL-1208, CTL-1226, CTL-1233).
// No DOM, no React — pure function tests.
// CTL-1233: parseGlyphRef is now fail-open for non-featured refs (shape-valid → accepted;
// component existence is checked lazily at render time).
import { describe, it, expect } from "bun:test";
import {
  PHOSPHOR_GLYPH_NAMES,
  isGlyphRef,
  parseGlyphRef,
  formatGlyphRef,
} from "./project-glyph-set";

describe("PHOSPHOR_GLYPH_NAMES", () => {
  it("is non-empty", () => {
    expect(PHOSPHOR_GLYPH_NAMES.length).toBeGreaterThan(0);
  });

  it("has no duplicates", () => {
    const set = new Set(PHOSPHOR_GLYPH_NAMES);
    expect(set.size).toBe(PHOSPHOR_GLYPH_NAMES.length);
  });
});

describe("formatGlyphRef", () => {
  it("formats a known glyph name with the phosphor prefix", () => {
    expect(formatGlyphRef("git-fork")).toBe("phosphor:git-fork");
  });

  it("formats any string with the prefix", () => {
    expect(formatGlyphRef("rocket")).toBe("phosphor:rocket");
  });
});

describe("parseGlyphRef", () => {
  it("parses a valid curated ref", () => {
    expect(parseGlyphRef("phosphor:git-fork")).toEqual({ set: "phosphor", name: "git-fork" });
  });

  it("parses a non-curated but valid full-set ref (airplane)", () => {
    expect(parseGlyphRef("phosphor:airplane")).toEqual({ set: "phosphor", name: "airplane" });
  });

  it("returns null for a favicon path", () => {
    expect(parseGlyphRef("public/favicon.svg")).toBeNull();
  });

  it("accepts a well-shaped non-featured ref even before the full set loads (fail-open, CTL-1233)", () => {
    // Shape-valid (non-empty phosphor: prefix) is the contract; component existence is checked lazily.
    expect(parseGlyphRef("phosphor:unknown-glyph-xyz")).toEqual({ set: "phosphor", name: "unknown-glyph-xyz" });
  });

  it("returns null for null", () => {
    expect(parseGlyphRef(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseGlyphRef("")).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseGlyphRef(undefined)).toBeNull();
  });

  it("returns null for bare phosphor: prefix with no name", () => {
    expect(parseGlyphRef("phosphor:")).toBeNull();
  });

  it("parses all curated names correctly", () => {
    for (const name of PHOSPHOR_GLYPH_NAMES) {
      const ref = `phosphor:${name}`;
      expect(parseGlyphRef(ref)).toEqual({ set: "phosphor", name });
    }
  });
});

describe("isGlyphRef", () => {
  it("returns true for a curated glyph ref", () => {
    expect(isGlyphRef("phosphor:git-fork")).toBe(true);
  });

  it("returns true for a non-curated but valid full-set ref (airplane)", () => {
    expect(isGlyphRef("phosphor:airplane")).toBe(true);
  });

  it("returns false for a favicon path", () => {
    expect(isGlyphRef("public/favicon.svg")).toBe(false);
  });

  it("returns true for a well-shaped non-existent phosphor name (fail-open, CTL-1233)", () => {
    // Shape-valid (non-empty phosphor: prefix) → accepted; render-time yields null if truly absent.
    expect(isGlyphRef("phosphor:not-a-real-icon")).toBe(true);
  });

  it("returns false for null", () => {
    expect(isGlyphRef(null)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isGlyphRef("")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isGlyphRef(undefined)).toBe(false);
  });

  it("returns false for bare phosphor: prefix with no name", () => {
    expect(isGlyphRef("phosphor:")).toBe(false);
  });

  it("returns true for all curated names", () => {
    for (const name of PHOSPHOR_GLYPH_NAMES) {
      expect(isGlyphRef(`phosphor:${name}`)).toBe(true);
    }
  });
});
