// theme.ts — the calm-dark / warm-light theme core (CTL-893 / SHELL3).
//
// The prototype's footer theme toggle referenced `@/lib/theme` `useTheme()`, but
// the real orch-monitor app had no JS theme system — it only hard-coded
// `class="dark"` on <html> (board.html). This module is that theme system: the
// PURE, framework-agnostic core (the theme union, the persistence key, the
// localStorage read, the next-theme flip, and the `documentElement` class apply)
// plus a thin React `useTheme()` hook that the SidebarFooter toggle binds to.
//
// Calm-dark is the default (board.html / index.html still ship `class="dark"`,
// and an absent stored preference resolves to dark). Flipping the toggle
// adds/removes the `dark` class on <html>; the warm-light token block in app.css
// takes over when `dark` is absent. Kept React-free in its core so the contract
// is unit-testable without a DOM (the same pattern lib/surface.ts follows).
//
// Type note: the pure core uses STRUCTURAL types (the minimal `{ getItem }` /
// `{ classList: { add, remove } }` shapes) rather than the DOM globals `Storage`
// / `DOMTokenList`, so this module type-checks even where the importing package's
// tsconfig has no `dom` lib (the orch-monitor test package imports the pure
// functions). The hook reaches `window`/`document` through a typed `globalThis`
// view for the same reason.
import { useCallback, useEffect, useState } from "react";

/** The two themes the footer toggle flips between. */
export type Theme = "dark" | "light";

/** Every theme — the single source the toggle + tests iterate. */
export const THEMES: readonly Theme[] = ["dark", "light"] as const;

/** Human label per theme (toggle aria-label / tooltip). */
export const THEME_LABEL: Record<Theme, string> = {
  dark: "Calm dark",
  light: "Warm light",
};

/** localStorage key the resolved preference persists under (survives reloads). */
export const THEME_STORAGE_KEY = "catalyst:theme";

/** The default theme when no preference is stored — calm-dark. */
export const DEFAULT_THEME: Theme = "dark";

/** The other theme — a pure two-state flip (dark ↔ light). */
export function nextTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

/** The minimal storage shape `readStoredTheme` needs (a `window.localStorage`). */
interface ThemeStorage {
  getItem(key: string): string | null;
}

/** The minimal class-list shape `applyTheme` needs (`element.classList`). */
interface ThemeClassList {
  add(token: string): void;
  remove(token: string): void;
}

/**
 * Read the persisted theme, defaulting to calm-dark. Pure over an injected
 * storage so it unit-tests without a real `window` (bun has none); the React
 * hook below passes `window.localStorage`.
 */
export function readStoredTheme(storage: ThemeStorage | null): Theme {
  if (!storage) return DEFAULT_THEME;
  const raw = storage.getItem(THEME_STORAGE_KEY);
  return raw === "light" || raw === "dark" ? raw : DEFAULT_THEME;
}

/**
 * Apply a theme to the document root: dark adds `class="dark"` (Tailwind's dark
 * variant + the dark token block), light removes it (the warm-light `:root`
 * block in app.css takes over). Pure over an injected class-list so it unit-tests
 * with a minimal `{ add, remove }` shape rather than a real DOM node.
 */
export function applyTheme(
  theme: Theme,
  root: { classList: ThemeClassList } | null,
): void {
  if (!root) return;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

/** A typed view of the browser globals the hook needs (avoids the dom lib). */
interface BrowserGlobals {
  window?: { localStorage: ThemeStorage & { setItem(k: string, v: string): void } };
  document?: { documentElement: { classList: ThemeClassList } };
}

function browser(): BrowserGlobals {
  return globalThis as unknown as BrowserGlobals;
}

/**
 * React hook the footer toggle binds to. Resolves the stored preference on
 * mount, keeps `<html>` in sync, and persists every change. `toggle()` flips
 * calm-dark ⇄ warm-light.
 */
export function useTheme(): {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
} {
  const [theme, setThemeState] = useState<Theme>(() =>
    readStoredTheme(browser().window?.localStorage ?? null),
  );

  // Keep <html> and localStorage in sync with the resolved theme.
  useEffect(() => {
    const { window: win, document: doc } = browser();
    if (doc) applyTheme(theme, doc.documentElement);
    if (win) win.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => setThemeState(t), []);
  const toggle = useCallback(() => setThemeState((t) => nextTheme(t)), []);

  return { theme, setTheme, toggle };
}
