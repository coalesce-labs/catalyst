// detail-nav.test.ts — CTL-942 + CTL-951 + CTL-989 acceptance guards for the
// card → detail-page navigation wiring.
//
// CTL-989 — the two SPA bundles collapsed into ONE TanStack Router, so opening a
// detail page is a CLIENT-SIDE `navigate(...)` (no full-document reload, the left
// nav stays). The sessionStorage list-context bridge + `hardNavigate` are retired
// (they existed only to survive the full-doc nav the two-entry split forced); the
// URL search params + native router scroll restoration cover the round-trip now.
//
// `bun test` has no DOM, so — matching the established app-shell.test.ts pattern —
// the pure helpers are unit-tested directly and the load-bearing JSX wiring (cards
// open the detail page on a PLAIN click via a router navigate) is asserted by
// static source analysis.
import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ticketDetailHref,
  workerDetailHref,
  detailHref,
  detailNavigateOptions,
  openDetail,
  isNewTabClick,
} from "./detail-nav";
import type { BoardPayload, BoardTicket, BoardWorker } from "./types";
import { laneColumns, visibleColumnDefs } from "./board-display";
import { resolveListIds, sortWorkers, type Ordering } from "./list-order";

const HERE = dirname(fileURLToPath(import.meta.url));
const boardSrc = readFileSync(join(HERE, "Board.tsx"), "utf8");
const boardListSrc = readFileSync(join(HERE, "BoardList.tsx"), "utf8");
const detailNavSrc = readFileSync(join(HERE, "detail-nav.ts"), "utf8");

// ── fixtures (the REAL shipped shapes; mirrors list-data.test.ts) ────────────
const t = (over: Partial<BoardTicket> & { id: string }): BoardTicket => ({
  title: `title ${over.id}`,
  type: "feature",
  repo: "catalyst",
  team: "CTL",
  phase: "implement",
  status: "active",
  model: null,
  linearState: "Implement",
  workerStatus: null,
  activeState: null,
  working: false,
  lastActiveMs: null,
  priority: 3,
  estimate: null,
  scope: null,
  project: null,
  costUSD: null,
  tokens: null,
  turns: null,
  phaseCosts: null,
  phaseSummary: [],
  pr: null,
  updatedAt: "2026-06-09T00:00:00.000Z",
  host: null,
  ...over,
});

const w = (over: Partial<BoardWorker> & { name: string }): BoardWorker => ({
  ticket: over.ticket ?? over.name,
  tickets: over.tickets ?? [over.ticket ?? over.name],
  phase: "implement",
  status: "active",
  activeState: null,
  working: false,
  lastActiveMs: null,
  repo: "catalyst",
  team: "CTL",
  runtimeMs: null,
  costUSD: null,
  ...over,
});

const payload = (tickets: BoardTicket[], workers: BoardWorker[] = []): BoardPayload => ({
  generatedAt: "",
  config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
  repos: [],
  workers,
  tickets,
  queue: [],
});

describe("detail-page hrefs (CTL-942 — kept for the new-tab gesture)", () => {
  it("builds /ticket/$id and /worker/$id paths the server SPA fallback answers", () => {
    expect(ticketDetailHref("CTL-845")).toBe("/ticket/CTL-845");
    expect(workerDetailHref("CTL-845:2")).toBe("/worker/CTL-845%3A2");
  });

  it("encodes ids so a weird segment can never escape the route", () => {
    expect(ticketDetailHref("a/b")).toBe("/ticket/a%2Fb");
  });
});

describe("detailHref carries the list-origin search params (CTL-951)", () => {
  it("encodes from/lens/col/cursor so the Shell reconstructs the breadcrumb + pager", () => {
    expect(
      detailHref("ticket", "CTL-845", { from: "board", lens: "phase", col: "Implement", cursor: 3 }),
    ).toBe("/ticket/CTL-845?from=board&lens=phase&col=Implement&cursor=3");
  });

  it("omits absent fields (a cold context yields just from)", () => {
    expect(detailHref("worker", "CTL-845:2", { from: "board" })).toBe(
      "/worker/CTL-845%3A2?from=board",
    );
  });

  it("drops a negative / non-integer cursor (route-search coerces defensively too)", () => {
    expect(detailHref("ticket", "T", { from: "board", cursor: -1 })).toBe("/ticket/T?from=board");
    expect(detailHref("ticket", "T", { from: "board", cursor: 2.5 })).toBe("/ticket/T?from=board");
  });
});

