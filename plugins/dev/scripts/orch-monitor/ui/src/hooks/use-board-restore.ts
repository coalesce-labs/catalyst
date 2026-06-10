// use-board-restore.ts — CTL-951: restore the board to the EXACT state it was
// left in when the operator returns from a detail page (Esc / browser Back).
//
// The card-click navigation is a full-document navigation (the detail routes only
// exist in the board.html entry's router — see detail-nav.ts), so the board
// re-mounts from scratch on return. Display-options (density / grouping / order /
// repo scope) restore for free — they live in their own persisted localStorage
// atoms (`boardPrefsAtom` / `repoScopeAtom`) and survive the navigation. What this
// hook re-applies is the two things NOT covered by those atoms: the board's
// SCROLL offset and the originating CARD focus, read from the sessionStorage
// snapshot `openDetail` stashed.
//
// The scroll element is resolved at runtime from the board root: every board body
// (kanban SwimlaneBoard, dense BoardList, QueueView) owns a `.cat-scroll`
// overflow container, so the hook finds the FIRST one under the board root rather
// than threading a ref through every sub-component. The restore runs once, only
// after the payload has rendered (so the cards + the scroll extent exist), then
// clears the snapshot so it never re-fires on a later unrelated board visit.

import { useEffect, useRef, type RefObject } from "react";
import { readListContext, clearListContext } from "../board/detail-nav";

/** Find the board's scroll container — the first `.cat-scroll` overflow element
 *  under `root` (the kanban / list / queue bodies each render one). Falls back to
 *  `root` itself when none is found (defensive — never throws). */
export function resolveScrollEl(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  const found = root.querySelector<HTMLElement>(".cat-scroll");
  return found ?? root;
}

/**
 * Re-apply the persisted scroll offset + originating-card focus when the board
 * mounts after a return from a detail page.
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

    // Defer to the next frame so the just-rendered cards + scroll extent are laid
    // out before we set the offset (a 0-height-then-grow container would clamp the
    // scrollTop to 0 if applied synchronously on the first paint).
    const raf = requestAnimationFrame(() => {
      const el = resolveScrollEl(rootRef.current);
      if (el) {
        el.scrollTop = snapshot.scroll.top;
        el.scrollLeft = snapshot.scroll.left;
      }
      // Re-focus the originating card (the `data-card-id` the cards stamp) so the
      // keyboard cursor lands where the operator left — without scrolling it into
      // view (we just set the offset; `preventScroll` keeps it).
      const card = rootRef.current?.querySelector<HTMLElement>(
        `[data-card-id="${cssEscape(snapshot.focusId)}"]`,
      );
      card?.focus({ preventScroll: true });
      // Consume the snapshot so a later unrelated board visit doesn't re-restore.
      clearListContext();
    });
    return () => cancelAnimationFrame(raf);
  }, [ready, rootRef]);
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
