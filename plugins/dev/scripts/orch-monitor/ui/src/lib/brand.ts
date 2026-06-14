// brand.ts — the Warm / Slate BRAND theme core (CTL-1099).
//
// CTL-1099 introduces a SECOND, orthogonal theme axis to the MODE axis owned by
// lib/theme.ts. The two axes:
//   - MODE (lib/theme.ts): `.dark` class on <html>, catalyst:theme. dark ⇄ light.
//   - BRAND (this module):  `data-theme` attribute on <html>, catalyst:brand.
//                           warm ⇄ slate.
//
// WARM is the no-attribute DEFAULT (FOUC-free — the base :root / .dark CSS blocks
// ARE warm), so `applyBrand('warm', root)` REMOVES the attribute and
// `applyBrand('slate', root)` SETS data-theme="slate", which the
// `:root[data-theme="slate"]` (slate-light) and `.dark[data-theme="slate"]`
// (slate-dark) override blocks in app.css select on.
//
// Structurally this mirrors lib/theme.ts: a PURE, framework-agnostic core (the
// brand union, the persistence key, the localStorage read, the apply) plus a thin
// React `useBrand()` hook the Settings Theme picker + the ⌘K brand command bind to.
//
// Type note: the pure core uses STRUCTURAL types (a minimal `{ setAttribute,
// removeAttribute }` shape) rather than the DOM globals `Element` / `HTMLElement`,
// so this module type-checks even where the importing package's tsconfig has no
// `dom` lib (the orch-monitor test package imports the pure functions). The hook
// reaches `window`/`document` through a typed `globalThis` view for the same reason.
import { useCallback, useEffect, useState } from "react";

/** The two brand themes the picker flips between. */
export type Brand = "warm" | "slate";

/** Every brand — the single source the picker + tests iterate. */
export const BRANDS: readonly Brand[] = ["warm", "slate"] as const;

/** Human label per brand (the Settings Theme picker option labels). */
export const BRAND_LABEL: Record<Brand, string> = {
  warm: "Warm",
  slate: "Slate",
};

/** localStorage key the resolved brand persists under (survives reloads). */
export const BRAND_STORAGE_KEY = "catalyst:brand";

/** The default brand when no preference is stored — warm (the no-attribute base). */
export const DEFAULT_BRAND: Brand = "warm";

/** The other brand — a pure two-state flip (warm ↔ slate). */
export function nextBrand(brand: Brand): Brand {
  return brand === "warm" ? "slate" : "warm";
}

/** The minimal storage shape `readStoredBrand` needs (a `window.localStorage`). */
interface BrandStorage {
  getItem(key: string): string | null;
}

/** The minimal element shape `applyBrand` needs (`document.documentElement`). */
interface BrandRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Read the persisted brand, defaulting to warm. Pure over an injected storage so
 * it unit-tests without a real `window` (bun has none); the React hook below
 * passes `window.localStorage`. Junk values clamp to the default.
 */
export function readStoredBrand(storage: BrandStorage | null): Brand {
  if (!storage) return DEFAULT_BRAND;
  const raw = storage.getItem(BRAND_STORAGE_KEY);
  return raw === "slate" || raw === "warm" ? raw : DEFAULT_BRAND;
}

/**
 * Apply a brand to the document root: slate sets `data-theme="slate"` (the
 * slate-light / slate-dark override blocks take over), warm REMOVES the
 * attribute (warm is the no-attribute base — the :root / .dark blocks ARE warm).
 * Pure over an injected element so it unit-tests with a minimal
 * `{ setAttribute, removeAttribute }` shape rather than a real DOM node.
 */
export function applyBrand(brand: Brand, root: BrandRoot | null): void {
  if (!root) return;
  if (brand === "slate") root.setAttribute("data-theme", "slate");
  else root.removeAttribute("data-theme");
}

/** A typed view of the browser globals the hook needs (avoids the dom lib). */
interface BrowserGlobals {
  window?: {
    localStorage: BrandStorage & { setItem(k: string, v: string): void };
  };
  document?: { documentElement: BrandRoot };
}

function browser(): BrowserGlobals {
  return globalThis as unknown as BrowserGlobals;
}

/**
 * React hook the Settings Theme picker + the ⌘K brand command bind to. Resolves
 * the stored brand on mount, keeps `<html>`'s data-theme in sync, and persists
 * every change. `cycle()` flips warm ⇄ slate.
 */
export function useBrand(): {
  brand: Brand;
  setBrand: (b: Brand) => void;
  cycle: () => void;
} {
  const [brand, setBrandState] = useState<Brand>(() =>
    readStoredBrand(browser().window?.localStorage ?? null),
  );

  // Keep <html>'s data-theme attribute and localStorage in sync with the brand.
  useEffect(() => {
    const { window: win, document: doc } = browser();
    if (doc) applyBrand(brand, doc.documentElement);
    if (win) win.localStorage.setItem(BRAND_STORAGE_KEY, brand);
  }, [brand]);

  const setBrand = useCallback((b: Brand) => setBrandState(b), []);
  const cycle = useCallback(() => setBrandState((b) => nextBrand(b)), []);

  return { brand, setBrand, cycle };
}
