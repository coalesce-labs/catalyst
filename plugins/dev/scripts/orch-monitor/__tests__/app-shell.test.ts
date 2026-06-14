// app-shell.test.ts — CTL-891 / SHELL1 acceptance guards.
//
// Encodes the three SHELL1 Gherkin scenarios. `bun test` has no DOM, so —
// matching the existing board-todo-column.test.ts pattern — the structural
// scenarios are asserted by static source analysis (read the .tsx as text and
// assert the load-bearing wiring), and the pure surface-contract core
// (lib/surface.ts) is unit-tested directly.
import { describe, it, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SURFACES,
  SURFACE_CHORD,
  SURFACE_BREADCRUMB,
  SURFACE_LABEL,
  isTypingTarget,
  type Surface,
} from "../ui/src/lib/surface";
import { detailCrumbFor } from "../ui/src/lib/nav-model";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");

// CTL-989: App.tsx is retired — the app entry is now main.tsx (mounts the ONE
// unified router) + app-router.tsx (the rootRoute renders <AppShell><Outlet/>).
// The SHELL1 "App renders AppShell as the frame" guards now read the router
// entry, which is where AppShell is mounted.
const appSrc = read("app-router.tsx") + "\n" + read("main.tsx");
const shellSrc = read("components/app-shell.tsx");
const sidebarComponentSrc = read("components/app-sidebar.tsx");
const sidebarPrimitiveSrc = read("components/ui/sidebar.tsx");

/**
 * Strip JS comments so "edge-to-edge" CLASSNAME assertions can't be tripped by
 * prose that merely mentions `mx-auto` / `max-w-*` in a code comment. Removes
 * block comments, JSX {comment} expressions, and `//` line comments.
 */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // {/* jsx comment */}
    .replace(/\/\*[\s\S]*?\*\//g, "") // /* block */
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // // line (skip http://)
}

const appCode = stripComments(appSrc);
const shellCode = stripComments(shellSrc);

