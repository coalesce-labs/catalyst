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
  __setManifestLoader,
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

describe("importer-manifest retry-hardening (CTL-1370, injected manifest loader)", () => {
  const FakeFire: Icon = forwardRef<SVGSVGElement, IconProps>(() => null);

  it("does NOT cache a rejected manifest — the next render retries and resolves (no page reload)", async () => {
    let attempt = 0;
    __setManifestLoader(() =>
      ++attempt === 1
        ? Promise.reject(new Error("manifest chunk 404"))
        : Promise.resolve({
            ICON_IMPORTERS: { fire: () => Promise.resolve({ FireIcon: FakeFire }) },
          }),
    );
    // First demand: the manifest load fails → the glyph settles to a retryable 'error'.
    expect(await loadGlyph("fire")).toBeNull();
    expect(glyphLoadState("fire")).toBe("error");
    // Second demand (dist healthy again): the manifest re-imports — glyph resolves, no reload.
    expect(await loadGlyph("fire")).toBe(FakeFire);
    expect(glyphLoadState("fire")).toBe("ready");
    expect(attempt).toBe(2); // the rejected manifest promise was cleared, not memoized forever
  });

  it("a manifest rejection during a concurrent burst never permanently poisons the session", async () => {
    let attempt = 0;
    __setManifestLoader(() =>
      ++attempt === 1
        ? Promise.reject(new Error("manifest chunk 404"))
        : Promise.resolve({
            ICON_IMPORTERS: {
              // both non-featured, so loadGlyph must go through the manifest (not the sync featured map)
              fire: () => Promise.resolve({ FireIcon: FakeFire }),
              airplane: () => Promise.resolve({ AirplaneIcon: FakeFire }),
            },
          }),
    );
    // A burst of glyph demands (like an icon-search render) races the failing manifest load.
    await Promise.all([loadGlyph("fire"), loadGlyph("airplane")]);
    // After the dist heals, a re-render resolves every glyph — no page reload, no sticky rejection.
    const [fire, airplane] = await Promise.all([loadGlyph("fire"), loadGlyph("airplane")]);
    expect(fire).toBe(FakeFire); // reference-equality (toEqual deep-compares forwardRef poorly)
    expect(airplane).toBe(FakeFire);
  });

  it("revives a manifest-errored glyph to 'idle' when the manifest later loads (UI self-heal)", async () => {
    // ProjectMarkIcon only calls loadGlyph from the "idle" state, so a glyph left in "error" would
    // never retry. When the manifest reloads (via any other glyph's demand), the stranded glyph must
    // be reset to "idle" so the component's idle-branch re-triggers it — without an explicit retry.
    let attempt = 0;
    __setManifestLoader(() =>
      ++attempt === 1
        ? Promise.reject(new Error("manifest chunk 404"))
        : Promise.resolve({
            ICON_IMPORTERS: {
              fire: () => Promise.resolve({ FireIcon: FakeFire }),
              airplane: () => Promise.resolve({ AirplaneIcon: FakeFire }),
            },
          }),
    );
    // "fire" hits the failing manifest and is stranded in "error".
    expect(await loadGlyph("fire")).toBeNull();
    expect(glyphLoadState("fire")).toBe("error");
    // A *different* glyph re-probes after the dist heals; loading the manifest revives "fire".
    expect(await loadGlyph("airplane")).toBe(FakeFire);
    expect(glyphLoadState("fire")).toBe("idle"); // back to idle → the UI re-triggers it
    expect(getGlyphError("fire")).toBeNull(); // the stale manifest error was cleared
    // …and the revived glyph then resolves on the (now idle-driven) re-trigger.
    expect(await loadGlyph("fire")).toBe(FakeFire);
  });

  it("a per-glyph error (not the manifest) is NOT revived by a later manifest reload", async () => {
    // A glyph whose own export is missing failed for a per-glyph reason, not a manifest outage —
    // a manifest reload must leave it in "error" (only manifest-stranded glyphs are revived).
    __setManifestLoader(() =>
      Promise.resolve({
        ICON_IMPORTERS: {
          fire: () => Promise.resolve({}), // present importer, but no Fire/FireIcon export
          airplane: () => Promise.resolve({ AirplaneIcon: FakeFire }),
        },
      }),
    );
    expect(await loadGlyph("fire")).toBeNull();
    expect(glyphLoadState("fire")).toBe("error");
    expect(await loadGlyph("airplane")).toBe(FakeFire); // re-enters the (already-loaded) manifest
    expect(glyphLoadState("fire")).toBe("error"); // still error — not a manifest casualty
  });

  it("caches a RESOLVED manifest — it is imported once across many glyph demands", async () => {
    let loads = 0;
    __setManifestLoader(() => {
      loads++;
      return Promise.resolve({
        ICON_IMPORTERS: {
          // non-featured names so each demand really hits the manifest path
          fire: () => Promise.resolve({ FireIcon: FakeFire }),
          airplane: () => Promise.resolve({ AirplaneIcon: FakeFire }),
        },
      });
    });
    await Promise.all([loadGlyph("fire"), loadGlyph("airplane")]);
    await loadGlyph("fire");
    expect(loads).toBe(1); // only the rejection path clears the cache; success stays memoized
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
