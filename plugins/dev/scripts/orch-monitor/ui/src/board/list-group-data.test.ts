// list-group-data.test.ts — units for the CTL-955 default-grouping engine.
// Pure logic, no DOM — run from the ui package:
//   cd ui && bun test src/board/list-group-data.test.ts
//
// Covers:
//   • groupTicketsByStage: ticket→stage pipeline ordering + live flag + empty-group omission
//   • groupWorkersByActivity: worker→activityGroup ordering + live flag
//   • collapse semantics verified via the group key → items mapping (the table
//     model collapses by filtering on this; tested via the returned group structure)
import { describe, it, expect } from "bun:test";
import type { BoardTicket, BoardWorker } from "./types";
import type { ListRow } from "./list-data";
import {
  groupTicketsByStage,
  groupWorkersByActivity,
  stageGroupHeader,
  activityGroupHeader,
} from "./list-group-data";
import { flattenTicketRows, flattenWorkerRows } from "./list-data";

// ── fixtures ─────────────────────────────────────────────────────────────────
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

// ── ticket default grouping ───────────────────────────────────────────────────
describe("list-group-data — groupTicketsByStage (ticket default grouping)", () => {
  const tickets: BoardTicket[] = [
    t({ id: "CTL-1", linearState: "PR", phase: "pr" }),
    t({ id: "CTL-2", linearState: "Implement", phase: "implement" }),
    t({ id: "CTL-3", linearState: "Research", phase: "research" }),
    t({ id: "CTL-4", linearState: "Implement", phase: "implement" }),
    t({ id: "CTL-5", linearState: "Todo", phase: "triage" }),
  ];

  it("linear lens: groups appear in LINEAR_COLUMNS pipeline order (Todo first, Done last)", () => {
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    const groups = groupTicketsByStage(rows, "linear");
    const labels = groups.map((g) => g.label);
    // All labels must be sorted by their LINEAR_COLUMNS index (Todo=0, Research=2, Implement=4, PR=6)
    expect(labels).toContain("Todo");
    expect(labels).toContain("Research");
    expect(labels).toContain("Implement");
    expect(labels).toContain("PR");
    // Pipeline order: Todo(0) < Research(2) < Implement(4) < PR(6)
    expect(groups.find((g) => g.label === "Todo")!.order).toBeLessThan(
      groups.find((g) => g.label === "Research")!.order,
    );
    expect(groups.find((g) => g.label === "Research")!.order).toBeLessThan(
      groups.find((g) => g.label === "Implement")!.order,
    );
    expect(groups.find((g) => g.label === "Implement")!.order).toBeLessThan(
      groups.find((g) => g.label === "PR")!.order,
    );
  });

  it("empty stages are omitted — only stages with actual rows are returned", () => {
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    const groups = groupTicketsByStage(rows, "linear");
    // All 8 LINEAR_COLUMNS but only 4 have tickets → 4 groups
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => g.key)).not.toContain("Triage");
    expect(groups.map((g) => g.key)).not.toContain("Done");
  });

  it("each group contains the correct tickets", () => {
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    const groups = groupTicketsByStage(rows, "linear");
    const impl = groups.find((g) => g.key === "Implement")!;
    expect(impl.items.map((r) => r.entity.id).sort()).toEqual(["CTL-2", "CTL-4"]);
    const pr = groups.find((g) => g.key === "PR")!;
    expect(pr.items.map((r) => r.entity.id)).toEqual(["CTL-1"]);
  });

  it("live flag: group with an active ticket is 'live'; no active tickets → null", () => {
    const tickets2: BoardTicket[] = [
      t({ id: "CTL-10", linearState: "Implement", activeState: "active" }),
      t({ id: "CTL-11", linearState: "Implement", activeState: null }),
      t({ id: "CTL-12", linearState: "Research", activeState: null }),
    ];
    const rows = flattenTicketRows(tickets2, { lens: "linear" });
    const groups = groupTicketsByStage(rows, "linear");
    expect(groups.find((g) => g.key === "Implement")!.live).toBe("live");
    expect(groups.find((g) => g.key === "Research")!.live).toBeNull();
  });

  it("phase lens: groups appear in PHASE_COLUMNS order (triage < research < implement …)", () => {
    const tickets3: BoardTicket[] = [
      t({ id: "CTL-1", linearState: "Implement", phase: "implement" }),
      t({ id: "CTL-2", linearState: "Research", phase: "research" }),
      t({ id: "CTL-3", linearState: "Todo", phase: "triage" }),
    ];
    const rows = flattenTicketRows(tickets3, { lens: "phase" });
    const groups = groupTicketsByStage(rows, "phase");
    const labels = groups.map((g) => g.key);
    // triage(0) < research(1) < implement(3)
    expect(labels.indexOf("triage")).toBeLessThan(labels.indexOf("research"));
    expect(labels.indexOf("research")).toBeLessThan(labels.indexOf("implement"));
  });

  it("stageGroupHeader extracts the expected shape (key/label/count/color/live)", () => {
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    const groups = groupTicketsByStage(rows, "linear");
    const impl = groups.find((g) => g.key === "Implement")!;
    const hdr = stageGroupHeader(impl);
    expect(hdr.key).toBe("Implement");
    expect(hdr.label).toBe("Implement");
    expect(hdr.count).toBe(2);
    expect(typeof hdr.color).toBe("string");
    expect(hdr.live).toBeNull();
  });

  it("does not mutate the input rows array", () => {
    const rows = flattenTicketRows(tickets, { lens: "linear" });
    const snap = rows.map((r) => r.entity.id);
    groupTicketsByStage(rows, "linear");
    expect(rows.map((r) => r.entity.id)).toEqual(snap);
  });
});

