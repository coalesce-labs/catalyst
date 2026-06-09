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

  it("keeps Home/Queue on the dashboard (no regression)", () => {
    // Home + Queue must stay exactly what they rendered before — only board +
    // workers are special-cased now.
    const onDashboard = SURFACES.filter((s) => s !== "board" && s !== "workers");
    for (const s of onDashboard) {
      expect(surfaceContentKind(s)).toBe("dashboard");
    }
  });

  it("covers every declared surface (no surface falls through undefined)", () => {
    for (const s of SURFACES as readonly Surface[]) {
      expect(["board", "workers", "dashboard"]).toContain(surfaceContentKind(s));
    }
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