describe("isNewTabClick gesture (CTL-942 / CTL-951)", () => {
  const click = (over: Partial<{ metaKey: boolean; ctrlKey: boolean; button: number }>) => ({
    metaKey: false,
    ctrlKey: false,
    button: 0,
    ...over,
  });

  it("recognises cmd-click, ctrl-click, and middle-click (open in a new tab)", () => {
    expect(isNewTabClick(click({ metaKey: true }))).toBe(true);
    expect(isNewTabClick(click({ ctrlKey: true }))).toBe(true);
    expect(isNewTabClick(click({ button: 1 }))).toBe(true);
  });

  it("a PLAIN primary click is NOT a new-tab gesture (it navigates in place)", () => {
    expect(isNewTabClick(click({}))).toBe(false);
  });
});

// ── CTL-989: openDetail is now a CLIENT-SIDE router navigate ──────────────────
describe("detailNavigateOptions — the typed router navigate target (CTL-989)", () => {
  it("targets /ticket/$id with the clicked id as a route param", () => {
    const opts = detailNavigateOptions("ticket", "CTL-845", {
      ids: ["CTL-1", "CTL-845", "CTL-9"],
      lens: "phase",
      col: "Implement",
      from: "board",
    });
    expect(opts.to).toBe("/ticket/$id");
    expect((opts.params as { id: string }).id).toBe("CTL-845");
  });

  it("targets /worker/$id for a worker card (ids carry colons, the router encodes)", () => {
    const opts = detailNavigateOptions("worker", "CTL-845:2", { ids: ["CTL-845:2"] });
    expect(opts.to).toBe("/worker/$id");
    expect((opts.params as { id: string }).id).toBe("CTL-845:2");
  });

  it("carries from/lens/col + the clicked cursor index, preserving the inherited ?scope", () => {
    const opts = detailNavigateOptions("ticket", "CTL-9", {
      ids: ["CTL-1", "CTL-9", "CTL-3"],
      lens: "linear",
      col: "Research",
      from: "board",
    });
    const search = (opts.search as (prev: Record<string, unknown>) => Record<string, unknown>)({
      scope: "catalyst",
    });
    expect(search).toEqual({
      scope: "catalyst", // the inherited repo scope survives the merge
      from: "board",
      lens: "linear",
      col: "Research",
      cursor: 1, // index of CTL-9 in ids
    });
  });

  it("omits the cursor when the clicked id is not in the on-screen list", () => {
    const opts = detailNavigateOptions("ticket", "CTL-X", { ids: ["CTL-1", "CTL-2"], from: "board" });
    const search = (opts.search as (prev: Record<string, unknown>) => Record<string, unknown>)({});
    expect(search).toEqual({ from: "board" });
    expect("cursor" in search).toBe(false);
  });

  it("defaults `from` to board when the caller omits it", () => {
    const opts = detailNavigateOptions("ticket", "T", { ids: ["T"] });
    const search = (opts.search as (prev: Record<string, unknown>) => Record<string, unknown>)({});
    expect(search.from).toBe("board");
  });
});

describe("openDetail invokes the supplied navigate (CTL-989 — client-side, no reload)", () => {
  it("calls navigate with the detailNavigateOptions for the click", () => {
    const calls: unknown[] = [];
    const navigate = (opts: unknown) => calls.push(opts);
    openDetail(navigate as never, "ticket", "CTL-845", {
      ids: ["CTL-845"],
      lens: "phase",
      col: "Implement",
    });
    expect(calls.length).toBe(1);
    const opts = calls[0] as { to: string; params: { id: string } };
    expect(opts.to).toBe("/ticket/$id");
    expect(opts.params.id).toBe("CTL-845");
  });
});

describe("the sessionStorage list-context bridge is fully retired (CTL-989)", () => {
  it("detail-nav.ts no longer exports the sessionStorage snapshot helpers", () => {
    for (const sym of [
      "writeListContext",
      "readListContext",
      "parseListContext",
      "clearListContext",
      "LIST_CONTEXT_STORAGE_KEY",
      "ListContextSnapshot",
    ]) {
      expect(detailNavSrc).not.toContain(`export function ${sym}`);
      expect(detailNavSrc).not.toContain(`export const ${sym}`);
      expect(detailNavSrc).not.toContain(`export interface ${sym}`);
    }
  });

  it("hardNavigate (window.location.assign) is gone — navigation is client-side", () => {
    expect(detailNavSrc).not.toContain("hardNavigate");
    expect(detailNavSrc).not.toContain("window.location.assign");
  });
});

