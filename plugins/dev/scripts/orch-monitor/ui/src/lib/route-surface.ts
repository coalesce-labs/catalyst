// route-surface.ts — the PURE pathname↔surface map for the unified router
// (CTL-989). The redesign collapses the two SPA bundles (the index.html shell
// with `useState<Surface>` + the standalone board.html router) into ONE
// TanStack Router mounted from index.html, with AppShell as the rootRoute
// layout. The URL becomes the source of truth for LOCATION: every surface is a
// real path, so a refresh/paste/back-forward reconstructs the active surface
// from `location.pathname` alone — no React surface state, no sessionStorage
// reseat.
//
// This module is the React-/router-free core of that mapping (the same pattern
// surface.ts / surface-content.ts / route-search.ts follow), so the
// pathname→surface contract is unit-testable under `bun test` without a DOM.
// AppShell reads the active surface via `pathnameToSurface(location.pathname)`;
// the nav writes a surface via `router.navigate({ to: surfaceToPath(s) })`.
// CTL-989: TYPE-ONLY import of `Surface` (erased at runtime) so this module has
// NO runtime dependency on surface.ts. surface.ts imports pathnameToSurface from
// HERE (for useSurface()), so a runtime import back would form an init cycle —
// PATH_TO_SURFACE is built from SURFACE_PATH's own entries (local) instead.
import type { Surface } from "./surface";

/** The flat URL path each surface lives at. Home is the literal "/" default;
 *  every other surface is a clean typed segment matching its `surface.ts` key.
 *  These are the canonical app routes the server's SPA fallback must serve
 *  index.html for (see server.ts isAppRoute). */
export const SURFACE_PATH: Record<Surface, string> = {
  home: "/",
  board: "/board",
  workers: "/workers",
  telemetry: "/telemetry",
  utilization: "/utilization",
  finops: "/finops",
  fleetops: "/fleetops",
  devops: "/devops",
  rulebook: "/rules",
};

/** The Settings path — Settings is a footer destination, NOT one of the surface
 *  union members (mirrors SETTINGS_BREADCRUMB in surface.ts), so it gets its own
 *  path constant rather than a SURFACE_PATH entry. */
export const SETTINGS_PATH = "/settings";

/** Reverse map (path → surface), built once from SURFACE_PATH's own entries (no
 *  runtime dependency on surface.ts — see the type-only import note above). */
const PATH_TO_SURFACE: Record<string, Surface> = Object.fromEntries(
  Object.entries(SURFACE_PATH).map(([surface, path]) => [path, surface as Surface]),
) as Record<string, Surface>;

/**
 * The path for a surface — what the nav navigates to. Total over the Surface
 * union (every surface has an entry); falls back to "/" defensively if an
 * out-of-union value is ever passed.
 */
export function surfaceToPath(surface: Surface): string {
  return SURFACE_PATH[surface] ?? "/";
}

/**
 * Derive the active surface (or "settings") from a location pathname. Used by
 * AppShell to highlight the nav + render the breadcrumb without any React
 * surface state.
 *
 *  - "/settings"                          → "settings"
 *  - a known surface path (/board, …)     → that surface
 *  - "/" (and unknown paths)              → "home" (the calm Inbox default)
 *  - the detail routes (/ticket/$id,
 *    /worker/$id, /dep-graph)             → the ORIGINATING surface for nav
 *                                           highlight, derived from `from`
 *                                           (board/workers) defaulting to
 *                                           "board" — see detailPathSurface.
 *
 * Total + never throws: any string yields a valid result so a pasted/hand-edited
 * URL can never crash the shell's breadcrumb/nav derivation.
 */
export function pathnameToSurface(
  pathname: string,
  opts?: { from?: string },
): Surface | "settings" {
  if (pathname === SETTINGS_PATH) return "settings";
  const exact = PATH_TO_SURFACE[pathname];
  if (exact) return exact;
  // Detail routes highlight the originating surface so the left nav keeps its
  // selection while a ticket/worker/dep-graph page is open inside the layout.
  // A /worker/$id page is inherently the Workers surface; /ticket/$id + /dep-graph
  // default to the Tickets (board) surface but honor an explicit `?from`.
  if (isDetailPath(pathname)) {
    if (/^\/worker\//.test(pathname)) return "workers";
    return detailPathSurface(opts?.from);
  }
  return "home";
}

/** True for the detail-page paths that render the shared Shell content inside
 *  the AppShell <Outlet/> (left nav stays). */
export function isDetailPath(pathname: string): boolean {
  if (pathname === "/dep-graph") return true;
  return /^\/(ticket|worker)\/([^/]+)$/.test(pathname);
}

/**
 * Which OPERATE surface a detail page should highlight in the nav. Derived from
 * the `?from` search param the board sets when opening a card; defaults to
 * "board" (the Tickets surface) for a cold deep-link with no context. Only
 * "workers" overrides — every other `from` value (board/stuck/recent, or
 * absent) maps to the board surface, which is where those lists live.
 */
export function detailPathSurface(from?: string): Surface {
  return from === "workers" ? "workers" : "board";
}
