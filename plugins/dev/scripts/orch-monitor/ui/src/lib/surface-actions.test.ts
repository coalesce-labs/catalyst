import { describe, it, expect } from "bun:test";
import { buildSurfaceActions, surfaceChordYieldsToDetail, surfaceKeybinding } from "./surface-actions";
import { SURFACE_CHORD } from "./surface-constants";

describe("buildSurfaceActions", () => {
  const jumps: string[] = [];
  const actions = buildSurfaceActions({
    jumpToSurface: (s) => jumps.push(s),
    create: () => jumps.push("create"),
  });

  it("emits one global action per SURFACE_CHORD entry with a 'g <key>' keybinding", () => {
    for (const [key, surface] of Object.entries(SURFACE_CHORD)) {
      const a = actions.find((x) => x.keybinding === `g ${key}`);
      expect(a, `binding g ${key}`).toBeDefined();
      expect(a!.scope).toBe("global");
      a!.handler();
      expect(jumps.at(-1)).toBe(surface);
    }
  });

  it("registers `c` → create as a global action (deferred handler ok)", () => {
    const c = actions.find((x) => x.keybinding === "c");
    expect(c?.id).toBe("action.create");
    expect(c?.scope).toBe("global");
  });
});

describe("g-chord detail precedence (Open Question #4)", () => {
  it("yields g t / g w / g a to the detail Shell on a detail route", () => {
    for (const key of ["t", "w", "a"]) {
      expect(surfaceChordYieldsToDetail("/ticket/CTL-1", key)).toBe(true);
      expect(surfaceChordYieldsToDetail("/worker/abc", key)).toBe(true);
    }
  });
  it("does NOT yield non-overlapping surface keys on a detail route", () => {
    expect(surfaceChordYieldsToDetail("/ticket/CTL-1", "b")).toBe(false);
  });
  it("never yields off a detail route", () => {
    expect(surfaceChordYieldsToDetail("/board", "w")).toBe(false);
    expect(surfaceChordYieldsToDetail("/", "t")).toBe(false);
  });
});

describe("surfaceKeybinding — hover-hint source", () => {
  it("returns the g-chord for a surface", () => {
    expect(surfaceKeybinding("board")).toBe("g b");
    expect(surfaceKeybinding("workers")).toBe("g w");
    expect(surfaceKeybinding("home")).toBe("g h");
  });
});
