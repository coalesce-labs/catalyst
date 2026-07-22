// footer-counts.test.ts — units for the CTL-1032 live-status strip count
// derivation. The strip's four categories (active · dead · free · waiting) come
// from the SAME CTL-1015 utilities the control tower uses (assignSlots /
// deadWorkers / groupHoldingBuckets), via deriveFooterCounts. Pure logic, no DOM
// — run from the ui package:  cd ui && bun test src/components/footer-counts.test.ts
import { describe, it, expect } from "bun:test";
import type { BoardWorker, BoardTicket } from "../board/types";
import { deriveFooterCounts } from "./footer-counts";

function w(p: Partial<BoardWorker> & { name: string; ticket: string }): BoardWorker {
  return {
    tickets: [p.ticket],
    phase: "implement",
    status: "running",
    activeState: "active",
    working: true,
    lastActiveMs: 100,
    repo: "catalyst",
    team: "CTL",
    runtimeMs: 1000,
    costUSD: null,
    ...p,
  };
}

function t(p: Partial<BoardTicket> & { id: string }): BoardTicket {
  return {
    title: p.id,
    type: "feature",
    repo: "catalyst",
    team: "CTL",
    phase: "triage",
    status: "queued",
    model: null,
    linearState: "Todo",
    workerStatus: null,
    activeState: null,
    working: false,
    lastActiveMs: null,
    priority: 0,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "2026-06-11T00:00:00Z",
    held: null,
    blockers: [],
    heldSince: null,
    currentPhaseSince: null,
    host: null,
    generation: null,
    ...p,
  };
}

describe("deriveFooterCounts", () => {
  it("excludes dead/stale workers from the active count (the CTL-1032 contract)", () => {
    // 4 live workers + 1 dead, maxParallel 6 → active 4 (NOT 5), dead 1, free 2.
    const workers = [
      w({ name: "a", ticket: "CTL-1", activeState: "active" }),
      w({ name: "b", ticket: "CTL-2", activeState: "active" }),
      w({ name: "c", ticket: "CTL-3", activeState: "active" }),
      w({ name: "d", ticket: "CTL-4", activeState: "active" }),
      w({ name: "e", ticket: "CTL-5", activeState: "dead", working: false }),
    ];
    const counts = deriveFooterCounts(workers, [], 6);
    expect(counts.active).toBe(4);
    expect(counts.dead).toBe(1);
    expect(counts.free).toBe(2);
    expect(counts.queued).toBe(0);
  });

  it("derives all four categories from a mixed fleet", () => {
    // 2 live (slots) + 2 dead + maxParallel 4 → active 2, dead 2, free 2.
    // Tickets: 1 admission-gate-waiting (not in flight), 1 blocked (ignored here),
    // 1 in flight (held=waiting but a live worker owns it → not counted).
    const workers = [
      w({ name: "a", ticket: "CTL-1", activeState: "active" }),
      w({ name: "b", ticket: "CTL-2", activeState: "active" }),
      w({ name: "x", ticket: "CTL-90", activeState: "dead", working: false }),
      w({ name: "y", ticket: "CTL-91", activeState: "dead", working: false }),
    ];
    const tickets = [
      t({ id: "CTL-10", held: "waiting" }),
      t({ id: "CTL-11", held: "blocked" }),
      // CTL-2 is in flight (live worker b) — its waiting label must NOT count.
      t({ id: "CTL-2", held: "waiting" }),
    ];
    const counts = deriveFooterCounts(workers, tickets, 4);
    expect(counts.active).toBe(2);
    expect(counts.dead).toBe(2);
    expect(counts.free).toBe(2);
    expect(counts.queued).toBe(1);
  });

  it("a fully-dead fleet reports zero active and zero free occupied by live work", () => {
    const workers = [
      w({ name: "x", ticket: "CTL-90", activeState: "dead", working: false }),
      w({ name: "y", ticket: "CTL-91", activeState: "dead", working: false }),
    ];
    const counts = deriveFooterCounts(workers, [], 4);
    // Dead workers hold NO slots → all 4 slots are free, active 0, dead 2.
    expect(counts.active).toBe(0);
    expect(counts.dead).toBe(2);
    expect(counts.free).toBe(4);
    expect(counts.queued).toBe(0);
  });

  it("over-capacity live workers are not counted as active beyond the deck", () => {
    // 3 live workers, maxParallel 2 → 2 occupy slots, 1 over capacity. active=2.
    const workers = [
      w({ name: "a", ticket: "CTL-1", activeState: "active", startedAt: 1 }),
      w({ name: "b", ticket: "CTL-2", activeState: "active", startedAt: 2 }),
      w({ name: "c", ticket: "CTL-3", activeState: "active", startedAt: 3 }),
    ];
    const counts = deriveFooterCounts(workers, [], 2);
    expect(counts.active).toBe(2);
    expect(counts.dead).toBe(0);
    expect(counts.free).toBe(0);
  });

  // CTL-764 Phase 8: footer's fourth category renamed waiting→queued
  it("CTL-764: fourth category is now 'queued', not 'waiting'", () => {
    const tickets = [t({ id: "CTL-10", held: "queued" })];
    const counts = deriveFooterCounts([], tickets, 4);
    expect((counts as any).queued).toBe(1);
    expect((counts as any).waiting).toBeUndefined();
  });

  it("CTL-764: legacy held='waiting' still increments queued (back-compat)", () => {
    const tickets = [t({ id: "CTL-10", held: "waiting" })];
    const counts = deriveFooterCounts([], tickets, 4);
    expect((counts as any).queued).toBe(1);
  });

  it("CTL-764: in-flight queued ticket (live worker owns it) is not counted", () => {
    const workers = [w({ name: "w1", ticket: "CTL-1", startedAt: 1 })];
    const tickets = [t({ id: "CTL-1", held: "queued" })];
    const counts = deriveFooterCounts(workers, tickets, 4);
    expect((counts as any).queued).toBe(0);
  });

  it("the evidence case: footer said 6 active while 4 work + 2 dead", () => {
    // CTL-1032 evidence — live footer claimed "6 active"; control tower had
    // 4 working + 2 dead. The honest readout is 4 active · 2 dead.
    const workers = [
      w({ name: "a", ticket: "CTL-1", activeState: "active" }),
      w({ name: "b", ticket: "CTL-2", activeState: "active" }),
      w({ name: "c", ticket: "CTL-3", activeState: "active" }),
      w({ name: "d", ticket: "CTL-4", activeState: "active" }),
      w({ name: "e", ticket: "CTL-5", activeState: "dead", working: false }),
      w({ name: "f", ticket: "CTL-6", activeState: "dead", working: false }),
    ];
    const counts = deriveFooterCounts(workers, [], 6);
    expect(counts.active).toBe(4);
    expect(counts.dead).toBe(2);
    expect(counts.free).toBe(2);
  });
});
