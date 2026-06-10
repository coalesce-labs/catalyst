// prefs.ts — the persisted LANDING-SURFACE preference (CTL-911 / SURF3).
//
// The Settings surface exposes three preference groups, and each one routes
// through the store that ALREADY owns that state on main — no parallel
// persistence systems:
//   - Board display defaults → `boardPrefsAtom` (board/prefs-store.ts, BOARD2 /
//     CTL-906) — the same atom the board's display-options popover writes.
//   - Theme                  → `@/lib/theme` (SHELL3 / CTL-893) — the
//     dark ⇄ light `.dark`-class system the footer toggle already uses.
//   - Sidebar collapse       → `@/lib/sidebar-collapse` (SHELL4 / CTL-894) via
//     the shell's controlled SidebarProvider.
//
// The ONE preference none of those own is which OPERATE surface opens first on
// a fresh load. That single pref lives here, following the same pattern as
// lib/theme.ts: a tiny pure core over an injected structural storage shape (so
// it unit-tests under bun with no DOM), plus browser-bound read/write helpers
// the shell + Settings surface call.
import { SURFACES, type Surface } from "./surface";

/** The surfaces eligible as a landing default — exactly the four OPERATE
 *  surfaces. Settings itself is a footer destination, never a landing. */
export const LANDING_SURFACES: readonly Surface[] = SURFACES;

/** localStorage key the landing-surface preference persists under. Named in the
 *  `catalyst:*` family like `catalyst:theme` / `catalyst:sidebar-open`. */
export const LANDING_SURFACE_STORAGE_KEY = "catalyst:landing-surface";

/** The default landing surface when nothing is stored — Home (the calm Inbox). */
export const DEFAULT_LANDING_SURFACE: Surface = "home";

/** The minimal storage shape the pure readers need (a `window.localStorage`). */
interface PrefsStorage {
  getItem(key: string): string | null;
}

/**
 * Clamp an arbitrary stored value to a valid landing surface. A first-ever
 * visit (null), junk, or a stale value that is no longer a surface all resolve
 * to the Home default — total, never throws.
 */
export function normalizeLandingSurface(value: unknown): Surface {
  return typeof value === "string" &&
    (SURFACES as readonly string[]).includes(value)
    ? (value as Surface)
    : DEFAULT_LANDING_SURFACE;
}

/**
 * Read the persisted landing surface, defaulting to Home. Pure over an injected
 * storage so it unit-tests without a real `window` (bun has none); the browser
 * helper below passes `window.localStorage`.
 */
export function readStoredLandingSurface(storage: PrefsStorage | null): Surface {
  if (!storage) return DEFAULT_LANDING_SURFACE;
  return normalizeLandingSurface(storage.getItem(LANDING_SURFACE_STORAGE_KEY));
}

/** A typed view of the browser globals (avoids requiring the dom lib, the same
 *  idiom as lib/theme.ts). */
interface BrowserGlobals {
  window?: {
    localStorage: PrefsStorage & { setItem(k: string, v: string): void };
  };
}

function browser(): BrowserGlobals {
  return globalThis as unknown as BrowserGlobals;
}

/** Browser-bound read — what the shell seeds its initial surface from. */
export function readLandingSurface(): Surface {
  return readStoredLandingSurface(browser().window?.localStorage ?? null);
}

/** Browser-bound write — what the Settings landing-surface control calls. */
export function writeLandingSurface(surface: Surface): void {
  const win = browser().window;
  if (!win) return;
  win.localStorage.setItem(LANDING_SURFACE_STORAGE_KEY, surface);
}
