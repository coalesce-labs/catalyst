// ticket-page-model.test.ts — units for the ticket detail PAGE derivations
// (CTL-913 / DETAIL2). Each `describe` block maps to a Gherkin scenario in the
// DETAIL2 ticket spec; the page renders RESIDENT board data alone (BoardTicket +
// phaseSummary), so these pure functions ARE the page's acceptance surface.
//
// Pure module — no DOM, no jotai, no router (mirrors detail-chrome / list-order
// test style). Run from the ui package:
//   cd ui && bun test src/board/ticket-page-model.test.ts
import { describe, it, expect } from "bun:test";
import {
  PIPELINE_PHASES,
  resolvePipelineRail,
  resolveHeldBanner,
  resolveSpineNodes,
  linearDeepLink,
  orchChannelFor,
  activityPredicateForTicket,
  phaseLabel,
  HELD_DURATION_MARKER,
} from "./ticket-page-model";
import type { BoardPhaseTiming, BoardTicket } from "./types";

// ── fixtures ────────────────────────────────────────────────────────────────
function phaseTiming(over: Partial<BoardPhaseTiming> & { phase: string }): BoardPhaseTiming {
  return {
    phase: over.phase,
    status: over.status ?? "done",
    durationMs: over.durationMs ?? 42_000,
    startedAt: over.startedAt ?? "2026-06-08T10:00:00.000Z",
    completedAt: over.completedAt ?? "2026-06-08T10:00:42.000Z",
    model: over.model ?? null,
  };
}

function ticket(over: Partial<BoardTicket>): BoardTicket {
  return {
    id: "CTL-845",
    title: "reclaim false-dead premature advance",
    type: "feature",
    repo: "plugins/dev",
    team: "CTL",
    phase: "implement",
    status: "in_progress",
    model: "opus-4-8[1m]",
    linearState: "Implement",
    workerStatus: null,
    activeState: "active",
    working: true,
    lastActiveMs: 1000,
    priority: 2,
    estimate: 3,
    scope: "M",
    project: null,
    costUSD: 1.14,
    tokens: 2_500_000,
    turns: 9,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "2026-06-08T10:05:00.000Z",
    held: null,
    blockers: [],
    ...over,
  };
}

// ── Scenario: Header and PIPELINE rail render from BoardTicket ────────────────
describe("Scenario: Header and PIPELINE rail render from BoardTicket", () => {
  it("header Linear deep-link is built from the ticket id (never a dead arrow)", () => {
    expect(linearDeepLink("CTL-845")).toBe("https://linear.app/issue/CTL-845");
  });

  it("a blank id yields no deep-link (skin renders id as plain text, not a dead ↗)", () => {
    expect(linearDeepLink("")).toBeNull();
    expect(linearDeepLink("   ")).toBeNull();
  });

  it("colors past phases solid, the current phase cyan, future phases as dotted ghosts", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [
        phaseTiming({ phase: "triage", status: "done" }),
        phaseTiming({ phase: "research", status: "done" }),
        phaseTiming({ phase: "plan", status: "done" }),
        phaseTiming({ phase: "implement", status: "in_progress", completedAt: null }),
      ],
    });
    const rail = resolvePipelineRail(t);

    // one segment per canonical phase, in canonical order
    expect(rail.map((s) => s.phase)).toEqual([...PIPELINE_PHASES]);

    const placement = Object.fromEntries(rail.map((s) => [s.phase, s.placement]));
    // past = solid
    expect(placement.triage).toBe("past");
    expect(placement.research).toBe("past");
    expect(placement.plan).toBe("past");
    // current = cyan
    expect(placement.implement).toBe("current");
    // future = dotted ghost
    expect(placement.verify).toBe("future");
    expect(placement.review).toBe("future");
    expect(placement.teardown).toBe("future");
  });

  it("surfaces the real per-phase status from phaseSummary (never fabricated)", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [
        phaseTiming({ phase: "triage", status: "done" }),
        phaseTiming({ phase: "implement", status: "in_progress", completedAt: null }),
      ],
    });
    const rail = resolvePipelineRail(t);
    const byPhase = Object.fromEntries(rail.map((s) => [s.phase, s.status]));
    expect(byPhase.triage).toBe("done");
    expect(byPhase.implement).toBe("in_progress");
    // a future phase that never ran has no fabricated status
    expect(byPhase.verify).toBeNull();
  });

  it("exactly one segment is current (the cyan 'here now' is unambiguous)", () => {
    const rail = resolvePipelineRail(ticket({ phase: "pr", phaseSummary: [] }));
    expect(rail.filter((s) => s.placement === "current")).toHaveLength(1);
    expect(rail.find((s) => s.placement === "current")?.phase).toBe("pr");
  });

  it("an off-rail current phase (e.g. 'done') reads the whole lifecycle as walked, no cyan", () => {
    const rail = resolvePipelineRail(ticket({ phase: "done", phaseSummary: [] }));
    expect(rail.every((s) => s.placement === "past")).toBe(true);
    expect(rail.some((s) => s.placement === "current")).toBe(false);
  });
});

