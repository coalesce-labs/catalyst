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
 *                  The control tower (SlotDeck → DispatchQueue → HoldingBuckets →
 *                  DeadStrip) is folded above the worker grid (CTL-1016).
 *  - "dashboard" → the existing monitor dashboard / orchestrator / comms / etc.
 *
 * Home is the calm dashboard inbox; every other surface falls through to it.
 *  - "telemetry" → the OBSERVE Telemetry surface shell (OBS-5).
 *  - "finops"    → the OBSERVE FinOps surface shell (OBS-10): the dollar+ROI hero
 *                  band + spend-over-time bars with spikes.
 *  - "utilization" → the OBSERVE Utilization surface shell (OBS-16): the slot-
 *                  occupancy hero + the STARVED/JAMMED pathology badge + idle list +
 *                  429/overload + active-time.
 *  - "fleetops"  → the OBSERVE FleetOps surface shell (OBS-18): the host-health
 *                  hero + host matrix + stuck/dead reap hints + reconcile, built on
 *                  board + /api/cluster + events ONLY (deliberately Prom/Loki-FREE
 *                  so it survives a telemetry-stack outage). The remaining OBSERVE
 *                  surface (devops) keeps the dashboard fall-through until its
 *                  content ships — it is nav-disabled ("soon") for now.
 */
export type SurfaceContentKind =
  | "board"
  | "workers"
  | "telemetry"
  | "finops"
  | "utilization"
  | "fleetops"
  | "rulebook"
  | "dashboard";

/**
 * Resolve which content kind the inset should render for the active surface.
 * "board" was special-cased in SHELL2; SURF1 (CTL-909) adds "workers". The
 * former "queue" content kind is retired (CTL-1016): the control tower is
 * folded into the workers surface. Every other surface keeps the dashboard
 * content so this stays behavior-preserving for Home (no regression).
 */
export function surfaceContentKind(surface: Surface): SurfaceContentKind {
  if (surface === "board") return "board";
  if (surface === "workers") return "workers";
  // OBS-5: Telemetry is the first OBSERVE surface to ship its own content shell.
  if (surface === "telemetry") return "telemetry";
  // OBS-10: FinOps is the second OBSERVE surface to ship its own content shell.
  if (surface === "finops") return "finops";
  // OBS-16: Utilization is the third OBSERVE surface to ship its own content shell
  // (slot-occupancy hero + STARVED/JAMMED pathology badge + idle list + 429 +
  // active-time).
  if (surface === "utilization") return "utilization";
  // OBS-18: FleetOps is the fourth OBSERVE surface — host-health hero + host matrix
  // + stuck/dead reap hints + reconcile, board + /api/cluster + events ONLY. The
  // remaining surface (devops) stays on the dashboard fall-through (nav-disabled
  // "soon") until its own OBS ticket lands.
  if (surface === "fleetops") return "fleetops";
  // CTL-1103: Rulebook is the first REASON surface.
  if (surface === "rulebook") return "rulebook";
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
