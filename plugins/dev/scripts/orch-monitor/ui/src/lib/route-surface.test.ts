// route-surface.test.ts — units for the CTL-989 pathname↔surface map. Pure
// logic, no DOM — run from the ui package:
//   cd ui && bun test src/lib/route-surface.test.ts
import { describe, it, expect } from "bun:test";
import { SURFACES, type Surface } from "./surface";
import {
  pathnameToSurface,
  surfaceToPath,
  isDetailPath,
  detailPathSurface,
  SURFACE_PATH,
  SETTINGS_PATH,
} from "./route-surface";

describe("surfaceToPath", () => {
  it("maps home to the root path", () => {
    expect(surfaceToPath("home")).toBe("/");
  });

  it("maps each non-home surface to its clean typed segment", () => {
    expect(surfaceToPath("board")).toBe("/board");
    expect(surfaceToPath("workers")).toBe("/workers");
    // CTL-1054: Queue surface renamed to Dispatch; canonical URL is /dispatch.
    expect(surfaceToPath("queue")).toBe("/dispatch");
    expect(surfaceToPath("telemetry")).toBe("/telemetry");
    expect(surfaceToPath("utilization")).toBe("/utilization");
    expect(surfaceToPath("finops")).toBe("/finops");
    expect(surfaceToPath("fleetops")).toBe("/fleetops");
    expect(surfaceToPath("devops")).toBe("/devops");
  });

  it("has a path for EVERY declared surface (totality)", () => {
    for (const s of SURFACES as readonly Surface[]) {
      expect(typeof SURFACE_PATH[s]).toBe("string");
      expect(SURFACE_PATH[s].startsWith("/")).toBe(true);
    }
  });
});

describe("pathnameToSurface", () => {
  it("derives each surface from its path (round-trips surfaceToPath)", () => {
    for (const s of SURFACES as readonly Surface[]) {
      expect(pathnameToSurface(surfaceToPath(s))).toBe(s);
    }
  });

  it("maps the root path to home (the calm Inbox default)", () => {
    expect(pathnameToSurface("/")).toBe("home");
  });

  it("maps the settings path to the settings sentinel", () => {
    expect(pathnameToSurface(SETTINGS_PATH)).toBe("settings");
  });

  it("falls back to home for an unknown path (never throws)", () => {
    expect(pathnameToSurface("/nonsense")).toBe("home");
    expect(pathnameToSurface("")).toBe("home");
  });

  it("highlights the BOARD surface for a ticket/dep-graph detail page by default", () => {
    // A cold deep-link (no ?from) highlights Tickets — where those lists live.
    expect(pathnameToSurface("/ticket/CTL-845")).toBe("board");
    expect(pathnameToSurface("/dep-graph")).toBe("board");
  });

  it("highlights the WORKERS surface for a detail page opened from=workers", () => {
    expect(pathnameToSurface("/worker/CTL-845:2", { from: "workers" })).toBe(
      "workers",
    );
    expect(pathnameToSurface("/ticket/CTL-845", { from: "workers" })).toBe(
      "workers",
    );
  });

  it("highlights board for from=board/stuck/recent (only workers overrides)", () => {
    for (const from of ["board", "stuck", "recent"]) {
      expect(pathnameToSurface("/ticket/CTL-845", { from })).toBe("board");
    }
  });
});

describe("isDetailPath", () => {
  it("matches the detail + dep-graph routes", () => {
    expect(isDetailPath("/ticket/CTL-845")).toBe(true);
    expect(isDetailPath("/worker/CTL-845:2")).toBe(true);
    expect(isDetailPath("/dep-graph")).toBe(true);
  });

  it("does not match surface paths or nested forms", () => {
    expect(isDetailPath("/board")).toBe(false);
    expect(isDetailPath("/")).toBe(false);
    expect(isDetailPath("/ticket/CTL-845/extra")).toBe(false);
    expect(isDetailPath("/dep-graph/")).toBe(false);
  });
});

describe("detailPathSurface", () => {
  it("returns workers only for from=workers, else board", () => {
    expect(detailPathSurface("workers")).toBe("workers");
    expect(detailPathSurface("board")).toBe("board");
    expect(detailPathSurface(undefined)).toBe("board");
    expect(detailPathSurface("recent")).toBe("board");
  });
});
