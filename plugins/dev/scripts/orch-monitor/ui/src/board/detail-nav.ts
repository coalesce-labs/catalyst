// detail-nav.ts — CTL-942 + CTL-951 + CTL-989: card → detail-page navigation.
//
// CTL-989 — THE UNIFICATION: the /ticket/$id + /worker/$id + /dep-graph routes
// now live in the SINGLE app-wide TanStack Router (app-router.tsx, mounted from
// index.html with AppShell as the rootRoute layout). The Board mounts INSIDE
// that router tree, so opening a detail page is a real client-side
// `navigate(...)` — NOT a full-document jump. The left nav stays, no reload
// fires, and browser back/forward + scroll restoration are native (TanStack
// Router `scrollRestoration`). The former sessionStorage list-context bridge
// (which existed ONLY to survive the full-document navigation the two-entry split
// forced) is retired — the URL search params (`?from&lens&col&cursor`) already
// carry the list-origin the detail Shell reconstructs, and the router restores
// the board scroller's offset on back.
//
// Two click paths remain:
//   - PLAIN primary click  → `openDetail(navigate, kind, id, args)` does a typed
//                            client-side `navigate({ to: "/ticket/$id", ... })`.
//   - Cmd/Ctrl/middle click → `openDetailInNewTab(detailHref(...))` opens a real
//                            new tab; the server's SPA fallback serves index.html
//                            for the detail path so the new tab boots the unified
//                            router and lands correctly. `detailHref` builds the
//                            href string a new-tab open still needs.
//
// Pure helpers (no DOM) are unit-testable directly; the few that touch `window`
// are written defensively so they no-op rather than throw when it is unavailable.

import type { NavigateOptions } from "@tanstack/react-router";
import type { DetailFrom, DetailLens } from "./route-search";

/** The kind of entity a card opens — selects the route + the list-context kind. */
export type DetailKind = "ticket" | "worker";

/** The list-origin context a card carries into the detail page (mirrors the
 *  typed search params the Shell reconstructs). `cursor` is the 0-based index of
 *  the clicked entity within the on-screen ordered list. */
export interface DetailNavContext {
  from: DetailFrom;
  lens?: DetailLens;
  col?: string;
  cursor?: number;
}

/** Base path for a detail page (no search params). `id` carries colons for
 *  worker run ids ("CTL-845:2") — a colon is legal inside one path segment. */
function detailBase(kind: DetailKind, id: string): string {
  return `/${kind}/${encodeURIComponent(id)}`;
}

/** Full-page URL for a ticket detail page (base, no search). */
export function ticketDetailHref(id: string): string {
  return detailBase("ticket", id);
}

/** Full-page URL for a worker (single-run) detail page; ids carry colons. */
export function workerDetailHref(name: string): string {
  return detailBase("worker", name);
}

/**
 * Build the deep-link href WITH the typed `?from&lens&col&cursor` search params
 * so the detail Shell can reconstruct the breadcrumb + pager (and the `Esc`/back
 * target) from the URL alone. Omits any absent field (a cold context yields the
 * bare base path). `cursor` is encoded only when it is a finite, non-negative
 * integer — anything else is dropped (route-search coerces defensively too).
 *
 * CTL-989: still load-bearing for the new-tab gesture (Cmd/Ctrl/middle-click) —
 * a real new-tab open needs an href string the in-router navigate can't provide.
 */
export function detailHref(kind: DetailKind, id: string, ctx: DetailNavContext): string {
  const params = new URLSearchParams();
  params.set("from", ctx.from);
  if (ctx.lens) params.set("lens", ctx.lens);
  if (ctx.col) params.set("col", ctx.col);
  if (typeof ctx.cursor === "number" && Number.isInteger(ctx.cursor) && ctx.cursor >= 0) {
    params.set("cursor", String(ctx.cursor));
  }
  const qs = params.toString();
  return qs ? `${detailBase(kind, id)}?${qs}` : detailBase(kind, id);
}

/**
 * Build the typed TanStack `navigate` options for a card open (CTL-989). The
 * cursor is the clicked entity's index in the on-screen ordered list; only a
 * valid (>=0) index is carried (route-search coerces defensively too). The
 * `?scope` is preserved from the current URL via the search updater so the
 * detail page stays inside the active repo scope. The route is `/ticket/$id` or
 * `/worker/$id` with `params.id` carrying the raw id (the router encodes it).
 */
export function detailNavigateOptions(
  kind: DetailKind,
  id: string,
  args: {
    ids: string[];
    lens?: DetailLens;
    col?: string;
    from?: DetailFrom;
  },
): NavigateOptions {
  const idx = args.ids.indexOf(id);
  const from: DetailFrom = args.from ?? "board";
  const cursor = idx >= 0 ? idx : undefined;
  const nextSearch = {
    from,
    ...(args.lens ? { lens: args.lens } : {}),
    ...(args.col ? { col: args.col } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
  return {
    to: kind === "ticket" ? "/ticket/$id" : "/worker/$id",
    params: { id },
    // Merge over the previous search so the inherited `?scope` survives, then
    // overlay the list-origin params for this open.
    search: (prev: Record<string, unknown>) => ({ ...prev, ...nextSearch }),
  } as NavigateOptions;
}

/**
 * CTL-1059: decide whether goRoot may use history.back().
 *
 * `useCanGoBack()` can spuriously report true on a COLD deep-link when browser
 * session-restoration leaves a non-null history.state carrying a prior TanStack
 * session's __TSR_key (so @tanstack/history skips its index-0 stamp). Returning
 * via back() then pops to whatever browser entry preceded the tab — often `/` —
 * which is the home bounce. Guard: only honor back() when we are genuinely PAST
 * the first router-owned entry (__TSR_index >= 1).
 */
export function canReturnViaBack(args: {
  canGoBack: boolean;
  tsrIndex: number | null | undefined;
}): boolean {
  const { canGoBack, tsrIndex } = args;
  if (!canGoBack) return false;
  return typeof tsrIndex === "number" && tsrIndex >= 1;
}

// ── the click → navigate seam (the DOM-touching helpers) ──────────────────────

/**
 * True when a mouse event is the "open in a new tab" gesture: Cmd-click (mac),
 * Ctrl-click, or middle-click. Cards intercept these to open the detail page in
 * a new tab; a PLAIN primary click navigates in place (CTL-951).
 */
export function isNewTabClick(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  button: number;
}): boolean {
  return e.metaKey || e.ctrlKey || e.button === 1;
}

/** Open a detail page in a new tab (the modified-click gesture). */
export function openDetailInNewTab(href: string): void {
  if (typeof window === "undefined") return;
  window.open(href, "_blank", "noopener,noreferrer");
}

/**
 * Open a card's detail page on a plain single-click (CTL-989): a CLIENT-SIDE
 * router navigation — no full-document reload, the left nav stays, browser back
 * returns to the board and the router restores its scroll offset. `navigate` is
 * the TanStack `useNavigate()` the Board holds (it lives inside the router tree
 * now). `from` defaults to "board".
 */
export function openDetail(
  navigate: (opts: NavigateOptions) => void,
  kind: DetailKind,
  id: string,
  args: {
    ids: string[];
    lens?: DetailLens;
    col?: string;
    from?: DetailFrom;
  },
): void {
  navigate(detailNavigateOptions(kind, id, args));
}
