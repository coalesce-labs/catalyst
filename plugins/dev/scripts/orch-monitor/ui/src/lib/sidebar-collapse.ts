// sidebar-collapse.ts — the PURE collapse-interaction core for the app shell
// (CTL-894 / SHELL4).
//
// Extracted out of `app-shell.tsx` so the SHELL4 acceptance scenarios — the `[`
// toggle, the "typing is never stolen" guard, and the localStorage persistence
// that survives a reload — are unit-testable WITHOUT a DOM, following the same
// framework-agnostic pattern as surface.ts / board-logic.ts / nav-store.ts.
//
// The shell stays a CONTROLLED `SidebarProvider` (it owns `open` + `onOpenChange`)
// so BOTH `[` (added here) and the primitive's built-in `Cmd/Ctrl+B` drive the same
// collapse, with no vendoring of the primitive — see the app-shell research doc §3
// "How `[` coexists with the built-in Cmd/Ctrl+B".
import { isTypingTarget } from "@/lib/surface";

/**
 * localStorage key for the persisted open/closed sidebar state. The controlled
 * provider replaces the primitive's cookie path, so this is the single source of
 * truth for "stay full-screen across reloads".
 */
export const SIDEBAR_STORAGE_KEY = "catalyst:sidebar-open";

/**
 * Read persisted sidebar-open state. Defaults OPEN — only an explicit stored
 * `"false"` collapses, so a fresh/cleared store (or SSR with no `window`) renders
 * expanded. This is what makes the "Collapse state persists" scenario hold: after
 * a collapse writes `"false"`, the next load reads `false`.
 */
export function readSidebarOpen(): boolean {
  if (typeof window === "undefined") return true;
  return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) !== "false";
}

/** Persist the current open/closed state (called whenever `open` changes). */
export function writeSidebarOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(open));
}

/** The minimal shape of a keydown event the `[`-toggle predicate inspects. */
export interface SidebarToggleKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: { tagName?: string; isContentEditable?: boolean } | null;
}

/**
 * True when a keydown should toggle the sidebar via the `[` binding.
 *
 * Encodes the SHELL4 contract:
 *  - the key is exactly `[` with NO meta/ctrl/alt modifier (so it never collides
 *    with shortcuts; `Cmd/Ctrl+B` is the primitive's own, handled separately),
 *  - focus is NOT a text-entry target (input / textarea / contenteditable) — so
 *    "typing is never stolen": `[` typed into a field is left alone.
 *
 * `Cmd/Ctrl+B` is intentionally NOT handled here — the controlled provider routes
 * the primitive's built-in shortcut through `onOpenChange`, so both bindings work
 * with a single source of collapse state.
 */
export function shouldToggleSidebar(e: SidebarToggleKeyEvent): boolean {
  if (e.key !== "[") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (isTypingTarget(e.target ?? null)) return false;
  return true;
}