describe("kanban card wiring (static source, CTL-951 + CTL-989)", () => {
  it("ticket + worker cards open the detail page via the shared openDetail seam", () => {
    expect(boardSrc).toContain("openDetail");
    expect(boardSrc).toContain('onOpen?.("ticket", t.id');
    expect(boardSrc).toContain('onOpen?.("worker", w.name');
  });

  it("CTL-989: the onOpen seam is a CLIENT-SIDE router navigate (no reload)", () => {
    // The Board holds useNavigate() and passes it into openDetail; there is no
    // sessionStorage scroll snapshot and no window.location.assign anymore.
    expect(boardSrc).toContain("const navigate = useNavigate()");
    expect(boardSrc).toContain("openDetail(navigate,");
    expect(boardSrc).not.toContain("hardNavigate");
    expect(boardSrc).not.toContain("writeListContext");
  });

  it("cmd/ctrl-click still opens the page in a new tab (the modified-click gesture)", () => {
    expect(boardSrc).toContain("isNewTabClick");
    expect(boardSrc).toContain("ticketDetailHref(t.id)");
    expect(boardSrc).toContain("workerDetailHref(w.name)");
  });

  it("middle-click is wired via onAuxClick on both cards", () => {
    const auxCount = boardSrc.split("onAuxClick").length - 1;
    expect(auxCount).toBeGreaterThanOrEqual(2);
  });

  it("the originating card is stamped with data-card-id (re-focus + accessibility)", () => {
    expect(boardSrc).toContain("data-card-id={t.id}");
    expect(boardSrc).toContain("data-card-id={w.name}");
  });
});

describe("board scroll restoration is native (CTL-989)", () => {
  it("the board scroller registers with TanStack Router scroll restoration", () => {
    const swimlaneSrc = readFileSync(join(HERE, "Swimlane.tsx"), "utf8");
    expect(swimlaneSrc).toContain('data-scroll-restoration-id="board-scroll"');
  });
});

describe("dense list card wiring (static source, CTL-951)", () => {
  it("a row click navigates straight to the detail page carrying THIS list's order", () => {
    expect(boardListSrc).toContain("onOpen(navKind, rid, { ids: orderedIds, lens, col: \"list\" })");
    expect(boardListSrc).toContain("data-card-id={id}");
  });
});

describe("the drawer is fully removed (CTL-951)", () => {
  it("ticket-detail-drawer.tsx no longer exists", () => {
    expect(existsSync(join(HERE, "..", "components", "ticket-detail-drawer.tsx"))).toBe(false);
  });

  it("Board.tsx no longer imports or renders the drawer", () => {
    expect(boardSrc).not.toContain("import { TicketDetailDrawer }");
    expect(boardSrc).not.toContain("<TicketDetailDrawer");
  });
});

