// project-glyph-set.test.ts — unit tests for the curated Phosphor glyph set (CTL-1208).
// No DOM, no React — pure function tests.
import { describe, it, expect } from "bun:test";
import {
  PHOSPHOR_GLYPH_NAMES,
  GLYPH_COMPONENTS,
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

describe("GLYPH_COMPONENTS", () => {
  it("has an entry for every PHOSPHOR_GLYPH_NAMES entry", () => {
    for (const name of PHOSPHOR_GLYPH_NAMES) {
      expect(GLYPH_COMPONENTS[name]).toBeDefined();
    }
  });

  it("has no extra keys beyond PHOSPHOR_GLYPH_NAMES", () => {
    const names = new Set(PHOSPHOR_GLYPH_NAMES);
    for (const key of Object.keys(GLYPH_COMPONENTS)) {
      expect(names.has(key)).toBe(true);
    }
  });

  it("GLYPH_COMPONENTS keys match PHOSPHOR_GLYPH_NAMES exactly", () => {
    expect(Object.keys(GLYPH_COMPONENTS).sort()).toEqual([...PHOSPHOR_GLYPH_NAMES].sort());
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

  it("returns null for a favicon path", () => {
    expect(parseGlyphRef("public/favicon.svg")).toBeNull();
  });

  it("returns null for an uncurated phosphor name", () => {
    expect(parseGlyphRef("phosphor:unknown-glyph-xyz")).toBeNull();
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

  it("returns false for a favicon path", () => {
    expect(isGlyphRef("public/favicon.svg")).toBe(false);
  });

  it("returns false for an uncurated phosphor name", () => {
    expect(isGlyphRef("phosphor:not-in-set")).toBe(false);
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
