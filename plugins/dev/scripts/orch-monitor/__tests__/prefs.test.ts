// prefs.test.ts — units for the persisted LANDING-SURFACE preference
// (CTL-911 / SURF3): the documented Home default + the clamp that resolves a
// missing / junk / stale stored value to a valid OPERATE surface. Imports the
// pure core of `ui/src/lib/prefs.ts` (injected structural storage, the same
// pattern as lib/theme.ts's readStoredTheme), so these run in the main
// orch-monitor `bun test` suite with no DOM / localStorage runtime.
//
// SURF3's other Settings controls deliberately have NO schema here — they
// route through the stores that already own that state on main:
//   - Board display defaults → boardPrefsAtom (board/prefs-store.ts, BOARD2),
//     unit-tested in ui/src/board/prefs-store.test.ts.
//   - Theme → @/lib/theme (SHELL3), unit-tested in app-shell-ia.test.ts.
//   - Sidebar collapse → @/lib/sidebar-collapse (SHELL4), unit-tested in
//     sidebar-collapse.test.ts.
import { describe, it, expect } from "bun:test";
import {
  DEFAULT_LANDING_SURFACE,
  LANDING_SURFACE_STORAGE_KEY,
  LANDING_SURFACES,
  normalizeLandingSurface,
  readStoredLandingSurface,
} from "../ui/src/lib/prefs";
import { SURFACES } from "../ui/src/lib/surface";

describe("landing-surface pref — documented defaults (CTL-911)", () => {
  it("defaults to Home (the calm Inbox) on a first-ever visit", () => {
    expect(DEFAULT_LANDING_SURFACE).toBe("home");
    expect(readStoredLandingSurface(null)).toBe("home");
    expect(readStoredLandingSurface({ getItem: () => null })).toBe("home");
  });

  it("exposes a stable, namespaced storage key (catalyst:* family)", () => {
    expect(LANDING_SURFACE_STORAGE_KEY).toBe("catalyst:landing-surface");
  });

  it("the eligible landing surfaces are the OPERATE surfaces plus shipped OBSERVE surfaces", () => {
    // Settings is a footer destination, never a landing.
    // OBS-5: LANDING_SURFACES is the three OPERATE surfaces plus any OBSERVE surface
    // that ships live content. Telemetry is the first OBSERVE surface to qualify;
    // the not-yet-shipped OBSERVE surfaces (utilization/finops/fleetops/devops) are
    // deliberately NOT offered as a landing default — so LANDING is a strict subset
    // of SURFACES, never the full nav array. CTL-1016 retired the queue surface.
    expect([...LANDING_SURFACES]).toEqual([
      "home",
      "board",
      "workers",
      "telemetry",
    ]);
    // The not-yet-shipped OBSERVE surfaces are excluded.
    for (const s of ["utilization", "finops", "fleetops", "devops"] as const) {
      expect(LANDING_SURFACES).not.toContain(s);
    }
  });
});

describe("landing-surface pref — clamp honors saved choices, defaults junk (CTL-911)", () => {
  it("every valid surface round-trips", () => {
    for (const s of SURFACES) {
      expect(normalizeLandingSurface(s)).toBe(s);
      expect(readStoredLandingSurface({ getItem: () => s })).toBe(s);
    }
  });

  it("junk / stale / non-string stored values fall back to Home (never invalid)", () => {
    expect(normalizeLandingSurface("settings")).toBe("home"); // not a landing
    expect(normalizeLandingSurface("neon-rave")).toBe("home");
    expect(normalizeLandingSurface("")).toBe("home");
    expect(normalizeLandingSurface(42)).toBe("home");
    expect(normalizeLandingSurface(null)).toBe("home");
    expect(normalizeLandingSurface(undefined)).toBe("home");
    expect(readStoredLandingSurface({ getItem: () => "garbage" })).toBe("home");
  });

  it("reads through the namespaced key", () => {
    const reads: string[] = [];
    readStoredLandingSurface({
      getItem: (k) => {
        reads.push(k);
        return "board";
      },
    });
    expect(reads).toEqual([LANDING_SURFACE_STORAGE_KEY]);
  });
});

describe("landing-surface pref — survives a (simulated) reload (CTL-911)", () => {
  it("the persisted value reads back to the same surface on reload", () => {
    // session 1: operator chose Board as the landing surface (what
    // writeLandingSurface stores under the key).
    const store = new Map<string, string>();
    store.set(LANDING_SURFACE_STORAGE_KEY, "board");

    // reload: the shell seeds its initial surface from the same bytes.
    const rehydrated = readStoredLandingSurface({
      getItem: (k) => store.get(k) ?? null,
    });
    expect(rehydrated).toBe("board");
  });
});
