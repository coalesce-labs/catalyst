// surface-content.ts — the surface→content map for the app shell (CTL-892 / SHELL2).
//
// SHELL1 (CTL-891) landed the shell frame (left rail, top strip, `[` collapse,
// `g`-chords, SurfaceContext) but rendered the SAME dashboard content for every
// surface — surface→content wiring was explicitly deferred. SHELL2 lands the
// FIRST real surface switch: when the active surface is "board", the SidebarInset
// hosts the dense <Board /> grid (full-bleed) instead of the dashboard.
//
// This module is the PURE, framework-agnostic decision: given the active surface,
// which content kind does the inset render? Keeping it React-free (the same
// pattern surface.ts / board-logic.ts / route-search.ts follow) makes the routing
// contract unit-testable without a DOM, and gives App.tsx one switch to bind to.
import type { Surface } from "./surface";

/**
 * The kind of content the SidebarInset renders for a surface.
 *  - "board"     → the dense, full-bleed <Board /> grid (CTL-892).
 *  - "workers"   → the dense Workers grid: the SAME <Board /> opened on its
 *                  Workers view, with the node group-by + node filter (CTL-909).
 *  - "queue"     → the dedicated wide ranked-depth Queue surface (CTL-910 / SURF2):
 *                  capacity strip + on-the-plate table + waiting ranked table with
 *                  the optional per-node column.
 *  - "dashboard" → the existing monitor dashboard / orchestrator / comms / etc.
 *
 * Home is the calm dashboard inbox; every other surface falls through to it.
 */
export type SurfaceContentKind = "board" | "workers" | "queue" | "dashboard";

/**
 * Resolve which content kind the inset should render for the active surface.
 * "board" was special-cased in SHELL2; SURF1 (CTL-909) adds "workers" and
 * SURF2 (CTL-910) adds "queue" — each is now its own dense, edge-to-edge
 * surface instead of the placeholder dashboard. Every other surface keeps the
 * dashboard content so this stays behavior-preserving for Home (no regression).
 */
export function surfaceContentKind(surface: Surface): SurfaceContentKind {
  if (surface === "board") return "board";
  if (surface === "workers") return "workers";
  if (surface === "queue") return "queue";
  return "dashboard";
}

/**
 * The CSS height the board's root container fills.
 *  - standalone (the legacy `board.html` entry): `100vh` — the board owns the
 *    whole viewport, exactly as it did before SHELL2.
 *  - embedded (inside the shell's SidebarInset): `100%` — it fills the inset's
 *    flex content slot (which already accounts for the 48px top strip), so the
 *    board never overflows the viewport by the strip's height.
 *
 * Returned as the value of a single CSS custom property (`--cat-board-vh`) that
 * every `calc(... - 104px)` scroll region in Board.tsx reads, so the standalone
 * vs embedded switch is ONE token, not a prop threaded through every helper.
 */
export function boardRootHeight(embedded: boolean): string {
  return embedded ? "100%" : "100vh";
}

/** The CSS custom property Board.tsx height calcs read (see boardRootHeight). */
export const BOARD_VH_VAR = "--cat-board-vh";
