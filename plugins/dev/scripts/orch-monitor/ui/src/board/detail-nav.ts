// detail-nav.ts — CTL-942: hard-navigation helpers for the detail pages.
//
// The /ticket/$id + /worker/$id routes live in the TanStack router mounted by
// the BOARD entry (board.html → main.tsx → AppRouter); the app shell
// (index.html → App) mounts NO router. The Board component mounts in BOTH
// entries, so any "open the detail page" affordance must be a real browser
// navigation (the server's CTL-942 SPA fallback answers it with board.html) —
// an in-app router push can't cross entries and the embedded shell has no
// router to push into. These helpers are pure so they're testable without a
// DOM rig.

/** Full-page URL for a ticket detail page. */
export function ticketDetailHref(id: string): string {
  return `/ticket/${encodeURIComponent(id)}`;
}

/** Full-page URL for a worker (single-run) detail page; ids carry colons ("CTL-845:2"). */
export function workerDetailHref(name: string): string {
  return `/worker/${encodeURIComponent(name)}`;
}

/**
 * True when a mouse event is the "open in a new tab" gesture: Cmd-click (mac),
 * Ctrl-click, or middle-click. Board cards intercept these to deep-link
 * straight to the detail page instead of opening the in-board drawer.
 */
export function isNewTabClick(e: {
  metaKey: boolean;
  ctrlKey: boolean;
  button: number;
}): boolean {
  return e.metaKey || e.ctrlKey || e.button === 1;
}

/** Open a detail page in a new tab (used by the card modified-click gesture). */
export function openDetailInNewTab(href: string): void {
  window.open(href, "_blank", "noopener,noreferrer");
}
