// use-surface-restore.test.ts — CTL-971: the pure surface/scope reseat decision.
//
// `bun test` has no DOM, so we unit-test the PURE `resolveSurfaceRestore` mapping
// (snapshot → {surface, scope}) directly, and assert the hook's wiring (peek, no
// clear; reseat surface + scope) by static source analysis — matching the
// established detail-nav.test.ts / app-shell.test.ts pattern.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveSurfaceRestore } from "./use-surface-restore";
import type { RestoreSurface } from "../board/detail-nav";

const HERE = dirname(fileURLToPath(import.meta.url));

const snap = (surface: RestoreSurface, scope: string) => ({ surface, scope });

describe("resolveSurfaceRestore — snapshot → surface + scope (CTL-971)", () => {
  it("returns null for a null snapshot (the shell keeps its landing-pref default)", () => {
    expect(resolveSurfaceRestore(null)).toBeNull();
  });

  it("maps a board-card snapshot to the board surface, preserving the scope", () => {
    expect(resolveSurfaceRestore(snap("board", "catalyst"))).toEqual({
      surface: "board",
      scope: "catalyst",
    });
  });

  it("maps a worker-card snapshot to the workers surface", () => {
    expect(resolveSurfaceRestore(snap("workers", "all"))).toEqual({
      surface: "workers",
      scope: "all",
    });
  });

  it("carries the 'all' sentinel through unchanged (the unfiltered view)", () => {
    expect(resolveSurfaceRestore(snap("board", "all"))?.scope).toBe("all");
  });

  it("carries an arbitrary repo-key scope through unchanged", () => {
    expect(resolveSurfaceRestore(snap("workers", "adva"))?.scope).toBe("adva");
  });
});

describe("useSurfaceRestore wiring (static source, CTL-971)", () => {
  const src = readFileSync(join(HERE, "use-surface-restore.ts"), "utf8");

  it("PEEKS the snapshot — reads it but never clears it (the board consumes it)", () => {
    expect(src).toContain("readListContext()");
    // The board-local useBoardRestore owns clearListContext; this hook must not.
    expect(src).not.toContain("clearListContext");
  });

  it("applies the scope BEFORE the surface so the board mounts already scoped", () => {
    const scopeIdx = src.indexOf("applyScope(restore.scope)");
    const surfaceIdx = src.indexOf("applySurface(restore.surface)");
    expect(scopeIdx).toBeGreaterThan(-1);
    expect(surfaceIdx).toBeGreaterThan(-1);
    expect(scopeIdx).toBeLessThan(surfaceIdx);
  });

  it("fires AT MOST once per shell mount (a later deliberate jump is not yanked)", () => {
    expect(src).toContain("appliedRef");
    expect(src).toContain("if (appliedRef.current) return;");
  });
});
