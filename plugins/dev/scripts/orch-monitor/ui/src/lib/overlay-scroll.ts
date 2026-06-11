// overlay-scroll.ts — CTL-1036: ONE shared overlay-scrollbar behaviour.
//
// The scrollbar utility class `.cat-overlay-scroll` (app.css) hides the bar at
// rest and reveals a slim overlay thumb only while the element carries the
// `cat-scrolling` marker class. This module owns the SINGLE global listener that
// toggles that marker: on every scroll gesture it tags the scrolled element and
// schedules removal ~1s after the gesture ends — so the thumb fades shortly after
// scrolling stops, macOS-overlay style, with no layout shift (overlay, not
// gutter).
//
// Why ONE global listener (capture phase) rather than per-component handlers: the
// `scroll` event does NOT bubble, so a delegated listener must use the capture
// phase to observe scrolls on any descendant scroller. This keeps the behaviour a
// single definition applied wherever the class appears (board canvas, lanes,
// detail prose, control tower, OBSERVE panels) — no per-component copies.

/** The class the CSS reveals the overlay thumb for. */
export const SCROLLING_CLASS = "cat-scrolling";
/** The opt-in class an element must carry to participate. */
export const OVERLAY_CLASS = "cat-overlay-scroll";
/** How long after the last scroll event the thumb stays before fading. */
export const FADE_AFTER_MS = 1000;

/**
 * Decide whether a scroll event target should be tagged as scrolling. Pure +
 * DOM-light so it is unit-testable: returns true only for an Element that opts in
 * via the OVERLAY_CLASS. (document/window scroll targets — which are not Elements
 * with classList — return false.)
 */
export function shouldTrackScroll(target: EventTarget | null): target is Element {
  return (
    target != null &&
    typeof (target as Element).classList?.contains === "function" &&
    (target as Element).classList.contains(OVERLAY_CLASS)
  );
}

/**
 * Install the single global scroll-tracking listener. Returns a teardown fn
 * (clears the listener + every pending fade timer). Idempotent per call — the
 * caller (AppShell) installs it once for the whole app.
 *
 * `win` / `timers` are injected so the debounce + class-toggle round-trip can be
 * driven by a fake clock in unit tests without a real DOM.
 */
export function installOverlayScroll(
  win: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  timers: {
    set: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clear: (h: ReturnType<typeof setTimeout>) => void;
  } = { set: setTimeout, clear: clearTimeout },
  fadeAfterMs: number = FADE_AFTER_MS,
): () => void {
  const pending = new Map<Element, ReturnType<typeof setTimeout>>();

  const onScroll = (e: Event) => {
    const target = e.target;
    if (!shouldTrackScroll(target)) return;
    const el = target;
    el.classList.add(SCROLLING_CLASS);
    const existing = pending.get(el);
    if (existing != null) timers.clear(existing);
    pending.set(
      el,
      timers.set(() => {
        el.classList.remove(SCROLLING_CLASS);
        pending.delete(el);
      }, fadeAfterMs),
    );
  };

  // capture: true — `scroll` does not bubble; capture observes descendant scrolls.
  win.addEventListener("scroll", onScroll, true);
  return () => {
    win.removeEventListener("scroll", onScroll, true);
    for (const h of pending.values()) timers.clear(h);
    pending.clear();
  };
}
