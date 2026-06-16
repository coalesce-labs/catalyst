// phosphor-icons.test.ts — unit tests for the universal Phosphor resolver (CTL-1226).
import { describe, it, expect } from "bun:test";
import * as PhosphorIcons from "@phosphor-icons/react";
import {
  pascalToKebab,
  kebabToPascal,
  resolvePhosphorIcon,
  enumeratePhosphorGlyphNames,
} from "./phosphor-icons";
import { PHOSPHOR_GLYPH_NAMES } from "./project-glyph-set";

describe("pascalToKebab", () => {
  it("converts GitFork to git-fork", () => {
    expect(pascalToKebab("GitFork")).toBe("git-fork");
  });

  it("converts TerminalWindow to terminal-window", () => {
    expect(pascalToKebab("TerminalWindow")).toBe("terminal-window");
  });

  it("converts Tree to tree", () => {
    expect(pascalToKebab("Tree")).toBe("tree");
  });

  it("converts HardDrives to hard-drives", () => {
    expect(pascalToKebab("HardDrives")).toBe("hard-drives");
  });
});

describe("kebabToPascal", () => {
  it("converts git-fork to GitFork", () => {
    expect(kebabToPascal("git-fork")).toBe("GitFork");
  });

  it("converts terminal-window to TerminalWindow", () => {
    expect(kebabToPascal("terminal-window")).toBe("TerminalWindow");
  });

  it("converts tree to Tree", () => {
    expect(kebabToPascal("tree")).toBe("Tree");
  });
});

describe("round-trip stability over the full exported set", () => {
  it("pascalToKebab and kebabToPascal are inverses for all icon exports", () => {
    const registry = PhosphorIcons as unknown as Record<string, unknown>;
    const allPascalNames = Object.keys(registry).filter(
      (k) => !k.endsWith("Icon") && `${k}Icon` in registry,
    );
    expect(allPascalNames.length).toBeGreaterThan(1000);
    for (const p of allPascalNames) {
      expect(kebabToPascal(pascalToKebab(p))).toBe(p);
    }
  });
});

describe("resolvePhosphorIcon", () => {
  it("returns a component for a curated name (git-fork)", () => {
    expect(resolvePhosphorIcon("git-fork")).toBeTruthy();
  });

  it("returns a component for another curated name (tree)", () => {
    expect(resolvePhosphorIcon("tree")).toBeTruthy();
  });

  it("returns a component for a non-curated full-set name (airplane)", () => {
    expect(resolvePhosphorIcon("airplane")).toBeTruthy();
  });

  it("returns null for a non-existent name", () => {
    expect(resolvePhosphorIcon("not-a-real-icon-xyz")).toBeNull();
  });
});

describe("enumeratePhosphorGlyphNames", () => {
  it("returns more than 1000 icons", () => {
    expect(enumeratePhosphorGlyphNames().length).toBeGreaterThan(1000);
  });

  it("includes every curated name from PHOSPHOR_GLYPH_NAMES", () => {
    const allNames = new Set(enumeratePhosphorGlyphNames());
    for (const name of PHOSPHOR_GLYPH_NAMES) {
      expect(allNames.has(name)).toBe(true);
    }
  });

  it("has no duplicates", () => {
    const names = enumeratePhosphorGlyphNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("all names resolve to a component", () => {
    for (const name of enumeratePhosphorGlyphNames()) {
      expect(resolvePhosphorIcon(name)).toBeTruthy();
    }
  });

  it("all names are round-trip stable (kebab→pascal→kebab)", () => {
    for (const name of enumeratePhosphorGlyphNames()) {
      expect(pascalToKebab(kebabToPascal(name))).toBe(name);
    }
  });

  it("returns the same array on repeated calls (memoized)", () => {
    const a = enumeratePhosphorGlyphNames();
    const b = enumeratePhosphorGlyphNames();
    expect(a).toBe(b);
  });
});
