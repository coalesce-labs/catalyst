// use-board-restore.ts — CTL-951 + CTL-971: restore the board to the EXACT state
// it was left in when the operator returns from a detail page (Esc / breadcrumb /
// browser Back).
//
// The card-click navigation is a full-document navigation (the detail routes only
// exist in the board.html entry's router — see detail-nav.ts), so the board
// re-mounts from scratch on return. The SURFACE + repo SCOPE are reseated at SHELL
// mount by `useSurfaceRestore` (so the board actually mounts at all — without it
// the landing-pref Inbox shows and this hook never runs). Density / grouping /
// order ride their own persisted `boardPrefsAtom`. What THIS hook re-applies is the
// two things still not covered: the board's SCROLL offset (BOTH axes) and the
// originating CARD focus, read from the sessionStorage snapshot `openDetail`
// stashed.
//
// The scroll element is resolved at runtime from the board root: the kanban
// SwimlaneBoard / dense BoardList / QueueView each own a `.cat-scroll` overflow
// container, so the hook finds the FIRST one under the board root rather than
// threading a ref through every sub-component.
//
// CTL-971: the restore is hardened for CTL-950's single both-axes `.cat-scroll`
// scroller + CTL-958's overscroll-chaining constrained cells:
//   - it re-FINDS the scroller on restore (the element may not exist on the first
//     committed frame), and DOUBLE-rAFs so sticky headers + constrained-cell
//     layout have settled before we set the offset (a not-yet-laid-out extent
//     clamps scrollLeft/scrollTop to 0);
//   - it restores BOTH `scrollLeft` AND `scrollTop` (CTL-950 made horizontal scroll
//     a first-class axis — losing it dropped the operator back to the leftmost
//     column);
//   - it FLASHES the originating card (a brief focus ring) so the operator's eye
//     lands where they left, then consumes the snapshot.

import { useEffect, useRef, type RefObject } from "react";
import { readListContext, clearListContext } from "../board/detail-nav";

/** Find the board's scroll container — the first `.cat-scroll` overflow element
 *  under `root` (the kanban / list / queue bodies each render one). Falls back to
 *  `root` itself when none is found (defensive — never throws).
 *
 *  NOTE: after CTL-958 the constrained per-cell scroll boxes are tagged
 *  `data-lane-cell`, NOT `.cat-scroll`, so this still resolves the BOARD-level
 *  both-axes scroller (the single horizontal axis + the board vertical axis) —
 *  exactly the element whose offset `openDetail` captured. */
export function resolveScrollEl(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  const found = root.querySelector<HTMLElement>(".cat-scroll");
  return found ?? root;
}

/** Apply a snapshot's scroll offset to the resolved scroller (both axes) +
 *  flash-focus the originating card. Re-resolves the scroller from `root` so a
 *  late-mounting `.cat-scroll` is still found. Returns true once the scroller was
 *  found AND its scroll extent is non-trivial (so a caller can retry on the next
 *  frame while the layout is still 0-height). PURE of React — only DOM. */
export function applyBoardRestore(
  root: HTMLElement | null,
  snapshot: { scroll: { top: number; left: number }; focusId: string },
): boolean {
  const el = resolveScrollEl(root);
  let applied = false;
  if (el) {
    // Restore BOTH axes (CTL-950 single both-axes scroller). The browser clamps
    // to the current extent — if the layout hasn't settled (extent still ~0) the
    // write no-ops, which the double-rAF / retry below guards against.
    el.scrollLeft = snapshot.scroll.left;
    el.scrollTop = snapshot.scroll.top;
    // "Applied" only when the extent can actually hold the requested offset (or
    // the requested offset was 0 to begin with) — else the caller should retry.
    const horizOk = snapshot.scroll.left === 0 || el.scrollLeft > 0;
    const vertOk = snapshot.scroll.top === 0 || el.scrollTop > 0;
    applied = horizOk && vertOk;
  }
  // Re-focus + flash the originating card (the `data-card-id` the cards stamp) so
  // the keyboard cursor lands where the operator left — without scrolling it into
  // view (we just set the offset; `preventScroll` keeps it).
  const card = root?.querySelector<HTMLElement>(
    `[data-card-id="${cssEscape(snapshot.focusId)}"]`,
  );
  if (card) {
    card.focus({ preventScroll: true });
    flashCard(card);
  }
  return applied;
}

/**
 * Re-apply the persisted scroll offset (both axes) + originating-card focus when
 * the board mounts after a return from a detail page.
 *
 * @param rootRef  the board root element (the scroll container is resolved under it)
 * @param ready    true once the board payload has rendered (cards + scroll extent
 *                  exist); the restore is deferred until then so the offset sticks.
 */
export function useBoardRestore(
  rootRef: RefObject<HTMLElement | null>,
  ready: boolean,
): void {
  // Guard so the restore fires AT MOST once per board mount — a payload re-render
  // (a live stream tick) must not yank the operator back to the saved offset after
  // they've scrolled away.
  const restoredRef = useRef(false);

  useEffect(() => {
    if (!ready || restoredRef.current) return;
    const snapshot = readListContext();
    if (!snapshot) return;
    restoredRef.current = true;

    // Double-rAF so the just-rendered cards + the sticky headers + CTL-958's
    // constrained-cell layout settle before we set the offset (a 0-height-then-grow
    // container clamps scrollLeft/scrollTop to 0 if applied on the first paint).
    // If the first apply doesn't "stick" (extent still settling), the second frame
    // re-applies against the now-laid-out extent.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      const okFirst = applyBoardRestore(rootRef.current, snapshot);
      if (okFirst) {
        clearListContext();
        return;
      }
      raf2 = requestAnimationFrame(() => {
        applyBoardRestore(rootRef.current, snapshot);
        // Consume the snapshot on the second frame regardless — a board this tall
        // is laid out by now; a stale snapshot must never re-fire on a later visit.
        clearListContext();
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [ready, rootRef]);
}

/** Briefly outline the restored card so the operator's eye finds it. Pure DOM:
 *  sets an inline outline, then clears it on a timer. No-ops if the element has no
 *  style (defensive — the bun shim / detached nodes). */
function flashCard(card: HTMLElement): void {
  if (!card.style) return;
  const prevOutline = card.style.outline;
  const prevOffset = card.style.outlineOffset;
  const prevTransition = card.style.transition;
  card.style.transition = "outline-color .5s ease-out";
  card.style.outline = "2px solid var(--cat-focus, #5e9ee8)";
  card.style.outlineOffset = "2px";
  window.setTimeout(() => {
    card.style.outline = prevOutline;
    card.style.outlineOffset = prevOffset;
    card.style.transition = prevTransition;
  }, 900);
}

/** Minimal CSS.escape shim for the `data-card-id` attribute selector (ids carry
 *  ":" for worker runs, which is a CSS combinator otherwise). Uses the native
 *  `CSS.escape` when present, else escapes the chars that matter for an attr value. */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}
