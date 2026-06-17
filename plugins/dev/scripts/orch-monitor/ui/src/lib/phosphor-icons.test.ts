// phosphor-icons.test.ts — unit tests for the per-glyph Phosphor resolver (CTL-1249).
// Sync tier: featured names resolve immediately + a post-load cache. Async tier: per-glyph
// lazy load (cache + dedupe + .catch + timeout + retryable error) with injected fake importers,
// so tests never touch the real library or the network.
import { beforeEach, describe, it, expect } from "bun:test";
import { forwardRef } from "react";
import type { Icon, IconProps } from "@phosphor-icons/react";
import {
  enumeratePhosphorGlyphNames,
  resolvePhosphorIcon,
  loadGlyph,
  glyphLoadState,
  getGlyphError,
  pascalToKebab,
  kebabToPascal,
  __resetGlyphCaches,
  __setGlyphImporters,
} from "./phosphor-icons";
import { PHOSPHOR_GLYPH_NAMES } from "./project-glyph-set";

beforeEach(() => __resetGlyphCaches());

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

describe("round-trip stability over the static name index", () => {
  it("pascalToKebab and kebabToPascal are inverses for all index names", () => {
    const names = enumeratePhosphorGlyphNames();
    expect(names.length).toBeGreaterThan(1000);
    for (const name of names) {
      expect(pascalToKebab(kebabToPascal(name))).toBe(name);
    }
  });
});

describe("enumeratePhosphorGlyphNames", () => {
  it("returns the static index synchronously (no load) with >1500 names", () => {
    const names = enumeratePhosphorGlyphNames(); // no await
    expect(names.length).toBeGreaterThan(1500);
  });
  it("includes every featured name", () => {
    const set = new Set(enumeratePhosphorGlyphNames());
    for (const n of PHOSPHOR_GLYPH_NAMES) expect(set.has(n)).toBe(true);
  });
});

describe("loadGlyph (per-glyph async resolver, injected importers)", () => {
  // A real ForwardRefExoticComponent so the fixture satisfies `Icon`
  // (ForwardRefExoticComponent<IconProps>) — the type `.toBe(FakeFire)` infers
  // from loadGlyph/resolvePhosphorIcon — without an `as unknown as Icon` cast.
  const FakeFire: Icon = forwardRef<SVGSVGElement, IconProps>(() => null);
  it("resolves a kebab to a component, preferring mod[Pascal+'Icon']", async () => {
    __setGlyphImporters({ fire: () => Promise.resolve({ Fire: () => null, FireIcon: FakeFire }) });
    expect(await loadGlyph("fire")).toBe(FakeFire);
    expect(glyphLoadState("fire")).toBe("ready");
  });
  it("returns null + 'missing' for an unknown name", async () => {
    __setGlyphImporters({});
    expect(await loadGlyph("zzz-nope")).toBeNull();
    expect(glyphLoadState("zzz-nope")).toBe("missing");
  });
  it("falls back to mod[Pascal] when the Pascal+'Icon' export is absent", async () => {
    // Module exposes only `Fire` (no `FireIcon`) → resolves via the `?? mod[pascal]` branch.
    __setGlyphImporters({ fire: () => Promise.resolve({ Fire: FakeFire }) });
    expect(await loadGlyph("fire")).toBe(FakeFire);
    expect(glyphLoadState("fire")).toBe("ready");
  });
  it("returns null + 'error' when the importer resolves but the expected export is missing", async () => {
    // Importer is present and settles, but the module lacks both `FireIcon` and `Fire`.
    __setGlyphImporters({ fire: () => Promise.resolve({}) });
    expect(await loadGlyph("fire")).toBeNull();
    expect(glyphLoadState("fire")).toBe("error");
    expect(getGlyphError("fire")).toContain("export missing");
  });
  it("caches the resolved component (importer invoked once)", async () => {
    let calls = 0;
    __setGlyphImporters({ fire: () => (calls++, Promise.resolve({ FireIcon: FakeFire })) });
    await loadGlyph("fire");
    await loadGlyph("fire");
    expect(calls).toBe(1);
    expect(resolvePhosphorIcon("fire")).toBe(FakeFire); // sync read after load
  });
  it("dedupes concurrent in-flight loads", async () => {
    let calls = 0;
    __setGlyphImporters({ fire: () => (calls++, Promise.resolve({ FireIcon: FakeFire })) });
    await Promise.all([loadGlyph("fire"), loadGlyph("fire")]);
    expect(calls).toBe(1);
  });
  it("catches a rejected import, returns null, records the error, and DOES NOT memoize forever (retry succeeds)", async () => {
    let attempt = 0;
    __setGlyphImporters({
      fire: () =>
        ++attempt === 1
          ? Promise.reject(new Error("chunk 404"))
          : Promise.resolve({ FireIcon: FakeFire }),
    });
    expect(await loadGlyph("fire")).toBeNull();
    expect(glyphLoadState("fire")).toBe("error");
    expect(getGlyphError("fire")).toContain("chunk 404");
    expect(await loadGlyph("fire")).toBe(FakeFire); // retry re-attempts (no sticky rejected promise)
    expect(getGlyphError("fire")).toBeNull();
  });
  it("times out a hung import and settles to 'error' (not hang)", async () => {
    __setGlyphImporters({ hang: () => new Promise(() => {}) });
    expect(await loadGlyph("hang", 30)).toBeNull(); // injectable small timeout
    expect(glyphLoadState("hang")).toBe("error");
  });
});

describe("resolvePhosphorIcon (sync tier, no side-effect load)", () => {
  it("resolves a featured name synchronously", () => {
    expect(resolvePhosphorIcon("git-fork")).toBeTruthy();
  });
  it("returns null for a non-featured name not yet loaded (no auto-load)", () => {
    expect(resolvePhosphorIcon("airplane")).toBeNull();
  });
});
