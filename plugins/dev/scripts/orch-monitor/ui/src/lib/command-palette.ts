// command-palette.ts — the PURE keyboard core for the ⌘K command palette
// (CTL-895 / SHELL5).
//
// Extracted out of `app-shell.tsx` so the SHELL5 acceptance scenarios — "⌘K /
// '/' open the palette" and "'/' never hijacks typing" — are unit-testable
// WITHOUT a DOM, following the same framework-agnostic pattern as surface.ts /
// sidebar-collapse.ts (the `[`-toggle predicate `shouldToggleSidebar`).
//
// The palette is the SINGLE search affordance for the shell (SHELL5 de-dups the
// two redundant search bars the prototype shipped). Two keys open it:
//   - ⌘K / Ctrl+K  — the universal command-palette chord (fires even while
//                     typing, like every command palette; the meta/ctrl modifier
//                     means it can never be mistaken for typed text).
//   - `/`          — the bare slash quick-open, but ONLY when focus is not in a
//                     text-entry target, so a `/` typed into an input/textarea/
//                     contenteditable is left alone ("'/' never hijacks typing").
import { isTypingTarget } from "@/lib/surface";

/** The minimal shape of a keydown event the palette-open predicate inspects. */
export interface PaletteKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

/**
 * True when a keydown should OPEN (toggle) the ⌘K command palette.
 *
 * Encodes the SHELL5 contract:
 *  - `⌘K` / `Ctrl+K` always opens — the meta/ctrl modifier makes it unambiguous,
 *    so (like every command palette) it fires even when a field has focus.
 *  - a bare `/` opens too, but ONLY when focus is NOT a text-entry target and no
 *    meta/ctrl/alt modifier is held — so "'/' never hijacks typing": a `/` typed
 *    into an input/textarea/contenteditable is left alone, and `Ctrl+/` (a
 *    different shortcut family) is not swallowed.
 */
export function shouldOpenPalette(e: PaletteKeyEvent): boolean {
  // ⌘K / Ctrl+K — the universal palette chord. Always opens.
  if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
    return true;
  }

  // `/` quick-open — bare key only, and never while typing.
  if (e.key === "/") {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    if (isTypingTarget(e.target ?? null)) return false;
    return true;
  }

  return false;
}
