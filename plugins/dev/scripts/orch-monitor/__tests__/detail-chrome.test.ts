// detail-chrome.test.ts — units for the PURE detail-page shell derivations
// (CTL-912 / DETAIL1, detail design §3). Encodes the breadcrumb, pager, cold-link
// and live-dot Gherkin scenarios against ui/src/board/detail-chrome.ts — no React
// / jotai / router needed (the same pure-module discipline as list-order.test.ts
// / recents.test.ts). `Shell.tsx` is a thin skin over these functions, so the
// breadcrumb / `N / total` / dot the operator sees can never drift from what
// these units lock in.
import { describe, it, expect } from "bun:test";
import {
  resolveBreadcrumb,
  breadcrumbText,
  resolvePager,
  resolveLiveDot,
  LIVE_CYAN,
  STUCK_RED,
  CHROME_BLUE,
} from "../ui/src/board/detail-chrome";

// ── Gherkin: From-context breadcrumb reconstructs from the URL ───────────────
describe("resolveBreadcrumb / breadcrumbText — pure fn of the search params", () => {
  it('reads "◂ Board · Implement  CTL-845" for ?from=board&lens=phase&col=Implement', () => {
    const ctx = { id: "CTL-845", from: "board" as const, lens: "phase" as const, col: "Implement" };
    expect(breadcrumbText(ctx)).toBe("◂ Board · Implement  CTL-845");

    const crumbs = resolveBreadcrumb(ctx);
    expect(crumbs).toEqual([
      { label: "◂ Board", to: "/" },
      { label: "Implement", to: "/" },
      { label: "CTL-845", to: null },
    ]);
  });

  it('clicking "◂ Board" returns to / (the board root, always navigable)', () => {
    const crumbs = resolveBreadcrumb({ id: "CTL-845", from: "board", col: "Implement" });
    expect(crumbs[0].label).toBe("◂ Board");
    expect(crumbs[0].to).toBe("/");
    // the middle (list-context) crumb also routes to / — the shell restores the
    // column + scroll from the URL on land, so bare / is the right back-target.
    expect(crumbs[1].to).toBe("/");
    // the entity crumb is inert.
    expect(crumbs[crumbs.length - 1].to).toBeNull();
  });

  it('the SAME CTL-845 with ?from=stuck renders a "Stuck" middle crumb instead', () => {
    const crumbs = resolveBreadcrumb({ id: "CTL-845", from: "stuck" });
    expect(crumbs[0].label).toBe("◂ Stuck");
    // no col on a stuck walk → no middle column crumb, just root + entity.
    expect(crumbs.map((c) => c.label)).toEqual(["◂ Stuck", "CTL-845"]);
  });

  it("renders ?from=recent as a Recent root", () => {
    const crumbs = resolveBreadcrumb({ id: "CTL-831", from: "recent" });
    expect(crumbs[0].label).toBe("◂ Recent");
  });

  it('a degraded deep-link (no ?from) collapses to "Board › CTL-845"', () => {
    const ctx = { id: "CTL-845" };
    expect(breadcrumbText(ctx)).toBe("Board › CTL-845");
    expect(resolveBreadcrumb(ctx)).toEqual([
      { label: "Board", to: "/" },
      { label: "CTL-845", to: null },
    ]);
  });
});

// ── Gherkin: Pager walks the resolved list in place ─────────────────────────
describe("resolvePager — N/total over a resolved board list", () => {
  const ids = ["CTL-845", "CTL-877", "CTL-880", "CTL-881"];

  it('reports "N / total" with the right 1-based position and neighbours', () => {
    const p = resolvePager({ ids, id: "CTL-877" });
    expect(p.n).toBe(2);
    expect(p.total).toBe(4);
    expect(p.text).toBe("2 / 4");
    expect(p.inList).toBe(true);
    expect(p.ghosted).toBe(false);
    // ▾ / j → next, ▴ / k → prev
    expect(p.nextId).toBe("CTL-880");
    expect(p.prevId).toBe("CTL-845");
    expect(p.atStart).toBe(false);
    expect(p.atEnd).toBe(false);
  });

  it("disables (inerts) the chevrons at the ends of the list", () => {
    const first = resolvePager({ ids, id: "CTL-845" });
    expect(first.atStart).toBe(true);
    expect(first.prevId).toBeNull();
    expect(first.nextId).toBe("CTL-877");

    const last = resolvePager({ ids, id: "CTL-881" });
    expect(last.atEnd).toBe(true);
    expect(last.nextId).toBeNull();
    expect(last.prevId).toBe("CTL-880");
  });
});

