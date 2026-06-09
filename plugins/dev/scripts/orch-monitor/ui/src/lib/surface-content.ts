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
 *  - "dashboard" → the existing monitor dashboard / orchestrator / comms / etc.
 *
 * Workers + Queue still fall through to "dashboard" today; they migrate to their
 * own dense surfaces in later SHELL tickets. Home is the calm dashboard inbox.
 */
export type SurfaceContentKind = "board" | "dashboard";

/**
 * Resolve which content kind the inset should render for the active surface.
 * Only "board" is special-cased in SHELL2; every other surface keeps the
 * dashboard content so this ticket stays behavior-preserving for Home/Workers/
 * Queue (no regression — the Gherkin "no capped reading column" requirement only
 * applies to the board surface).
 */
export function surfaceContentKind(surface: Surface): SurfaceContentKind {
  return surface === "board" ? "board" : "dashboard";
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
