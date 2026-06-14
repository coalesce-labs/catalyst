// brand.test.ts — CTL-1099 brand-axis contract tests.
//
// Pins the PURE brand core (mirrors theme.ts's app-shell-ia tests): the union,
// the persistence key, the default, the clamp, and the apply mechanism — all
// without a DOM (bun has none), via injected structural-type stubs.
//
//   cd ui && bun test src/lib/brand.test.ts
import { describe, it, expect } from "bun:test";
import {
  BRANDS,
  BRAND_LABEL,
  BRAND_STORAGE_KEY,
  DEFAULT_BRAND,
  readStoredBrand,
  applyBrand,
} from "./brand";

describe("CTL-1099 brand axis — constants", () => {
  it("the storage key + default are pinned", () => {
    expect(BRAND_STORAGE_KEY).toBe("catalyst:brand");
    expect(DEFAULT_BRAND).toBe("warm");
  });

  it("declares exactly the two brands warm + slate", () => {
    expect([...BRANDS]).toEqual(["warm", "slate"]);
  });

  it("every brand is labelled", () => {
    expect(BRAND_LABEL.warm).toBeTruthy();
    expect(BRAND_LABEL.slate).toBeTruthy();
  });
});

describe("CTL-1099 brand axis — readStoredBrand clamps to the default", () => {
  it("no storage → warm", () => {
    expect(readStoredBrand(null)).toBe("warm");
  });
  it("absent value → warm", () => {
    expect(readStoredBrand({ getItem: () => null })).toBe("warm");
  });
  it("stored 'slate' → slate", () => {
    expect(readStoredBrand({ getItem: () => "slate" })).toBe("slate");
  });
  it("stored 'warm' → warm", () => {
    expect(readStoredBrand({ getItem: () => "warm" })).toBe("warm");
  });
  it("junk → warm (clamped)", () => {
    expect(readStoredBrand({ getItem: () => "junk" })).toBe("warm");
  });
});

describe("CTL-1099 brand axis — applyBrand sets/removes data-theme", () => {
  function rootStub() {
    const set: Array<[string, string]> = [];
    const removed: string[] = [];
    return {
      set,
      removed,
      root: {
        setAttribute: (n: string, v: string) => set.push([n, v]),
        removeAttribute: (n: string) => removed.push(n),
      },
    };
  }

  it("slate sets data-theme=slate (never removes)", () => {
    const { set, removed, root } = rootStub();
    applyBrand("slate", root);
    expect(set).toContainEqual(["data-theme", "slate"]);
    expect(removed).toEqual([]);
  });

  it("warm removes data-theme and never sets it (warm is the no-attribute base)", () => {
    const { set, removed, root } = rootStub();
    applyBrand("warm", root);
    expect(removed).toContain("data-theme");
    expect(set).toEqual([]);
  });

  it("no-ops when there is no root (SSR / no DOM)", () => {
    expect(() => applyBrand("slate", null)).not.toThrow();
    expect(() => applyBrand("warm", null)).not.toThrow();
  });
});