// ── Scenario: HELD banner renders only when held ──────────────────────────────
describe("Scenario: HELD banner renders only when held", () => {
  it('a "blocked" hold renders a red-bordered banner naming the blockers', () => {
    const banner = resolveHeldBanner(
      ticket({ held: "blocked", blockers: ["CTL-778", "CTL-844"] }),
    );
    expect(banner).not.toBeNull();
    expect(banner?.tone).toBe("blocked"); // skin → red border
    expect(banner?.blockers).toEqual(["CTL-778", "CTL-844"]);
  });

  it('a "waiting" hold renders a yellow-bordered banner (no blockers)', () => {
    const banner = resolveHeldBanner(ticket({ held: "waiting", blockers: ["ignored"] }));
    expect(banner).not.toBeNull();
    expect(banner?.tone).toBe("waiting"); // skin → yellow border
    // a waiting hold lost the selection tick; deps are satisfied → no blockers named
    expect(banner?.blockers).toEqual([]);
  });

  it("held-duration is NEEDS-PLUMBING (heldFor carries no timestamp) — never fabricated", () => {
    const banner = resolveHeldBanner(ticket({ held: "blocked", blockers: ["CTL-778"] }));
    expect(banner?.durationMarker).toBe(HELD_DURATION_MARKER);
    expect(banner?.durationMarker).toBe("NEEDS-PLUMBING");
  });

  it("when held is null the banner does not render at all", () => {
    expect(resolveHeldBanner(ticket({ held: null }))).toBeNull();
    expect(resolveHeldBanner(ticket({ held: undefined }))).toBeNull();
  });

  it("a blocked hold with no blockers named yields an empty list (no fabricated id)", () => {
    const banner = resolveHeldBanner(ticket({ held: "blocked", blockers: [] }));
    expect(banner?.tone).toBe("blocked");
    expect(banner?.blockers).toEqual([]);
  });
});

