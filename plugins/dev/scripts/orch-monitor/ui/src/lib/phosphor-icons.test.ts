// phosphor-icons.test.ts — unit tests for the hybrid Phosphor resolver (CTL-1233).
// Sync tier: featured names resolve immediately. Async tier: full set after loadPhosphorRegistry().
import { describe, it, expect } from "bun:test";
import * as PhosphorIcons from "@phosphor-icons/react";
import {
  pascalToKebab,
  kebabToPascal,
  resolvePhosphorIcon,
  loadPhosphorRegistry,
  enumeratePhosphorGlyphNames,
  isPhosphorLoaded,
} from "./phosphor-icons";

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

describe("resolvePhosphorIcon (sync tier)", () => {
  it("resolves a featured name synchronously without loading the full set", () => {
    expect(resolvePhosphorIcon("git-fork")).toBeTruthy();
  });

  it("returns null for a non-featured name before the full set is loaded", () => {
    // Guard: in a shared-module run, project-mark-icon.test.tsx (alphabetically prior)
    // may call void loadPhosphorRegistry() via ProjectMarkIcon, populating the cache.
    // Post-load behavior is covered by the async tier below.
    if (!isPhosphorLoaded()) {
      expect(resolvePhosphorIcon("airplane")).toBeNull();
    }
  });

  it("returns null for a non-existent name", () => {
    expect(resolvePhosphorIcon("not-a-real-icon-xyz")).toBeNull();
  });
});

describe("loadPhosphorRegistry (async tier)", () => {
  it("loads the full set and exposes >1000 names", async () => {
    const names = await loadPhosphorRegistry();
    expect(names.length).toBeGreaterThan(1000);
  });

  it("makes non-featured names resolve synchronously after load", async () => {
    await loadPhosphorRegistry();
    expect(resolvePhosphorIcon("airplane")).toBeTruthy();
  });

  it("includes every featured name", async () => {
    const names = new Set(await loadPhosphorRegistry());
    for (const n of (await import("./project-glyph-set")).PHOSPHOR_GLYPH_NAMES) {
      expect(names.has(n)).toBe(true);
    }
  });

  it("is memoized: repeated calls return the same array reference", async () => {
    const a = await loadPhosphorRegistry();
    const b = await loadPhosphorRegistry();
    expect(a).toBe(b);
  });

  it("enumeratePhosphorGlyphNames returns the loaded names after load", async () => {
    await loadPhosphorRegistry();
    expect(enumeratePhosphorGlyphNames().length).toBeGreaterThan(1000);
  });

  it("has no duplicates", async () => {
    const names = await loadPhosphorRegistry();
    expect(new Set(names).size).toBe(names.length);
  });

  it("all names are round-trip stable (kebab→pascal→kebab)", async () => {
    for (const name of await loadPhosphorRegistry()) {
      expect(pascalToKebab(kebabToPascal(name))).toBe(name);
    }
  });
});
