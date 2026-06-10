// detail-nav.test.ts — CTL-942 + CTL-951 acceptance guards for the
// card → detail-page navigation wiring.
//
// `bun test` has no DOM, so — matching the established app-shell.test.ts /
// board-todo-column.test.ts pattern — the pure helpers are unit-tested directly
// and the load-bearing JSX wiring (cards open the detail page on a PLAIN click;
// the drawer is removed) is asserted by static source analysis.
import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ticketDetailHref,
  workerDetailHref,
  detailHref,
  isNewTabClick,
  parseListContext,
  LIST_CONTEXT_MAX_AGE_MS,
  type ListContextSnapshot,
} from "./detail-nav";
import type { BoardPayload, BoardTicket, BoardWorker } from "./types";
import { laneColumns, visibleColumnDefs } from "./board-display";
import { resolveListIds, sortWorkers, type Ordering } from "./list-order";

const HERE = dirname(fileURLToPath(import.meta.url));
const boardSrc = readFileSync(join(HERE, "Board.tsx"), "utf8");
const boardListSrc = readFileSync(join(HERE, "BoardList.tsx"), "utf8");

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

describe("detail-page hrefs (CTL-942)", () => {
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

describe("list-context snapshot parse/restore (CTL-951 + CTL-971)", () => {
  const base: ListContextSnapshot = {
    ids: ["CTL-1", "CTL-2", "CTL-3"],
    kind: "ticket",
    lens: "linear",
    col: "Implement",
    cursor: 1,
    focusId: "CTL-2",
    // CTL-971: BOTH scroll axes are load-bearing (CTL-950 single both-axes scroller).
    scroll: { top: 420, left: 1400 },
    surface: "board",
    scope: "catalyst",
    savedAt: 1_000,
  };

  it("round-trips a valid snapshot (board restores ids/scroll BOTH axes/surface/scope/focus)", () => {
    const parsed = parseListContext(JSON.stringify(base), 1_000);
    expect(parsed).toEqual(base);
    // explicit: both axes + the two CTL-971 fields survive the round-trip.
    expect(parsed?.scroll).toEqual({ top: 420, left: 1400 });
    expect(parsed?.surface).toBe("board");
    expect(parsed?.scope).toBe("catalyst");
  });

  it("drops a snapshot older than the max age (a stale session never yanks scroll)", () => {
    const parsed = parseListContext(JSON.stringify(base), base.savedAt + LIST_CONTEXT_MAX_AGE_MS + 1);
    expect(parsed).toBeNull();
  });

  it("returns null on a malformed blob rather than throwing", () => {
    expect(parseListContext("{not json", 1_000)).toBeNull();
    expect(parseListContext(JSON.stringify({ ids: "nope" }), 1_000)).toBeNull();
    expect(parseListContext(JSON.stringify({ ...base, kind: "bogus" }), 1_000)).toBeNull();
    expect(parseListContext(JSON.stringify({ ...base, focusId: 7 }), 1_000)).toBeNull();
  });

  it("repairs a missing scroll to {0,0} (defensive, never throws)", () => {
    const { scroll: _omit, ...noScroll } = base;
    const parsed = parseListContext(JSON.stringify(noScroll), 1_000);
    expect(parsed?.scroll).toEqual({ top: 0, left: 0 });
  });

  it("preserves a horizontal-only offset (left set, top 0) — the Validate-column case", () => {
    const parsed = parseListContext(JSON.stringify({ ...base, scroll: { top: 0, left: 2200 } }), 1_000);
    expect(parsed?.scroll).toEqual({ top: 0, left: 2200 });
  });

  it("clamps a bad cursor to 0 rather than carrying an out-of-range index", () => {
    const parsed = parseListContext(JSON.stringify({ ...base, cursor: -4 }), 1_000);
    expect(parsed?.cursor).toBe(0);
  });

  // ── CTL-971: surface + scope robustness ──────────────────────────────────────
  it("CTL-971: an older snapshot with NO surface derives it from kind (ticket→board)", () => {
    const { surface: _drop, ...noSurface } = base;
    const parsed = parseListContext(JSON.stringify(noSurface), 1_000);
    expect(parsed?.surface).toBe("board");
  });

  it("CTL-971: an older WORKER snapshot with no surface derives workers", () => {
    const { surface: _drop, ...noSurface } = base;
    const parsed = parseListContext(
      JSON.stringify({ ...noSurface, kind: "worker" }),
      1_000,
    );
    expect(parsed?.surface).toBe("workers");
  });

  it("CTL-971: a bogus surface value falls back to the kind-derived default", () => {
    const parsed = parseListContext(JSON.stringify({ ...base, surface: "nope" }), 1_000);
    expect(parsed?.surface).toBe("board");
  });

  it("CTL-971: a missing/empty scope falls back to the 'all' sentinel (never a wrong scope)", () => {
    const { scope: _drop, ...noScope } = base;
    expect(parseListContext(JSON.stringify(noScope), 1_000)?.scope).toBe("all");
    expect(parseListContext(JSON.stringify({ ...base, scope: "" }), 1_000)?.scope).toBe("all");
    expect(parseListContext(JSON.stringify({ ...base, scope: 7 }), 1_000)?.scope).toBe("all");
  });

  it("CTL-971: a real repo-key scope is preserved verbatim", () => {
    expect(parseListContext(JSON.stringify({ ...base, scope: "adva" }), 1_000)?.scope).toBe("adva");
  });
});

describe("kanban card wiring (static source, CTL-951)", () => {
  it("ticket + worker cards open the detail page via the shared openDetail seam", () => {
    // The plain-click handler routes through the Board's `onOpen` (which calls
    // `openDetail`) — NOT a drawer select. Both card kinds use it.
    expect(boardSrc).toContain("openDetail");
    expect(boardSrc).toContain('onOpen?.("ticket", t.id');
    expect(boardSrc).toContain('onOpen?.("worker", w.name');
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

  it("the originating card is stamped with data-card-id for the restore focus", () => {
    expect(boardSrc).toContain("data-card-id={t.id}");
    expect(boardSrc).toContain("data-card-id={w.name}");
  });

  it("CTL-971: the onOpen seam captures BOTH scroll axes off the live scroller", () => {
    // The Board reads scrollTop AND scrollLeft (CTL-950 single both-axes scroller)
    // off the resolved `.cat-scroll` element, not the never-scrolling flex wrapper.
    expect(boardSrc).toContain("resolveScrollEl(scrollRef.current)");
    expect(boardSrc).toContain("top: el.scrollTop, left: el.scrollLeft");
  });

  it("CTL-971: the onOpen seam stamps the SURFACE + repo SCOPE into the snapshot", () => {
    // Without the surface the shell reseeds the landing-pref Inbox and the board
    // never mounts; without the scope the restore can't reseat scope authoritatively.
    expect(boardSrc).toContain('surface: view === "workers" ? "workers" : "board"');
    expect(boardSrc).toContain("scope: repo,");
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

describe("Shell Esc-restore wiring (static source, CTL-951 deliverable c)", () => {
  const shellSrc = readFileSync(join(HERE, "Shell.tsx"), "utf8");
  it("Esc / breadcrumb-root returns to the board via a full-document navigation", () => {
    // A router push can't cross from the board.html detail entry back to the
    // index.html shell board — only a full-doc nav does (the restore reads
    // sessionStorage on that load).
    expect(shellSrc).toContain('hardNavigate("/")');
  });

  it("CTL-971: goRoot (the single return target) is wired to BOTH Esc and the breadcrumb", () => {
    // The breadcrumb root button calls onRoot={goRoot}; the layered-Escape handler
    // falls through to goRoot() once no overlay is open. Both reach the same full-
    // doc nav, so all THREE paths (Esc, breadcrumb, browser-back via the assign()
    // history entry) funnel through the shell-mount restore.
    expect(shellSrc).toContain("onRoot={goRoot}");
    expect(shellSrc).toContain("const goRoot = useCallback(() => hardNavigate");
    // The Escape handler ends at goRoot() after exhausting the overlay layers.
    expect(shellSrc).toMatch(/onEscape[\s\S]*goRoot\(\)/);
  });
});

describe("CTL-971: shell reseats SURFACE + SCOPE on return (static source)", () => {
  const appShellSrc = readFileSync(join(HERE, "..", "components", "app-shell.tsx"), "utf8");
  const surfaceRestoreSrc = readFileSync(
    join(HERE, "..", "hooks", "use-surface-restore.ts"),
    "utf8",
  );

  it("AppShell invokes useSurfaceRestore with a surface setter + the scope setter", () => {
    // This is the FIX for the dominant bug: the board surface is NOT in the URL, so a
    // full-doc nav back to `/` reseeds the landing-pref Inbox. The shell-mount restore
    // reseats the captured surface so the board actually mounts (and its own
    // useBoardRestore can apply the scroll).
    expect(appShellSrc).toContain("useSurfaceRestore(restoreSurface, setRepoScope)");
    // Reseating a surface ALSO leaves Settings (mirrors the g-chord behavior).
    expect(appShellSrc).toContain("setSettingsOpen(false)");
  });

  it("useSurfaceRestore PEEKS the snapshot (does not clear it — the board consumes it)", () => {
    // It must NOT clear: the board-local useBoardRestore clears the snapshot after
    // applying scroll + focus, so it must still be present when the board mounts.
    expect(surfaceRestoreSrc).toContain("readListContext()");
    expect(surfaceRestoreSrc).not.toContain("clearListContext");
  });
});
