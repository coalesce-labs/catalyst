import { useEffect, useRef } from "react";
import { classifyKey, CHORD_WINDOW_MS } from "./key-nav";

interface KeyboardNavOptions {
  // ── pre-existing callbacks (unchanged) ──────────────────────────────────────
  onEscape?: () => void;
  onSlash?: () => void;
  onQuestionMark?: () => void;
  // ── new for the detail-page shell (CTL-912 / DETAIL1, detail design §3.4) ────
  /** `j` / ▾ — walk to the next entity in listContextAtom.ids (in place). */
  onNext?: () => void;
  /** `k` / ▴ — walk to the previous entity in listContextAtom.ids (in place). */
  onPrev?: () => void;
  /** `⌘K` / `Ctrl-K` — toggle the command palette (saves/restores focus in the
   *  caller). Reachable even while an input is focused. */
  onPalette?: () => void;
  /** `g t` — from a worker, jump to its parent ticket. */
  onGotoTicket?: () => void;
  /** `g w` — fuzzy go-to a worker (opens the palette pre-scoped, in the caller). */
  onGotoWorker?: () => void;
  /** `g a` — scroll the lifecycle spine to the active phase node. */
  onGotoActive?: () => void;
}

/**
 * Binds global keyboard shortcuts for dashboard + detail-page navigation.
 *
 * Shortcuts are ignored when an input, textarea, or select is focused — EXCEPT
 * `⌘K`/`Ctrl-K`, which must always reach the command palette (detail design
 * §3.4). The keymap itself is the pure `classifyKey` (see `./key-nav.ts`); this
 * hook only owns the listener, the `g`-chord timer, and dispatch — so the bindings
 * are unit-tested without a DOM.
 *
 *   Pre-existing (kept verbatim):
 *     - Escape  → onEscape        (e.g. layered dismiss / go back)
 *     - /       → onSlash          (focus search input, preventDefault)
 *     - ?       → onQuestionMark   (show keyboard help)
 *   New (CTL-912 / DETAIL1):
 *     - j / k   → onNext / onPrev  (walk the list you came from, in place)
 *     - ⌘K      → onPalette        (toggle the command palette)
 *     - g t / g w / g a → onGotoTicket / onGotoWorker / onGotoActive (chords)
 */
export function useKeyboardNav(options: KeyboardNavOptions): void {
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  useEffect(() => {
    // The `g`-chord state lives in the effect closure: `g` arms a pending chord
    // for CHORD_WINDOW_MS; the next key resolves or cancels it.
    let chordPending = false;
    let chordTimer: ReturnType<typeof setTimeout> | undefined;

    const clearChord = () => {
      chordPending = false;
      if (chordTimer) {
        clearTimeout(chordTimer);
        chordTimer = undefined;
      }
    };

    function handleKeyDown(e: KeyboardEvent) {
      const active = document.activeElement as HTMLElement | null;
      const focusedTag = active?.tagName;
      // CTL-1049: also guard a focused contentEditable host so Escape-means-back
      // (and the other shortcuts) never fire while the operator edits rich text.
      const focusedEditable = active?.isContentEditable === true;
      const wasChordPending = chordPending;
      const action = classifyKey(e, focusedTag, wasChordPending, focusedEditable);

      // Any resolved keystroke (the second key of a chord, or a non-`g` key)
      // clears a pending chord before we dispatch. `chord-start` re-arms below.
      if (wasChordPending) clearChord();

      const cb = callbacksRef.current;
      switch (action.type) {
        case "escape":
          cb.onEscape?.();
          break;
        case "focus-search":
          e.preventDefault();
          cb.onSlash?.();
          break;
        case "help":
          cb.onQuestionMark?.();
          break;
        case "next":
          e.preventDefault();
          cb.onNext?.();
          break;
        case "prev":
          e.preventDefault();
          cb.onPrev?.();
          break;
        case "palette":
          e.preventDefault();
          cb.onPalette?.();
          break;
        case "goto-ticket":
          cb.onGotoTicket?.();
          break;
        case "goto-worker":
          cb.onGotoWorker?.();
          break;
        case "goto-active":
          cb.onGotoActive?.();
          break;
        case "chord-start":
          // Arm the chord and start the lapse timer (a stale `g` shouldn't linger).
          chordPending = true;
          chordTimer = setTimeout(clearChord, CHORD_WINDOW_MS);
          break;
        case "none":
          break;
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      clearChord();
    };
  }, []);
}
