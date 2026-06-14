// prefs.test.ts — CTL-1103 remediate (coverage): pin the LANDING_SURFACES
// membership contract. Phase 5 changed the filter to also exclude 'rulebook'
// (it must not be offered as a landing default), but nothing asserted the
// resulting set — a regression that re-added 'rulebook' or dropped a valid
// OPERATE surface would have gone uncaught. Pure; no DOM.
// Run: cd ui && bun test src/lib/prefs.test.ts
import { describe, it, expect } from "bun:test";
import {
  LANDING_SURFACES,
  DEFAULT_LANDING_SURFACE,
  normalizeLandingSurface,
  readStoredLandingSurface,
  LANDING_SURFACE_STORAGE_KEY,
} from "./prefs";
import type { Surface } from "./surface";

describe("LANDING_SURFACES", () => {
  it("includes the valid OPERATE landing surfaces", () => {
    for (const surface of ["home", "board", "workers", "telemetry"] as const) {
      expect(LANDING_SURFACES).toContain(surface);
    }
  });

  it("excludes rulebook (never a landing default)", () => {
    expect(LANDING_SURFACES).not.toContain("rulebook");
  });

  it("excludes the nav-disabled OBSERVE surfaces", () => {
    for (const surface of [
      "utilization",
      "finops",
      "fleetops",
      "devops",
    ] as const) {
      expect(LANDING_SURFACES).not.toContain(surface);
    }
  });

  it("is exactly the four eligible landing surfaces", () => {
    const expected: Surface[] = ["board", "home", "telemetry", "workers"];
    expect([...LANDING_SURFACES].sort()).toEqual(expected.sort());
  });

  it("the Home default is itself a valid landing surface", () => {
    expect(LANDING_SURFACES).toContain(DEFAULT_LANDING_SURFACE);
  });
});

describe("normalizeLandingSurface", () => {
  it("clamps junk / null to the Home default", () => {
    expect(normalizeLandingSurface(null)).toBe(DEFAULT_LANDING_SURFACE);
    expect(normalizeLandingSurface("not-a-surface")).toBe(
      DEFAULT_LANDING_SURFACE,
    );
    expect(normalizeLandingSurface(42)).toBe(DEFAULT_LANDING_SURFACE);
  });

  it("passes a valid surface through unchanged", () => {
    expect(normalizeLandingSurface("workers")).toBe("workers");
  });
});

describe("readStoredLandingSurface", () => {
  it("returns the Home default when storage is null", () => {
    expect(readStoredLandingSurface(null)).toBe(DEFAULT_LANDING_SURFACE);
  });

  it("reads and normalizes the stored value", () => {
    const storage = {
      getItem: (key: string) =>
        key === LANDING_SURFACE_STORAGE_KEY ? "telemetry" : null,
    };
    expect(readStoredLandingSurface(storage)).toBe("telemetry");
  });
});
