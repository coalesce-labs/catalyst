// theme.ts — the calm-dark / warm-light theme core (CTL-893 / SHELL3).
//
// CTL-1147 extends the original two-state resolved Theme (dark|light) with a
// THREE-WAY ThemePreference layer (system|dark|light). The preference is what
// the user selects and what we persist; the resolved theme is what we apply to
// <html>. When preference is "system", the resolved theme follows
// matchMedia("(prefers-color-scheme: dark)") and updates live when the OS
// theme changes.
//
// Type note: the pure core uses STRUCTURAL types (the minimal `{ getItem }` /
// `{ classList: { add, remove } }` shapes) rather than the DOM globals `Storage`
// / `DOMTokenList`, so this module type-checks even where the importing package's
// tsconfig has no `dom` lib (the orch-monitor test package imports the pure
// functions). The hook reaches `window`/`document` through a typed `globalThis`
// view for the same reason.
import { useCallback, useEffect, useState } from "react";

// ── Resolved Theme (unchanged from CTL-893) ──────────────────────────────────

/** The two RESOLVED themes applied to <html>. */
export type Theme = "dark" | "light";

/** Every resolved theme — the single source the toggle + tests iterate. */
export const THEMES: readonly Theme[] = ["dark", "light"] as const;

/** Human label per resolved theme (CTL-1099 relabel). */
export const THEME_LABEL: Record<Theme, string> = {
  dark: "Dark",
  light: "Light",
};

/** localStorage key the preference persists under (survives reloads). */
export const THEME_STORAGE_KEY = "catalyst:theme";

/** Back-compat default resolved theme (was the default before CTL-1147). */
export const DEFAULT_THEME: Theme = "dark";

/** The other resolved theme — a pure two-state flip (dark ↔ light). */
export function nextTheme(theme: Theme): Theme {
  return theme === "dark" ? "light" : "dark";
}

// ── CTL-1147: ThemePreference (system | dark | light) ────────────────────────

/** What the user SELECTS and we persist. Resolves to a Theme at apply time. */
export type ThemePreference = "system" | "dark" | "light";

/** Every preference value — source of truth for the picker + tests. */
export const THEME_PREFERENCES: readonly ThemePreference[] = [
  "system",
  "dark",
  "light",
] as const;

/** Human label per preference (Appearance picker). */
export const PREFERENCE_LABEL: Record<ThemePreference, string> = {
  system: "System",
  dark: "Dark",
  light: "Light",
};

/** A fresh install (no stored preference) defaults to System (follows the OS). */
export const DEFAULT_PREFERENCE: ThemePreference = "system";

/** The minimal storage shape the read helpers need. */
interface ThemeStorage {
  getItem(key: string): string | null;
}

/** The minimal class-list shape `applyTheme` needs. */
interface ThemeClassList {
  add(token: string): void;
  remove(token: string): void;
}

/**
 * Read the persisted PREFERENCE (system|dark|light), defaulting to system.
 * Pure over an injected storage so it unit-tests without a real window.
 */
export function readStoredPreference(storage: ThemeStorage | null): ThemePreference {
  if (!storage) return DEFAULT_PREFERENCE;
  const raw = storage.getItem(THEME_STORAGE_KEY);
  return raw === "system" || raw === "dark" || raw === "light"
    ? raw
    : DEFAULT_PREFERENCE;
}

/**
 * Back-compat helper (kept for external callers). Reads and resolves to
 * a two-state Theme so callers that don't know about the preference still work.
 */
export function readStoredTheme(storage: ThemeStorage | null): Theme {
  if (!storage) return DEFAULT_THEME;
  const raw = storage.getItem(THEME_STORAGE_KEY);
  return raw === "light" ? "light" : "dark";
}

/** Map a preference + the OS dark flag to the concrete Theme we apply. */
export function resolveTheme(pref: ThemePreference, prefersDark: boolean): Theme {
  if (pref === "system") return prefersDark ? "dark" : "light";
  return pref;
}

/** 3-way cycle for the footer/palette toggle: system → dark → light → system. */
export function nextPreference(p: ThemePreference): ThemePreference {
  return p === "system" ? "dark" : p === "dark" ? "light" : "system";
}

/**
 * Apply a resolved Theme to the document root: dark adds `class="dark"`,
 * light removes it. Pure over an injected class-list so it unit-tests with a
 * minimal `{ add, remove }` shape rather than a real DOM node.
 */
export function applyTheme(
  theme: Theme,
  root: { classList: ThemeClassList } | null,
): void {
  if (!root) return;
  if (theme === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

// ── React hook ────────────────────────────────────────────────────────────────

/** Structural type for MediaQueryList (avoids the dom lib requirement). */
interface MinimalMQL {
  readonly matches: boolean;
  addEventListener(type: string, listener: (e: { matches: boolean }) => void): void;
  removeEventListener(type: string, listener: (e: { matches: boolean }) => void): void;
}

/** A typed view of the browser globals the hook needs (avoids the dom lib). */
interface BrowserGlobals {
  window?: { localStorage: ThemeStorage & { setItem(k: string, v: string): void } };
  document?: { documentElement: { classList: ThemeClassList } };
  matchMedia?: (q: string) => MinimalMQL;
}

function browser(): BrowserGlobals {
  return globalThis as unknown as BrowserGlobals;
}

function prefersDarkOS(): boolean {
  const mql = (globalThis as BrowserGlobals).matchMedia?.("(prefers-color-scheme: dark)");
  return mql ? mql.matches : false;
}

/**
 * React hook the footer toggle + Settings Appearance picker bind to.
 *
 * CTL-1147: drives off a ThemePreference (system|dark|light). When system,
 * subscribes to OS changes via matchMedia and updates live. The preference is
 * persisted to localStorage; the resolved theme is applied to <html>.
 *
 * `toggle()` cycles: system → dark → light → system.
 * `setPreference()` pins to an explicit choice.
 *
 * `setTheme()` is kept for back-compat but writes as the explicit preference.
 */
export function useTheme(): {
  preference: ThemePreference;
  theme: Theme;
  setPreference: (p: ThemePreference) => void;
  setTheme: (t: Theme) => void;
  toggle: () => void;
} {
  const [preference, setPref] = useState<ThemePreference>(() =>
    readStoredPreference(browser().window?.localStorage ?? null),
  );
  const [osDark, setOsDark] = useState<boolean>(() => prefersDarkOS());

  // Subscribe to OS changes only while preference is "system".
  useEffect(() => {
    if (preference !== "system") return;
    const mql = (globalThis as BrowserGlobals).matchMedia?.("(prefers-color-scheme: dark)");
    if (!mql) return;
    const onChange = (e: { matches: boolean }) => setOsDark(e.matches);
    mql.addEventListener("change", onChange);
    setOsDark(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [preference]);

  const theme = resolveTheme(preference, osDark);

  // Keep <html> and localStorage in sync. Persist the PREFERENCE (not the
  // resolved theme) so "system" round-trips correctly across reloads.
  useEffect(() => {
    const { window: win, document: doc } = browser();
    if (doc) applyTheme(theme, doc.documentElement);
    if (win) win.localStorage.setItem(THEME_STORAGE_KEY, preference);
  }, [theme, preference]);

  const setPreference = useCallback((p: ThemePreference) => setPref(p), []);
  const setTheme = useCallback((t: Theme) => setPref(t), []);
  const toggle = useCallback(() => setPref((p) => nextPreference(p)), []);

  return { preference, theme, setPreference, setTheme, toggle };
}
