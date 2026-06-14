// ticket-badge.test.ts — units for the CTL-996 badge design system. Exercises
// the PURE kind→{icon,color} seam (badgeSpecForKind) — no DOM needed (bun has no
// renderer here; the kind→color/icon table + the unknown-kind fallback are the
// load-bearing contract, the JSX skin over them is structural and verified by the
// vite build + live UI). Run from ui:
//   cd ui && bun test src/components/ui/ticket-badge.test.ts
import { describe, it, expect } from "bun:test";
import { badgeSpecForKind } from "./ticket-badge";

describe("badgeSpecForKind — the §B7 palette table", () => {
  it("maps every type kind to its spec colour + an icon", () => {
    expect(badgeSpecForKind("bug").color).toBe("#e5484d");
    expect(badgeSpecForKind("feature").color).toBe("#8b5cf6");
    expect(badgeSpecForKind("refactor").color).toBe("#14b8a6");
    expect(badgeSpecForKind("docs").color).toBe("#3b82f6");
    expect(badgeSpecForKind("chore").color).toBe("#8d8d8d");
    expect(badgeSpecForKind("test").color).toBe("#22c55e");
    for (const kind of ["bug", "feature", "refactor", "docs", "chore", "test"]) {
      expect(badgeSpecForKind(kind).icon).not.toBeNull();
    }
  });

  it("maps the model:* kinds (all share the Cpu icon)", () => {
    expect(badgeSpecForKind("model:opus").color).toBe("#a855f7");
    expect(badgeSpecForKind("model:sonnet").color).toBe("#3b82f6");
    expect(badgeSpecForKind("model:haiku").color).toBe("#10b981");
    expect(badgeSpecForKind("model:opus").icon).not.toBeNull();
  });

  it("maps the cost:* tiers to green/yellow/red", () => {
    expect(badgeSpecForKind("cost:low").color).toBe("#39d07a");
    expect(badgeSpecForKind("cost:med").color).toBe("#eab308");
    expect(badgeSpecForKind("cost:high").color).toBe("#ef5d5d");
  });

  it("falls back to neutral grey with NO icon for an unknown kind (never throws)", () => {
    expect(() => badgeSpecForKind("nonsense")).not.toThrow();
    const spec = badgeSpecForKind("nonsense");
    expect(spec.color).toBe("#8d8d8d");
    expect(spec.icon).toBeNull();
    // empty string is also a safe unknown
    expect(badgeSpecForKind("").icon).toBeNull();
  });
});