// ── Pure surface contract (lib/surface.ts) ───────────────────────────────────
describe("surface contract (CTL-891)", () => {
  it("declares the OPERATE surfaces then the OBSERVE surfaces in nav order", () => {
    // OBS-5: the five OBSERVE analytics surfaces follow the three OPERATE surfaces.
    // CTL-1016: the queue surface is retired — its control tower folded into Workers.
    expect([...SURFACES]).toEqual([
      "home",
      "board",
      "workers",
      "telemetry",
      "utilization",
      "finops",
      "fleetops",
      "devops",
    ]);
  });

  it("maps a g-chord key to every surface (OPERATE h/b/w + OBSERVE t/u/f/o/d)", () => {
    // OBS-5: OBSERVE chords pick keys that don't collide with h/b/w —
    // t(elemetry) / u(tilization) / f(inops) / o(=fleetOps) / d(evops).
    expect(SURFACE_CHORD).toEqual({
      h: "home",
      b: "board",
      w: "workers",
      t: "telemetry",
      u: "utilization",
      f: "finops",
      o: "fleetops",
      d: "devops",
    });
    // Every surface is reachable by some chord, and every chord targets a real surface.
    const chordTargets = new Set(Object.values(SURFACE_CHORD));
    for (const s of SURFACES) expect(chordTargets.has(s)).toBe(true);
  });

  it("has a label and a breadcrumb trail for every surface", () => {
    for (const s of SURFACES) {
      expect(SURFACE_LABEL[s]).toBeTruthy();
      expect(SURFACE_BREADCRUMB[s].length).toBeGreaterThan(0);
    }
    // CTL-930: home trail is now "Overall · Inbox" (scope-aware breadcrumbs).
    expect(SURFACE_BREADCRUMB.home).toEqual(["Overall", "Inbox"]);
  });

  it("isTypingTarget guards INPUT/TEXTAREA/contentEditable so chords never steal typing", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

// ── Scenario: shadcn Sidebar primitive is the foundation, not the hand-rolled one
describe("shadcn Sidebar primitive is the foundation (CTL-891)", () => {
  it("ships a shadcn sidebar primitive exporting the load-bearing parts", () => {
    for (const sym of [
      "SidebarProvider",
      "Sidebar",
      "SidebarInset",
      "SidebarMenu",
      "SidebarTrigger",
      "SidebarRail",
      "useSidebar",
    ]) {
      expect(sidebarPrimitiveSrc).toContain(sym);
    }
  });

  it("the sidebar primitive is built on radix-ui + cva (matches the ui conventions, not base-ui)", () => {
    expect(sidebarPrimitiveSrc).toContain('from "radix-ui"');
    expect(sidebarPrimitiveSrc).toContain("class-variance-authority");
    // base-nova/base-ui drift must be reconciled away — no @base-ui imports leak in.
    expect(sidebarPrimitiveSrc).not.toContain("@base-ui");
  });

  it("AppSidebar composes the shadcn primitives (Provider/Inset live in AppShell)", () => {
    expect(sidebarComponentSrc).toContain("@/components/ui/sidebar");
    for (const sym of [
      "Sidebar",
      "SidebarContent",
      "SidebarGroup",
      "SidebarMenu",
      "SidebarMenuButton",
      "SidebarRail",
    ]) {
      expect(sidebarComponentSrc).toContain(sym);
    }
  });

  it("the OPERATE group lists Inbox, Tickets, Workers", () => {
    // CTL-930: surface labels renamed Home→Inbox, Board→Tickets.
    // CTL-1054: Queue surface renamed to Dispatch in all nav labels.
    // CTL-1016: the Dispatch (queue) surface is retired — its control tower folded
    // into Workers — so OPERATE is now just Inbox / Tickets / Workers.
    for (const label of ["Inbox", "Tickets", "Workers"]) {
      expect(sidebarComponentSrc).toContain(label);
    }
    expect(sidebarComponentSrc).toMatch(/Operate/i);
  });

  it("the legacy hand-rolled components/layout/sidebar is no longer the App frame", () => {
    // App.tsx must not import the hand-rolled layout sidebar as its frame anymore.
    expect(appSrc).not.toContain("./components/layout/sidebar");
    expect(appSrc).not.toContain("components/layout/sidebar");
    // The new shadcn shell is the frame instead.
    expect(appSrc).toContain("app-shell");
  });
});

// ── Scenario: One shell hosts every surface + Edge-to-edge by default ─────────
describe("one edge-to-edge shell hosts every surface (CTL-891)", () => {
  it("AppShell uses a CONTROLLED SidebarProvider wrapping SidebarInset", () => {
    expect(shellSrc).toContain("SidebarProvider");
    expect(shellSrc).toContain("SidebarInset");
    // Controlled (owns open + onOpenChange) so BOTH `[` and Cmd/Ctrl+B drive collapse.
    expect(shellSrc).toMatch(/onOpenChange/);
  });

  it("the shell is full-viewport (h-screen) with NO centered gutter", () => {
    expect(shellSrc).toContain("h-screen");
    // Edge-to-edge: no centered max-w / mx-auto CLASSNAME around the chrome
    // (comments stripped so prose mentioning the tokens doesn't false-positive).
    expect(shellCode).not.toMatch(/\bmx-auto\b/);
    expect(shellCode).not.toMatch(
      /\bmax-w-(sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|screen)\b/,
    );
    expect(appCode).not.toMatch(/\bmx-auto\b/);
  });

  it("AppShell binds the `[` collapse toggle and `g`-chord surface jumps", () => {
    // CTL-930: `[` handling delegated to shouldToggleSidebar (lib/sidebar-collapse.ts).
    // The shell wires the predicate instead of inlining the key literal.
    expect(shellSrc).toContain("shouldToggleSidebar");
    expect(shellSrc).toContain("isTypingTarget");
    // CTL-1025: the `g`-chord surface jumps now route through the action registry —
    // buildSurfaceActions (keyed off SURFACE_CHORD in surface-actions.ts) resolved by
    // matchAction — instead of an inline SURFACE_CHORD lookup in the shell. The chord
    // still yields t/w/a to the detail Shell on detail routes.
    expect(shellSrc).toContain("buildSurfaceActions");
    expect(shellSrc).toContain("matchAction");
    expect(shellSrc).toContain("surfaceChordYieldsToDetail");
  });

  it("App.tsx renders the active surface INSIDE the shell (edge-to-edge inset)", () => {
    expect(appSrc).toContain("AppShell");
  });
});

// ── CTL-1003 §A1: one header — no search box, no collapse icon ───────────────
describe("one header: no search box, no SidebarTrigger collapse icon (CTL-1003)", () => {
  it("the header no longer renders the ⌘K search BUTTON (keyboard paths remain)", () => {
    // The visible top-strip search trigger button is removed; the data-cmdk-trigger
    // attribute (its only marker) must be gone from the shell source.
    expect(shellSrc).not.toContain("data-cmdk-trigger");
    expect(shellSrc).not.toContain("Search…");
    // ⌘K / `/` keyboard open paths stay (the CommandDialog + shouldOpenPalette wiring).
    expect(shellSrc).toContain("shouldOpenPalette");
    expect(shellSrc).toContain("CommandDialog");
  });

  it("the SidebarTrigger collapse icon + its Separator are removed from the header", () => {
    // `[` / Cmd-B still toggle via shouldToggleSidebar — only the visible icon goes.
    expect(shellSrc).not.toContain("SidebarTrigger");
    expect(shellSrc).not.toMatch(/from "@\/components\/ui\/separator"/);
    expect(shellSrc).toContain("shouldToggleSidebar");
  });

  it("the header renders the single right-aligned HeaderActionsSlot", () => {
    expect(shellSrc).toContain("HeaderActionsSlot");
    expect(shellSrc).toContain("@/components/header-actions");
  });
});

// ── CTL-1018: ONE header per surface — no second toolbar bar below the shell ──
// The board and the four OBSERVE surfaces each used to stack a SECOND header bar
// (a "Tickets"/"Telemetry" toolbar) below the app-shell breadcrumb row. CTL-1018
// folds each one's controls into the SINGLE header row via the HeaderActions
// portal. Static source analysis (no DOM): each surface must portal through
// HeaderActions and must NOT render its own stacked header. Detail pages are
// intentionally excluded (already single-header via the CTL-1003 chrome="bare"
// path). CTL-1016 retired the queue control tower surface (folded into Workers).
describe("one header per surface — secondary toolbar bars folded up (CTL-1018)", () => {
  const boardSrc = read("board/Board.tsx");
  const observe = [
    "components/observe/telemetry-surface.tsx",
    "components/observe/finops-surface.tsx",
    "components/observe/utilization-surface.tsx",
    "components/observe/fleetops-surface.tsx",
  ].map((p) => [p, read(p)] as const);

  it("the board portals its controls into the shell header (no second subhead bar)", () => {
    // Controls now reach the single header via the portal…
    expect(boardSrc).toContain("HeaderActions");
    expect(boardSrc).toContain("@/components/header-actions");
    // …and the old standalone subhead <h1>{view === "tickets" ? "Tickets"…} bar is gone.
    expect(stripComments(boardSrc)).not.toContain(
      'view === "tickets" ? "Tickets" : "Workers"',
    );
  });

  it("every OBSERVE surface portals its controls (no stacked <header> title bar)", () => {
    for (const [path, src] of observe) {
      expect(src, `${path} must import HeaderActions`).toContain(
        "@/components/header-actions",
      );
      expect(src, `${path} must portal via HeaderActions`).toContain(
        "<HeaderActions>",
      );
      // The old `<header …><h1>…</h1></header>` surface title bar is gone.
      expect(
        stripComments(src),
        `${path} must not render its own <header> title bar`,
      ).not.toMatch(/<header\b/);
    }
  });
});

// ── CTL-1003 §A1: detailCrumbFor — the final ticket/worker breadcrumb crumb ───
describe("detailCrumbFor — pure final-crumb resolver (CTL-1003)", () => {
  it("returns the decoded id for a ticket/worker detail path", () => {
    expect(detailCrumbFor("/ticket/CTL-729")).toBe("CTL-729");
    expect(detailCrumbFor("/worker/CTL-845:2")).toBe("CTL-845:2");
    // percent-encoded ids decode (a worker id with a colon arrives URL-encoded).
    expect(detailCrumbFor("/worker/CTL-845%3A2")).toBe("CTL-845:2");
  });

  it("returns null for non-detail surfaces", () => {
    expect(detailCrumbFor("/board")).toBeNull();
    expect(detailCrumbFor("/workers")).toBeNull();
    expect(detailCrumbFor("/")).toBeNull();
    expect(detailCrumbFor("/settings")).toBeNull();
  });

  it("returns null for a malformed / over-segmented detail path and never throws", () => {
    expect(detailCrumbFor("/ticket/")).toBeNull();
    expect(detailCrumbFor("/ticket/CTL-1/extra")).toBeNull();
    expect(detailCrumbFor("/ticketCTL-1")).toBeNull();
    // a broken percent-encoding falls back to the raw id, not a throw.
    expect(() => detailCrumbFor("/ticket/%E0%A4%A")).not.toThrow();
    expect(detailCrumbFor("/ticket/%E0%A4%A")).toBe("%E0%A4%A");
  });
});

// Sanity: the Surface type is exhaustively iterable (compile-time exhaustiveness
// is also enforced by `satisfies`-free switch usage in App; this is the runtime guard).
test("SURFACES round-trips the Surface union", () => {
  const seen: Record<Surface, boolean> = {
    home: false,
    board: false,
    workers: false,
    telemetry: false,
    utilization: false,
    finops: false,
    fleetops: false,
    devops: false,
    rulebook: false,
  };
  for (const s of SURFACES) seen[s] = true;
  expect(Object.values(seen).every(Boolean)).toBe(true);
});