// ── Scenario: LIFECYCLE SPINE renders one node per phase ──────────────────────
describe("Scenario: LIFECYCLE SPINE renders one node per phase with a compact gantt toggle", () => {
  it("each spine node shows phase, status, duration, startedAt/completedAt", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [
        phaseTiming({ phase: "triage", status: "done", durationMs: 42_000 }),
        phaseTiming({ phase: "research", status: "done", durationMs: 198_000 }),
        phaseTiming({ phase: "plan", status: "done", durationMs: 125_000 }),
        phaseTiming({
          phase: "implement",
          status: "in_progress",
          durationMs: null,
          completedAt: null,
        }),
      ],
    });
    const nodes = resolveSpineNodes(t);
    expect(nodes.map((n) => n.phase)).toEqual(["triage", "research", "plan", "implement"]);

    const triage = nodes[0];
    expect(triage.status).toBe("done");
    expect(triage.durationMs).toBe(42_000);
    expect(triage.startedAt).toBe("2026-06-08T10:00:00.000Z");
    expect(triage.completedAt).toBe("2026-06-08T10:00:42.000Z");
  });

  it("the active (current, non-terminal) phase node is flagged isActive; others are not", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [
        phaseTiming({ phase: "triage", status: "done" }),
        phaseTiming({ phase: "implement", status: "in_progress", completedAt: null }),
      ],
    });
    const nodes = resolveSpineNodes(t);
    expect(nodes.find((n) => n.phase === "triage")?.isActive).toBe(false);
    expect(nodes.find((n) => n.phase === "implement")?.isActive).toBe(true);
    // exactly one active node
    expect(nodes.filter((n) => n.isActive)).toHaveLength(1);
  });

  it("a terminal current phase is NOT active (no cyan ring on a finished lifecycle)", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [phaseTiming({ phase: "implement", status: "done" })],
    });
    const nodes = resolveSpineNodes(t);
    expect(nodes[0].isActive).toBe(false);
  });

  it("per-phase model is surfaced when plumbed (BFF6 BoardPhaseTiming.model)", () => {
    const t = ticket({
      phase: "plan",
      phaseSummary: [
        phaseTiming({ phase: "research", status: "done", model: "sonnet" }),
        phaseTiming({ phase: "plan", status: "in_progress", model: "opus", completedAt: null }),
      ],
    });
    const nodes = resolveSpineNodes(t);
    expect(nodes.find((n) => n.phase === "research")?.model).toBe("sonnet");
    expect(nodes.find((n) => n.phase === "plan")?.model).toBe("opus");
  });

  it("run-link / artifact / cost-sparkline render PENDING (dimmed, never empty/fabricated)", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [phaseTiming({ phase: "triage", status: "done" })],
    });
    const [node] = resolveSpineNodes(t);
    // these three depend on the BFF run-records endpoint (DETAIL6/DETAIL7)
    expect(node.runLink).toBe("pending");
    expect(node.artifact).toBe("pending");
    expect(node.costSparkline).toBe("pending");
  });

  it("an empty phaseSummary yields no nodes (skin shows an honest empty state)", () => {
    expect(resolveSpineNodes(ticket({ phaseSummary: [] }))).toEqual([]);
  });
});

// ── Scenario: COMMS and ACTIVITY reuse existing components ─────────────────────
describe("Scenario: COMMS and ACTIVITY reuse existing components", () => {
  it('COMMS reuses CommsView for channel "orch-<id>"', () => {
    expect(orchChannelFor("CTL-845")).toBe("orch-CTL-845");
  });

  it("ACTIVITY predicate scopes the stream to this ticket (worker.ticket / linear.issue)", () => {
    const pred = activityPredicateForTicket("CTL-845");
    expect(pred).toContain("catalyst.worker.ticket");
    expect(pred).toContain("linear.issue.identifier");
    expect(pred).toContain("CTL-845");
  });

  it("a blank ticket id yields the unfiltered all-events sentinel (not match-nothing)", () => {
    expect(activityPredicateForTicket("")).toBe("");
    expect(activityPredicateForTicket("   ")).toBe("");
  });

  it("the predicate escapes quotes/backslashes so a crafted id can't break the jq filter", () => {
    const pred = activityPredicateForTicket('a"b\\c');
    expect(pred).toContain('a\\"b\\\\c');
  });
});

// ── phaseLabel helper ─────────────────────────────────────────────────────────
describe("phaseLabel", () => {
  it("maps canonical phases to Board column labels and passes through unknowns", () => {
    expect(phaseLabel("monitor-merge")).toBe("Merge");
    expect(phaseLabel("monitor-deploy")).toBe("Deploy");
    expect(phaseLabel("triage")).toBe("Triage");
    expect(phaseLabel("some-future-phase")).toBe("some-future-phase");
  });
});