describe("pager order == board order (CTL-951 deliverable b — the shared comparator)", () => {
  // tickets spread across linear columns, with intra-column order that the BOARD2
  // `order` knob re-sorts (so a NAIVE pager that ignored the comparator would drift).
  const tickets: BoardTicket[] = [
    t({ id: "CTL-1", linearState: "Implement", priority: 4, updatedAt: "2026-06-01T00:00:00.000Z" }),
    t({ id: "CTL-2", linearState: "Implement", priority: 1, updatedAt: "2026-06-02T00:00:00.000Z" }),
    t({ id: "CTL-3", linearState: "Implement", priority: 2, updatedAt: "2026-06-05T00:00:00.000Z" }),
    t({ id: "CTL-4", linearState: "Research", priority: 3 }),
  ];

  // The kanban column ids a TicketCard carries into openDetail are EXACTLY
  // `laneColumns(...).items.map(id)` — Board.tsx:`const colIds = c.items.map(t=>t.id)`.
  function kanbanColumnIds(order: Ordering | undefined, col: string): string[] {
    const defs = visibleColumnDefs(tickets, { groupBy: "linear", showEmptyColumns: true });
    const lane = laneColumns(tickets, defs, { groupBy: "linear", order });
    return lane.find((c) => c.key === col)?.items.map((e) => e.id) ?? [];
  }

  it("the column ids a card carries (priority order) == the detail pager's resolveListIds", () => {
    const order: Ordering = "priority";
    const cardIds = kanbanColumnIds(order, "Implement");
    const pagerIds = resolveListIds(payload(tickets), {
      kind: "ticket",
      lens: "linear",
      col: "Implement",
      order,
    });
    expect(cardIds).toEqual(pagerIds);
    // sanity: priority sort puts Urgent(1) first, then High(2), then Low(4).
    expect(cardIds).toEqual(["CTL-2", "CTL-3", "CTL-1"]);
  });

  it("parity holds under the `recent` order too (no drift when the knob changes)", () => {
    const order: Ordering = "recent";
    const cardIds = kanbanColumnIds(order, "Implement");
    const pagerIds = resolveListIds(payload(tickets), {
      kind: "ticket",
      lens: "linear",
      col: "Implement",
      order,
    });
    expect(cardIds).toEqual(pagerIds);
    // recent = updatedAt desc → CTL-3 (Jun 5), CTL-2 (Jun 2), CTL-1 (Jun 1).
    expect(cardIds).toEqual(["CTL-3", "CTL-2", "CTL-1"]);
  });

  it("worker cards carry the whole rank-sorted queue == the worker pager's ids", () => {
    const workers = [
      w({ name: "CTL-9:1", activeState: null, runtimeMs: 100 }),
      w({ name: "CTL-8:1", activeState: "active", runtimeMs: 50 }),
      w({ name: "CTL-7:1", activeState: "stuck", runtimeMs: 200 }),
    ];
    const p = payload([], workers);
    // Board.tsx: `const workerIds = sortWorkers(workers).map(w=>w.name)` — the SAME
    // single queue order the worker pager walks (resolveListIds kind:"worker").
    const cardIds = sortWorkers(workers).map((x) => x.name);
    const pagerIds = resolveListIds(p, { kind: "worker" });
    expect(cardIds).toEqual(pagerIds);
    // active first, then idle (waiting), then stuck.
    expect(cardIds).toEqual(["CTL-8:1", "CTL-9:1", "CTL-7:1"]);
  });
});

describe("Shell Esc-restore wiring (static source, CTL-989 — client-side back)", () => {
  const shellSrc = readFileSync(join(HERE, "Shell.tsx"), "utf8");
  it("Esc / breadcrumb-root returns to the board via a CLIENT-SIDE router navigation", () => {
    // No full-document hardNavigate anymore — the Board lives in the same router
    // tree, so goRoot prefers history.back() (replays scroll restoration) and
    // falls back to a forward navigate for a cold deep-link.
    expect(shellSrc).not.toContain("hardNavigate");
    expect(shellSrc).toContain("router.history.back()");
    expect(shellSrc).toContain("useCanGoBack");
  });

  it("goRoot is the single return target wired to BOTH Esc and the breadcrumb", () => {
    expect(shellSrc).toContain("onRoot={goRoot}");
    expect(shellSrc).toContain("const goRoot = useCallback(");
    // The Escape handler ends at goRoot() after exhausting the overlay layers.
    expect(shellSrc).toMatch(/onEscape[\s\S]*goRoot\(\)/);
  });
});

// CTL-989 supersedes the CTL-971 surface-restore reseat. The board surface is
// now a REAL URL path (/board), so browser Back / refresh reconstruct the
// surface natively from the URL. AppShell DERIVES the active surface from the
// route (route-surface.ts), and the useSurface() hook reads the router state —
// there is no SurfaceContext.setSurface and no sessionStorage surface-reseat hack.
describe("CTL-989: shell derives SURFACE from the route (static source)", () => {
  const appShellSrc = readFileSync(join(HERE, "..", "components", "app-shell.tsx"), "utf8");

  it("AppShell derives the active surface from the route, not a surface-restore reseat", () => {
    expect(appShellSrc).toContain("pathnameToSurface");
    expect(appShellSrc).toContain("useRouterState");
    expect(appShellSrc).toContain("useNavigate");
    // The legacy surface-restore reseat is no longer wired into the shell.
    expect(appShellSrc).not.toContain("useSurfaceRestore(");
    // The retired hook files are gone entirely.
    expect(existsSync(join(HERE, "..", "hooks", "use-surface-restore.ts"))).toBe(false);
    expect(existsSync(join(HERE, "..", "hooks", "use-board-restore.ts"))).toBe(false);
  });

  it("the SurfaceContext.setSurface mechanism is retired (useSurface reads the route)", () => {
    const surfaceSrc = readFileSync(join(HERE, "..", "lib", "surface.ts"), "utf8");
    expect(surfaceSrc).not.toContain("setSurface");
    expect(surfaceSrc).not.toContain("SurfaceContext");
    expect(surfaceSrc).toContain("useRouterState");
  });
});
