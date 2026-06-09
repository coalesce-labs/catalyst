// board-surface.test.ts — CTL-905 / BOARD1 acceptance guards.
//
// Encodes the three BOARD1 Gherkin scenarios. `bun test` has no DOM, so —
// matching the board-todo-column.test.ts + app-shell.test.ts pattern — the
// structural scenarios are asserted by static source analysis (read the .tsx as
// text and assert the load-bearing wiring), and the data-driven column membership
// (the "no drag, filter by linearState|phase" mechanism) is unit-tested directly
// against the shared resolveList comparator (FND2 / CTL-882).
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveList } from "../ui/src/board/list-order";
import type { BoardPayload, BoardTicket } from "../ui/src/board/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");

const boardSrc = read("board/Board.tsx");
const appSrc = read("App.tsx");

/**
 * Strip JS/JSX comments so CLASSNAME / token assertions can't be tripped by prose
 * in a comment that merely mentions a token (e.g. a `// max-w-…` note).
 */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // {/* jsx comment */}
    .replace(/\/\*[\s\S]*?\*\//g, "") // /* block */
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // // line (skip http://)
}

const boardCode = stripComments(boardSrc);
const appCode = stripComments(appSrc);

// ── Scenario: Board surface renders real tickets in the new shell ─────────────
describe("Board surface renders the real dense board in the shell (CTL-905)", () => {
  it("Board.tsx exports an EmbeddedBoard surface (the in-shell mount) AND keeps the standalone Board", () => {
    // The standalone board.html mount (FND1 router `/`) stays exported and
    // behavior-preserving; the new embedded surface is a sibling export.
    expect(boardSrc).toMatch(/export function EmbeddedBoard\b/);
    expect(boardSrc).toMatch(/export function Board\b/);
    // Both compose the SAME extracted BoardSurface — one dense surface, two hosts.
    expect(boardSrc).toMatch(/function BoardSurface\b/);
    expect(boardCode).toMatch(/<BoardSurface\s*\/>/); // standalone: no chrome flag
    expect(boardCode).toMatch(/<BoardSurface\s+embedded\b/); // embedded: chrome off
  });

  it("App.tsx mounts the EmbeddedBoard when the shell surface is `board`", () => {
    expect(appSrc).toContain("EmbeddedBoard");
    expect(appSrc).toContain("useSurface");
    // The inset gate switches on the board surface specifically.
    expect(appCode).toMatch(/surface\s*===\s*"board"/);
    // Lazy import of the real board module (so the SSE transport only boots on Board).
    expect(appCode).toMatch(/import\(["']\.\/board\/Board["']\)/);
  });

  it("renders the dense Linear-anatomy card parts (priority icon, type chip, phase pill, held, status, scope/estimate, phase strip, cost/turns or PR)", () => {
    // The hand-rolled dense card (per the board doc — NOT a prebuilt kanban block).
    for (const part of [
      "PriorityIcon",
      "PhasePill",
      "HeldBadge",
      "StatusBadge",
      "ScopeChip",
      "PhaseStrip",
      "Cost",
      "function TicketCard",
    ]) {
      expect(boardSrc).toContain(part);
    }
    // cost/turns or PR row.
    expect(boardSrc).toMatch(/t\.turns/);
    expect(boardSrc).toMatch(/t\.pr\b/);
  });

  it("the board is the existing CTL-733 live SSE surface (connectBoard over the board transport), not a per-request Linear pass-through", () => {
    expect(boardSrc).toContain("connectBoard");
    expect(boardSrc).toContain("requestReconcile");
  });

  it("keeps the board hand-rolled + data-driven — NO drag-and-drop kanban (no @dnd-kit, no draggable/onDragEnd, no useSortable)", () => {
    expect(boardCode).not.toContain("@dnd-kit");
    expect(boardCode).not.toContain("useSortable");
    expect(boardCode).not.toContain("onDragEnd");
    expect(boardCode).not.toMatch(/\bdraggable\b/);
  });

  it("column membership is derived from the shared resolveList comparator (FND2), never re-implemented inline or by drag", () => {
    // The board renders columns THROUGH resolveList so the on-screen order is the
    // same list the detail pager / j/k walk derive.
    expect(boardSrc).toContain("resolveList");
    // The ticket-column filter is a pure linearState|phase filter, no re-sort.
    const cards: BoardTicket[] = [
      mkTicket({ id: "CTL-1", linearState: "Implement", phase: "implement" }),
      mkTicket({ id: "CTL-2", linearState: "PR", phase: "pr" }),
      mkTicket({ id: "CTL-3", linearState: "Implement", phase: "verify" }),
    ];
    const payload = mkPayload(cards);
    // Linear-state lens → membership by linearState.
    expect(
      resolveList(payload, { kind: "ticket", lens: "linear", col: "Implement" }).map((t) => t.id),
    ).toEqual(["CTL-1", "CTL-3"]);
    // Pipeline lens → membership by phase (the SAME cards, a different lens).
    expect(
      resolveList(payload, { kind: "ticket", lens: "phase", col: "implement" }).map((t) => t.id),
    ).toEqual(["CTL-1"]);
    // No re-sort: payload array order is preserved within a column.
    expect(
      resolveList(payload, { kind: "ticket", lens: "linear", col: "Implement" }).map((t) => t.id),
    ).toEqual(["CTL-1", "CTL-3"]);
  });
});

// ── Scenario: Live worker on a ticket is visibly distinguished ────────────────
describe("live + stuck cards are visibly distinguished, cyan reserved for live (CTL-905)", () => {
  it("reserves cyan #5be0ff for the live signal only", () => {
    // The reserved live color is defined once and tagged as reserved.
    expect(boardSrc).toContain("#5be0ff");
    expect(boardSrc).toMatch(/const LIVE = "#5be0ff"/);
  });

  it("ships the live-ring + pulsing live-dot keyframes and applies the ring to a live card", () => {
    expect(boardSrc).toContain("catalystLiveRing");
    expect(boardSrc).toContain("catalystLivePing");
    expect(boardSrc).toContain("catalyst-live-dot");
    // A live ticket gets the breathing ring class.
    expect(boardCode).toMatch(/live \? "catalyst-live"/);
  });

  it("a stuck worker gets the red stuck treatment instead of the live ring", () => {
    // accentFor: stuck (or failed) → red, not the reserved cyan.
    expect(boardCode).toMatch(/activeState === "stuck".*C\.red/);
    // The stuck card uses the red border treatment.
    expect(boardCode).toContain("rgba(239,93,93,0.5)");
  });
});

// ── Scenario: Board fills the window edge-to-edge (dense mode) ────────────────
describe("the embedded board fills the inset edge-to-edge, lanes flow horizontally (CTL-905)", () => {
  it("the embedded surface flex-fills its parent (height:100%), it does NOT re-impose a 100vh viewport box", () => {
    // BoardSurface picks the fill height by host: 100% embedded, viewport-minus-
    // chrome standalone — so the dense board fills the SidebarInset with no
    // double scrollbar and no centered gutter.
    expect(boardCode).toMatch(/embedded \? "100%" : "calc\(100vh - 104px\)"/);
    expect(boardCode).toMatch(/height: embedded \? "100%" : "100vh"/);
  });

  it("lanes flow horizontally (BoardScroll uses overflowX:auto, fixed-width columns)", () => {
    expect(boardCode).toMatch(/overflowX: "auto"/);
    // Columns are fixed-width so the board scrolls horizontally edge-to-edge.
    expect(boardCode).toMatch(/flex: "0 0 300px"/);
  });

  it("App.tsx imposes no centered max-w / mx-auto gutter on the inset (dense edge-to-edge)", () => {
    expect(appCode).not.toMatch(/\bmx-auto\b/);
    expect(appCode).not.toMatch(
      /\bmax-w-(sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|screen)\b/,
    );
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────
function mkTicket(over: Partial<BoardTicket> & Pick<BoardTicket, "id">): BoardTicket {
  return {
    title: "t",
    type: "feature",
    repo: "catalyst",
    team: "CTL",
    phase: "implement",
    status: "running",
    model: null,
    linearState: "Implement",
    workerStatus: null,
    activeState: null,
    working: false,
    lastActiveMs: null,
    priority: 2,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "2026-06-08T00:00:00Z",
    held: null,
    ...over,
  };
}

function mkPayload(tickets: BoardTicket[]): BoardPayload {
  return {
    generatedAt: "",
    config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
    repos: [],
    workers: [],
    tickets,
    queue: [],
  };
}
