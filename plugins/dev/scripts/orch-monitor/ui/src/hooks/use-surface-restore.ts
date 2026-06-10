// use-surface-restore.ts — CTL-971: reseat the board SURFACE + repo SCOPE when the
// operator returns from a detail page (Esc / breadcrumb "◂ Board" / browser Back).
//
// THE BUG THIS FIXES: after CTL-951 a single click opens the detail page via a
// FULL-DOCUMENT navigation (the detail routes only live in the board.html entry).
// On return — all three paths land back on `/` (index.html shell) — the shell
// reseeds the active surface from the persisted LANDING preference (default
// "home"/Inbox). So the operator lands on the Inbox, the <Board> never mounts, and
// the board-local `useBoardRestore` (scroll + focus) never runs: the snapshot sits
// in sessionStorage, unconsumed. (Verified on mini 2026-06-10.)
//
// THE FIX: at SHELL mount, peek the restore snapshot. If a FRESH one exists, set
// the surface back to the one the card was opened from ("board"/"workers" → the
// `Surface` union) and re-apply the saved repo scope. This MUST run before/at the
// board mount so <Board> exists and its own `useBoardRestore` can apply the scroll.
//
// IMPORTANT: this hook PEEKS — it does NOT clear the snapshot. The board-local
// `useBoardRestore` clears it after applying scroll + focus, so it must still be
// present when the board mounts. (If the board never mounts — e.g. the snapshot is
// stale and we don't reseat — the stale snapshot is simply ignored by the 30-min
// max-age guard and overwritten on the next card open.)
//
// The surface→Surface mapping is the PURE `resolveSurfaceRestore` (unit-testable
// without React/DOM); the hook is the thin effect that applies it once on mount.

import { useEffect, useRef } from "react";
import { readListContext, type RestoreSurface } from "../board/detail-nav";
import type { Surface } from "../lib/surface";

/** What the shell should reseat on return from a detail page. */
export interface SurfaceRestore {
  /** The OPERATE surface to show ("board" or "workers"). */
  surface: Surface;
  /** The repo scope to re-apply (`REPO_SCOPE_ALL` sentinel or a repo key). */
  scope: string;
}

/**
 * Map a fresh restore snapshot to the surface + scope the shell should reseat.
 * Returns null when there is no (fresh) snapshot — the shell then keeps its
 * landing-pref default untouched. PURE: pass the already-read snapshot so this is
 * testable without a storage runtime.
 *
 * The `RestoreSurface` union ("board"/"workers") is a subset of the shell's
 * `Surface` union, so the mapping is the identity — but we keep it explicit (and
 * guarded) so a future surface value can't silently leak an invalid `Surface`.
 */
export function resolveSurfaceRestore(
  snapshot: { surface: RestoreSurface; scope: string } | null,
): SurfaceRestore | null {
  if (!snapshot) return null;
  const surface: Surface = snapshot.surface === "workers" ? "workers" : "board";
  return { surface, scope: snapshot.scope };
}

/**
 * Run-once-at-mount effect: if a fresh board-restore snapshot exists, reseat the
 * shell's surface + repo scope so the board mounts (and its own `useBoardRestore`
 * can apply the scroll/focus). PEEKS the snapshot — does NOT clear it.
 *
 * @param applySurface  set the active OPERATE surface (AppShell's `setSurface`).
 * @param applyScope    set the active repo scope (AppShell's `repoScopeAtom` setter).
 */
export function useSurfaceRestore(
  applySurface: (s: Surface) => void,
  applyScope: (scope: string) => void,
): void {
  // Guard so the reseat fires AT MOST once per shell mount — a later navigation
  // (the operator deliberately jumping to the Inbox) must not be yanked back.
  const appliedRef = useRef(false);

  useEffect(() => {
    if (appliedRef.current) return;
    appliedRef.current = true;
    const snapshot = readListContext(); // peek (no clear)
    const restore = resolveSurfaceRestore(snapshot);
    if (!restore) return;
    applyScope(restore.scope);
    applySurface(restore.surface);
    // The snapshot is intentionally LEFT in sessionStorage — the board-local
    // useBoardRestore consumes it once the board mounts + the payload renders.
  }, [applySurface, applyScope]);
}