// ── worker default grouping ───────────────────────────────────────────────────
describe("list-group-data — groupWorkersByActivity (worker default grouping)", () => {
  const workers: BoardWorker[] = [
    w({ name: "CTL-10:1", ticket: "CTL-10", activeState: null }),       // waiting
    w({ name: "CTL-11:1", ticket: "CTL-11", activeState: "active" }),   // active
    w({ name: "CTL-12:1", ticket: "CTL-12", activeState: "stuck" }),    // stuck
    w({ name: "CTL-13:1", ticket: "CTL-13", activeState: "active" }),   // active
  ];

  it("groups appear in activity rank order: active(0) before waiting(2) before stuck(3)", () => {
    const rows = flattenWorkerRows(workers);
    const groups = groupWorkersByActivity(rows);
    const labels = groups.map((g) => g.key);
    expect(labels.indexOf("active")).toBeLessThan(labels.indexOf("waiting"));
    expect(labels.indexOf("waiting")).toBeLessThan(labels.indexOf("stuck"));
  });

  it("each group contains the correct workers", () => {
    const rows = flattenWorkerRows(workers);
    const groups = groupWorkersByActivity(rows);
    const activeGrp = groups.find((g) => g.key === "active")!;
    expect(activeGrp.items.map((r) => r.entity.name).sort()).toEqual(["CTL-11:1", "CTL-13:1"]);
    const waiting = groups.find((g) => g.key === "waiting")!;
    expect(waiting.items.map((r) => r.entity.name)).toEqual(["CTL-10:1"]);
  });

  it("live flag: active group has live='live'; waiting/stuck have null", () => {
    const rows = flattenWorkerRows(workers);
    const groups = groupWorkersByActivity(rows);
    expect(groups.find((g) => g.key === "active")!.live).toBe("live");
    expect(groups.find((g) => g.key === "waiting")!.live).toBeNull();
    expect(groups.find((g) => g.key === "stuck")!.live).toBeNull();
  });

  it("empty activity groups are omitted", () => {
    const rows = flattenWorkerRows(workers);
    const groups = groupWorkersByActivity(rows);
    // Only 3 distinct groups from the fixture (active/waiting/stuck)
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.key)).not.toContain("waiting-on-user");
    expect(groups.map((g) => g.key)).not.toContain("blocked");
  });

  it("activityGroupHeader extracts the expected shape (color=null)", () => {
    const rows = flattenWorkerRows(workers);
    const groups = groupWorkersByActivity(rows);
    const active = groups.find((g) => g.key === "active")!;
    const hdr = activityGroupHeader(active);
    expect(hdr.key).toBe("active");
    expect(hdr.label).toBe("Active");
    expect(hdr.count).toBe(2);
    expect(hdr.color).toBeNull();
    expect(hdr.live).toBe("live");
  });

  it("collapse semantics: filtering group items out produces zero rows for that group", () => {
    const rows = flattenWorkerRows(workers);
    const groups = groupWorkersByActivity(rows);
    // Simulate collapsing "active" group by finding its items
    const collapsedKey = "active";
    const visibleRows = rows.filter(
      (r) => groups.find((g) => g.key === collapsedKey)?.items.includes(r) !== true,
    );
    expect(visibleRows.map((r) => r.entity.name).sort()).toEqual(["CTL-10:1", "CTL-12:1"]);
  });
});