// ── Gherkin: Cold-linked URL renders, pager lights up later ─────────────────
describe("resolvePager — cold-link ghost then silent light-up", () => {
  it('shows a ghosted "5 / —" with inert chevrons for a pasted ?cursor=4 with no list', () => {
    // cursor is 0-based on the URL; the counter is 1-based → cursor=4 ⇒ "5 / —".
    const ghost = resolvePager({ ids: [], id: "CTL-845", cursor: 4 });
    expect(ghost.ghosted).toBe(true);
    expect(ghost.text).toBe("5 / —");
    expect(ghost.total).toBeNull();
    expect(ghost.prevId).toBeNull();
    expect(ghost.nextId).toBeNull();
    expect(ghost.atStart).toBe(true);
    expect(ghost.atEnd).toBe(true);
    expect(ghost.inList).toBe(false);
  });

  it("silently lights up (no separate path) once the stream rehydrates the list", () => {
    // cold: ghost.
    const cold = resolvePager({ ids: [], id: "CTL-845", cursor: 0 });
    expect(cold.ghosted).toBe(true);
    // rehydrated: the SAME function with the populated list → a real pager.
    const ids = ["CTL-845", "CTL-877"];
    const lit = resolvePager({ ids, id: "CTL-845", cursor: 0 });
    expect(lit.ghosted).toBe(false);
    expect(lit.text).toBe("1 / 2");
    expect(lit.inList).toBe(true);
  });

  it('stays "— / —" when $id is not in the resolved list (only the breadcrumb navigates)', () => {
    const offList = resolvePager({ ids: ["CTL-877", "CTL-880"], id: "CTL-845" });
    expect(offList.text).toBe("— / —");
    expect(offList.n).toBeNull();
    expect(offList.total).toBeNull();
    expect(offList.inList).toBe(false);
    expect(offList.prevId).toBeNull();
    expect(offList.nextId).toBeNull();
  });

  it('falls to "— / —" for a cold-link with neither a list nor a cursor', () => {
    const bare = resolvePager({ ids: [], id: "CTL-845" });
    expect(bare.text).toBe("— / —");
    expect(bare.ghosted).toBe(true);
  });

  it("never mutates the input id list", () => {
    const ids = ["CTL-845", "CTL-877"];
    const copy = [...ids];
    resolvePager({ ids, id: "CTL-877" });
    expect(ids).toEqual(copy);
  });
});

// ── Gherkin: Live-dot title reserves cyan for genuine liveness only ─────────
describe("resolveLiveDot — cyan reserved to working && active", () => {
  it("a working active entity → a cyan breathing ring", () => {
    const dot = resolveLiveDot({ working: true, activeState: "active" });
    expect(dot.kind).toBe("live");
    if (dot.kind === "live") {
      expect(dot.color).toBe(LIVE_CYAN);
      // CTL-1033: LIVE_CYAN is now the canonical LIVE token (#53cde2).
      expect(dot.color).toBe("#53cde2");
      expect(dot.breathing).toBe(true);
    }
  });

  it("a stuck worker → a static red dot (never cyan)", () => {
    const dot = resolveLiveDot({ working: false, activeState: "stuck" });
    expect(dot.kind).toBe("stuck");
    if (dot.kind === "stuck") {
      expect(dot.color).toBe(STUCK_RED);
      // CTL-1033: STUCK_RED is now the canonical C.red token (#e36b6b).
      expect(dot.color).toBe("#e36b6b");
      expect(dot.breathing).toBe(false);
    }
  });

  it("a settled entity → no dot", () => {
    expect(resolveLiveDot({ working: false, activeState: null }).kind).toBe("none");
  });

  it("active but NOT working does not earn cyan (the license is the conjunction)", () => {
    // between tool calls a worker can be active yet working===false — no cyan.
    expect(resolveLiveDot({ working: false, activeState: "active" }).kind).toBe("none");
  });

  it("the chrome's non-live accents are blue, NEVER the cyan live token", () => {
    // CTL-1033: CHROME_BLUE is now the canonical C.blue token (#5e9ee8).
    expect(CHROME_BLUE).toBe("#5e9ee8");
    expect(CHROME_BLUE).not.toBe(LIVE_CYAN);
  });
});
