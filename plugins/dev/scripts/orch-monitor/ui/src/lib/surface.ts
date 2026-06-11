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

/** The top-level surfaces the shell can render in SidebarInset.
 *  OBS-5: the five OBSERVE analytics surfaces join the four OPERATE surfaces.
 *  Only Telemetry is wired live tonight (its content ships in OBS-6/7/8); the
 *  other four are declared here so each later surface only needs its own switch
 *  branch (the four-touch routing pattern, build-plan §2.2). */
export type Surface =
  | "home"
  | "board"
  | "workers"
  | "queue"
  | "telemetry"
  | "utilization"
  | "finops"
  | "fleetops"
  | "devops";

/** Every surface in nav order — the single source the sidebar + palette iterate.
 *  OBS-5: OBSERVE surfaces follow the OPERATE block (after queue). */
export const SURFACES: readonly Surface[] = [
  "home",
  "board",
  "workers",
  "queue",
  "telemetry",
  "utilization",
  "finops",
  "fleetops",
  "devops",
] as const;

/** Human label per surface (sidebar item + command palette).
 *  CTL-930: home → "Inbox", board → "Tickets" (internal union keys unchanged).
 *  OBS-5: OBSERVE labels (Telemetry/Utilization/FinOps/Fleet Ops/DevOps). */
export const SURFACE_LABEL: Record<Surface, string> = {
  home: "Inbox",
  board: "Tickets",
  workers: "Workers",
  queue: "Queue",
  telemetry: "Telemetry",
  utilization: "Utilization",
  finops: "FinOps",
  fleetops: "Fleet Ops",
  devops: "DevOps",
};

/** The `g <key>` jump keys, kept next to the Surface union so they stay in sync.
 *  OBS-5: OBSERVE chords pick keys that don't collide with the existing h/b/w/q —
 *  t(elemetry) / u(tilization) / f(inops) / o(=fleetOps, f taken) / d(evops). */
export const SURFACE_CHORD: Record<string, Surface> = {
  h: "home",
  b: "board",
  w: "workers",
  q: "queue",
  t: "telemetry",
  u: "utilization",
  f: "finops",
  o: "fleetops",
  d: "devops",
};

/** Breadcrumb trail per surface — scope-less fallback (used by tests + non-scoped contexts).
 *  CTL-930: scope-aware breadcrumbs use lib/nav-model#breadcrumbFor instead.
 *  OBS-5: OBSERVE surfaces sit under an "Observe" crumb instead of "Overall". */
export const SURFACE_BREADCRUMB: Record<Surface, string[]> = {
  home: ["Overall", "Inbox"],
  board: ["Overall", "Tickets"],
  workers: ["Overall", "Workers"],
  queue: ["Overall", "Queue"],
  telemetry: ["Observe", "Telemetry"],
  utilization: ["Observe", "Utilization"],
  finops: ["Observe", "FinOps"],
  fleetops: ["Observe", "Fleet Ops"],
  devops: ["Observe", "DevOps"],
};

/**
 * Breadcrumb for the Settings surface (CTL-911 / SURF3). Settings is a FOOTER
 * destination, NOT one of the four OPERATE landing surfaces — so it stays out
 * of the `Surface` union / `SURFACES` / `SURFACE_CHORD` (which the shell's nav,
 * the command palette, and the landing-surface preference all iterate). The
 * shell renders it via a separate open-flag, with this trail in the top strip.
 */
export const SETTINGS_BREADCRUMB: string[] = ["Settings"];

/**
 * True when focus is in a text-entry context — the shell's `[` / `g` chord
 * handlers must NOT steal those keystrokes. Pure so it can be unit-tested with a
 * minimal `{ tagName, isContentEditable }` shape rather than a real DOM node.
 */
export function isTypingTarget(
  target: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!target) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable === true
  );
}

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
