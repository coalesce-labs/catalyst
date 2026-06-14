// surface-content.test.ts — units for the SHELL2 surface→content map and the
// board's embedded-height token (CTL-892). Pure logic, no DOM — run from the ui
// package:  `cd ui && bun test src/lib/surface-content.test.ts`.
import { describe, it, expect } from "bun:test";
import { SURFACES, type Surface } from "./surface";
import {
  surfaceContentKind,
  boardRootHeight,
  BOARD_VH_VAR,
} from "./surface-content";

describe("surfaceContentKind", () => {
  it("routes the board surface to the dense board content", () => {
    // Gherkin: "navigate to the Board surface → the Board grid renders".
    expect(surfaceContentKind("board")).toBe("board");
  });

  it("routes the Workers surface to the dense Workers grid (CTL-909 / SURF1)", () => {
    // Gherkin (SURF1): "the operator clicks the Workers nav item → the Workers
    // surface renders edge-to-edge in the SidebarInset" — no longer the
    // placeholder dashboard.
    expect(surfaceContentKind("workers")).toBe("workers");
  });

  it("routes the Telemetry surface to its own OBSERVE content shell (OBS-5)", () => {
    // Gherkin (OBS-5): "the operator clicks the Telemetry nav item → the
    // Telemetry OBSERVE shell renders in the SidebarInset" — the first OBSERVE
    // surface to leave the dashboard fall-through.
    expect(surfaceContentKind("telemetry")).toBe("telemetry");
  });

  it("routes the FinOps surface to its own OBSERVE content shell (OBS-10)", () => {
    // Gherkin (OBS-10): "the operator clicks the FinOps nav item → the FinOps
    // OBSERVE shell renders in the SidebarInset" — the SECOND OBSERVE surface to
    // leave the dashboard fall-through.
    expect(surfaceContentKind("finops")).toBe("finops");
  });

  it("routes the Utilization surface to its own OBSERVE content shell (OBS-16)", () => {
    // Gherkin (OBS-16): "the operator clicks the Utilization nav item → the
    // Utilization OBSERVE shell renders in the SidebarInset" — the THIRD OBSERVE
    // surface to leave the dashboard fall-through (slot-occupancy hero +
    // STARVED/JAMMED pathology badge + idle list + 429 + active-time).
    expect(surfaceContentKind("utilization")).toBe("utilization");
  });

  it("routes the FleetOps surface to its own OBSERVE content shell (OBS-18)", () => {
    // Gherkin (OBS-18): "the operator clicks the Fleet Ops nav item → the FleetOps
    // OBSERVE shell renders in the SidebarInset" — the FOURTH OBSERVE surface to
    // leave the dashboard fall-through (host-health hero + host matrix + stuck/dead
    // reap hints + reconcile, board + /api/cluster + events only).
    expect(surfaceContentKind("fleetops")).toBe("fleetops");
  });

  it("keeps Home on the dashboard (no regression)", () => {
    // Home must stay exactly what SHELL1/SHELL2 rendered — only board (SHELL2),
    // workers (SURF1), telemetry (OBS-5), finops (OBS-10), utilization (OBS-16),
    // and fleetops (OBS-18) are special-cased. The remaining OBSERVE surface
    // (devops) keeps the dashboard fall-through until its own OBS ticket ships.
    const stillDashboard = SURFACES.filter(
      (s) =>
        s !== "board" &&
        s !== "workers" &&
        s !== "telemetry" &&
        s !== "finops" &&
        s !== "utilization" &&
        s !== "fleetops" &&
        s !== "rulebook",
    );
    for (const s of stillDashboard) {
      expect(surfaceContentKind(s)).toBe("dashboard");
    }
  });

  it("covers every declared surface (no surface falls through undefined)", () => {
    for (const s of SURFACES as readonly Surface[]) {
      expect([
        "board",
        "workers",
        "telemetry",
        "finops",
        "utilization",
        "fleetops",
        "rulebook",
        "dashboard",
      ]).toContain(surfaceContentKind(s));
    }
  });

  it("routes the Rulebook surface to its own content kind (CTL-1103)", () => {
    expect(surfaceContentKind("rulebook" as Surface)).toBe("rulebook");
  });
});

describe("boardRootHeight", () => {
  it("fills the viewport when standalone (the legacy board.html entry)", () => {
    // Standalone behavior is preserved byte-for-byte: 100vh, the board owns the
    // whole page exactly as before SHELL2.
    expect(boardRootHeight(false)).toBe("100vh");
  });

  it("fills the inset (100%) when embedded in the shell", () => {
    // Embedded inside SidebarInset's flex content slot — 100% of the slot, which
    // already accounts for the 48px top strip, so the board never overflows by
    // the strip height ("renders full-bleed inside the SidebarInset").
    expect(boardRootHeight(true)).toBe("100%");
  });

  it("exposes the height through a single CSS custom property name", () => {
    // The token is consumed by every calc(var(--cat-board-vh) - 104px) scroll
    // region in Board.tsx — one switch, not a prop threaded through helpers.
    expect(BOARD_VH_VAR).toBe("--cat-board-vh");
  });
});
