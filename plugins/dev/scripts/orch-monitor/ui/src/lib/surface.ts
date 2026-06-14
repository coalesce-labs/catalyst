// surface.ts — the app-shell surface contract (CTL-891 / SHELL1).
//
// Ported from the prototype `mockups/home-proto/src/lib/surface.ts`. This is the
// PURE, framework-agnostic core of the shell: the surface union, the `g`-chord
// jump map, and the per-surface breadcrumb trail. AppShell/AppSidebar consume it;
// keeping it free of React makes the keyboard/IA contract unit-testable without a
// DOM (the same pattern board-logic.ts / route-search.ts follow).
//
// CTL-989 — the active surface is now DERIVED from the URL (the router is the
// source of truth for location). `useSurface()` reads `location.pathname` via
// TanStack Router state and maps it to a surface; there is no React surface
// state and no surface-mutating context method — nav goes through
// router.navigate at the call site. The pure pathname↔surface map lives in
// route-surface.ts.
import { useRouterState } from "@tanstack/react-router";
import { pathnameToSurface, SETTINGS_PATH } from "./route-surface";
import type { Surface } from "./surface-constants";

// Pure constants live in surface-constants.ts (React-/router-free) so tests that
// import surface-actions.ts don't transitively pull in @tanstack/react-router.
export {
  type Surface,
  SURFACES,
  SURFACE_LABEL,
  SURFACE_CHORD,
  SURFACE_BREADCRUMB,
} from "./surface-constants";

/**
 * Breadcrumb for the Settings surface (CTL-911 / SURF3). Settings is a FOOTER
 * destination, NOT one of the four OPERATE landing surfaces — so it stays out
 * of the `Surface` union / `SURFACES` / `SURFACE_CHORD` (which the shell's nav,
 * the command palette, and the landing-surface preference all iterate). The
 * shell renders it via a separate open-flag, with this trail in the top strip.
 */
export const SETTINGS_BREADCRUMB: string[] = ["Settings"];

/** The single canonical input-focus guard (CTL-1025) — re-exported from
 *  lib/typing-target so the existing callers (command-palette.ts, sidebar-collapse.ts)
 *  keep compiling unchanged while gaining SELECT + contentEditable coverage. */
export { isTypingTarget, type TypingTargetLike } from "./typing-target";

/**
 * The route-derived shell location (CTL-989). The old surface-mutating + settings
 * context methods are GONE — navigation is `router.navigate` at the call site.
 * The shape keeps `surface` (the nav-highlight surface) + `settingsOpen` (the
 * Settings item active flag) so the sidebar's existing `const { surface,
 * settingsOpen } = useSurface()` destructure keeps compiling.
 */
export interface ShellLocation {
  /** The nav-highlight surface. Settings + detail pages resolve to an OPERATE
   *  surface here so the left nav keeps a sensible highlight (settingsOpen drives
   *  the Settings item's own active state separately). */
  surface: Surface;
  /** Whether the Settings route (`/settings`) is the current location. */
  settingsOpen: boolean;
}

/**
 * Derive the active shell location from the URL. The router is the source of
 * truth: `pathnameToSurface` maps `location.pathname` (+ the `?from` search for
 * detail pages) to a surface or "settings". Settings resolves the nav-highlight
 * `surface` to the board (it highlights nothing of the four OPERATE items) while
 * `settingsOpen` separately lights the footer Settings item.
 */
export function useSurface(): ShellLocation {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const from = useRouterState({
    select: (s) => {
      const search = s.location.search as { from?: unknown };
      return typeof search.from === "string" ? search.from : undefined;
    },
  });
  const derived = pathnameToSurface(pathname, from ? { from } : undefined);
  const settingsOpen = pathname === SETTINGS_PATH;
  const surface: Surface = derived === "settings" ? "board" : derived;
  return { surface, settingsOpen };
}
