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
  resolveShippedStatus,
  resolveTimelineRows,
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

  it("run-link / artifact / cost-sparkline render PENDING when no phaseCosts (dimmed, never fabricated)", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [phaseTiming({ phase: "triage", status: "done" })],
      phaseCosts: null,
    });
    const [node] = resolveSpineNodes(t);
    // run-link and artifact always pending (BFF run-records not yet wired)
    expect(node.runLink).toBe("pending");
    expect(node.artifact).toBe("pending");
    // costSparkline pending when no phaseCosts (honest dim)
    expect(node.costSparkline).toBe("pending");
    expect(node.costUSD).toBeNull();
    expect(node.tokens).toBeNull();
  });

  // ── CTL-953: per-phase cost/tokens from phaseCosts ──────────────────────────
  it("CTL-953: costUSD and tokens are resolved from phaseCosts when present (never fabricated)", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [
        phaseTiming({ phase: "research", status: "done" }),
        phaseTiming({ phase: "plan", status: "done" }),
        phaseTiming({ phase: "implement", status: "in_progress", completedAt: null }),
      ],
      phaseCosts: {
        research: { costUSD: 0.21, tokens: 400_000, turns: 3 },
        plan: { costUSD: 0.38, tokens: 750_000, turns: 2 },
        // implement has no phaseCost yet (still running)
      },
    });
    const nodes = resolveSpineNodes(t);
    const byPhase = Object.fromEntries(nodes.map((n) => [n.phase, n]));

    // research — plumbed from phaseCosts
    expect(byPhase.research.costUSD).toBe(0.21);
    expect(byPhase.research.tokens).toBe(400_000);
    expect(byPhase.research.costSparkline).toBe("plumbed");

    // plan — plumbed from phaseCosts
    expect(byPhase.plan.costUSD).toBe(0.38);
    expect(byPhase.plan.tokens).toBe(750_000);
    expect(byPhase.plan.costSparkline).toBe("plumbed");

    // implement — no entry yet (still running) → dim placeholder
    expect(byPhase.implement.costUSD).toBeNull();
    expect(byPhase.implement.tokens).toBeNull();
    expect(byPhase.implement.costSparkline).toBe("pending");
  });

  it("CTL-953: a phase with costUSD=0 is treated as absent (zero is not a fabricated value, but we dim it honestly)", () => {
    const t = ticket({
      phaseSummary: [phaseTiming({ phase: "triage", status: "done" })],
      phaseCosts: { triage: { costUSD: 0, tokens: 0, turns: 1 } },
    });
    const [node] = resolveSpineNodes(t);
    // zero cost = no real cost data (free phase or instrumentation gap) — dim pending
    expect(node.costUSD).toBeNull();
    expect(node.tokens).toBeNull();
    expect(node.costSparkline).toBe("pending");
  });

  it("CTL-953: tokens can be absent even when costUSD is present (null, never fabricated)", () => {
    const t = ticket({
      phaseSummary: [phaseTiming({ phase: "research", status: "done" })],
      phaseCosts: { research: { costUSD: 0.15, tokens: 0, turns: 2 } },
    });
    const [node] = resolveSpineNodes(t);
    // costUSD present, tokens=0 → tokens null (dim), cost plumbed
    expect(node.costUSD).toBe(0.15);
    expect(node.tokens).toBeNull();
    expect(node.costSparkline).toBe("plumbed");
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

// ── Scenario: resolveShippedStatus — the PM "is it shipped?" answer ───────────
describe("resolveShippedStatus", () => {
  // a 10-phase done fixture: every phase walked, deploy past, Done in Linear.
  function shippedTicket(over: Partial<BoardTicket> = {}): BoardTicket {
    return ticket({
      phase: "done",
      linearState: "Done",
      pr: 1496,
      working: false,
      activeState: null,
      phaseSummary: PIPELINE_PHASES.map((p) => phaseTiming({ phase: p, status: "done" })),
      ...over,
    });
  }

  it("a Done ticket (deploy walked-past) reads SHIPPED with the PR in the detail", () => {
    const s = resolveShippedStatus(shippedTicket());
    expect(s.state).toBe("shipped");
    expect(s.isShipped).toBe(true);
    expect(s.glyph).toBe("✓");
    expect(s.tone).toBe("success");
    expect(s.headline).toBe("SHIPPED");
    expect(s.detail).toContain("merged & deployed");
    expect(s.detail).toContain("#1496");
    expect(s.prNumber).toBe(1496);
  });

  it("monitor-merge past but monitor-deploy current/running reads MERGED — deploying (not shipped)", () => {
    const t = ticket({
      phase: "monitor-deploy",
      linearState: "PR",
      pr: 1500,
      working: true,
      activeState: "active",
      phaseSummary: [
        phaseTiming({ phase: "pr", status: "done" }),
        phaseTiming({ phase: "monitor-merge", status: "done" }),
        // monitor-deploy IS the current phase and still running (no completedAt)
        phaseTiming({ phase: "monitor-deploy", status: "running", completedAt: null }),
      ],
    });
    const s = resolveShippedStatus(t);
    expect(s.state).toBe("merged");
    expect(s.isShipped).toBe(false);
    expect(s.glyph).toBe("✓");
    expect(s.tone).toBe("success");
    expect(s.headline).toBe("MERGED — deploying");
    expect(s.detail).toContain("deploy in progress");
    expect(s.detail).toContain("#1500");
  });

  it("a working review phase with no PR reads IN REVIEW · no PR", () => {
    const t = ticket({
      phase: "review",
      linearState: "Validate",
      pr: null,
      working: true,
      activeState: "active",
      estimate: 3,
      phaseSummary: [
        phaseTiming({ phase: "verify", status: "done" }),
        phaseTiming({ phase: "review", status: "in_progress", completedAt: null }),
      ],
    });
    const s = resolveShippedStatus(t);
    expect(s.state).toBe("in-flight");
    expect(s.glyph).toBe("●");
    expect(s.tone).toBe("info");
    expect(s.headline).toBe("IN REVIEW");
    expect(s.detail).toContain("phase review");
    expect(s.detail).toContain("no PR");
    expect(s.detail).toContain("3pts");
  });

  it("a blocked hold reads BLOCKED — waiting on <blockers> (warning, never shipped)", () => {
    const s = resolveShippedStatus(
      ticket({ held: "blocked", blockers: ["CTL-653"], phase: "implement" }),
    );
    expect(s.state).toBe("held");
    expect(s.glyph).toBe("⚠");
    expect(s.tone).toBe("warning");
    expect(s.headline).toBe("BLOCKED");
    expect(s.detail).toBe("waiting on CTL-653");
    expect(s.isShipped).toBe(false);
  });

  it("a waiting hold reads WAITING — deps satisfied · awaiting capacity", () => {
    const s = resolveShippedStatus(ticket({ held: "waiting", blockers: [] }));
    expect(s.state).toBe("held");
    expect(s.headline).toBe("WAITING");
    expect(s.detail).toBe("deps satisfied · awaiting capacity");
  });

  it("an on-rail phase that is neither Done, deploy-walked, nor working reads SETTLED", () => {
    // current phase is on the rail (so monitor-deploy stays 'future', not walked),
    // linearState is not Done, and the ticket is not working → the settled fallback.
    const s = resolveShippedStatus(
      ticket({
        phase: "implement",
        linearState: "Implement",
        working: false,
        activeState: null,
        phaseSummary: [phaseTiming({ phase: "implement", status: "in_progress", completedAt: null })],
      }),
    );
    expect(s.state).toBe("settled");
    expect(s.glyph).toBe("○");
    expect(s.tone).toBe("neutral");
    expect(s.headline).toBe("SETTLED");
  });

  it("an off-rail legacy phase (e.g. 'merged') reads the lifecycle as walked → SHIPPED", () => {
    // resolvePipelineRail tolerates an off-rail phase by marking every canonical
    // phase 'past' (the lifecycle is complete) — so deploy is walked-past → shipped.
    const s = resolveShippedStatus(
      ticket({ phase: "merged", linearState: "Backlog", working: false, activeState: null, phaseSummary: [] }),
    );
    expect(s.state).toBe("shipped");
    expect(s.isShipped).toBe(true);
  });

  it("an empty phaseSummary + working ticket still resolves to in-flight (no crash)", () => {
    const s = resolveShippedStatus(
      ticket({ phase: "implement", working: true, activeState: "active", phaseSummary: [] }),
    );
    expect(s.state).toBe("in-flight");
    expect(s.headline).toBe("IN IMPLEMENT");
  });

  it("Done with no PR omits the # tail (honest, never a fabricated PR)", () => {
    const s = resolveShippedStatus(
      ticket({ linearState: "Done", pr: null, phase: "done", phaseSummary: [] }),
    );
    expect(s.state).toBe("shipped");
    expect(s.detail).toBe("merged & deployed");
    expect(s.prNumber).toBeNull();
  });
});

// ── Scenario: resolveTimelineRows — geometry + columns from ONE source ────────
describe("resolveTimelineRows", () => {
  const NOW = Date.parse("2026-06-08T10:30:00.000Z");

  it("yields one row per phaseSummary entry in source order, columns == resolveSpineNodes", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [
        phaseTiming({ phase: "triage", status: "done", durationMs: 42_000 }),
        phaseTiming({ phase: "research", status: "done", durationMs: 198_000 }),
        phaseTiming({ phase: "implement", status: "in_progress", durationMs: null, completedAt: null }),
      ],
    });
    const rows = resolveTimelineRows(t, NOW);
    const nodes = resolveSpineNodes(t);
    expect(rows.map((r) => r.phase)).toEqual(["triage", "research", "implement"]);
    // columns equal the spine-node fields (single source of truth)
    rows.forEach((r, i) => {
      const n = nodes[i];
      expect(r.status).toBe(n.status);
      expect(r.durationMs).toBe(n.durationMs);
      expect(r.startedAt).toBe(n.startedAt);
      expect(r.completedAt).toBe(n.completedAt);
      expect(r.model).toBe(n.model);
      expect(r.isActive).toBe(n.isActive);
      expect(r.costSparkline).toBe(n.costSparkline);
    });
  });

  it("a phase with startedAt:null gets leftPct/widthPct === null (columns present, no bar)", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [
        phaseTiming({ phase: "triage", status: "done" }),
        // a phase that never started — buildBars drops it, the join leaves null geometry.
        // Constructed directly (the phaseTiming helper coalesces null → its default).
        { phase: "research", status: "pending", startedAt: null, completedAt: null, durationMs: null, model: null },
      ],
    });
    const rows = resolveTimelineRows(t, NOW);
    const research = rows.find((r) => r.phase === "research")!;
    expect(research.leftPct).toBeNull();
    expect(research.widthPct).toBeNull();
    // its columns are still present (honest — the row renders without a bar)
    expect(research.status).toBe("pending");
    // the started phase DOES carry geometry
    const triage = rows.find((r) => r.phase === "triage")!;
    expect(triage.leftPct).not.toBeNull();
    expect(triage.widthPct).not.toBeNull();
  });

  it("the active (current, non-terminal) phase is isActive and its geometry isRunning", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [
        phaseTiming({ phase: "triage", status: "done" }),
        // running: started, no completedAt, non-terminal status. Constructed
        // directly (the phaseTiming helper coalesces completedAt:null → a default).
        { phase: "implement", status: "in_progress", startedAt: "2026-06-08T10:10:00.000Z", completedAt: null, durationMs: null, model: null },
      ],
    });
    const rows = resolveTimelineRows(t, NOW);
    const impl = rows.find((r) => r.phase === "implement")!;
    expect(impl.isActive).toBe(true);
    expect(impl.isRunning).toBe(true);
    const triage = rows.find((r) => r.phase === "triage")!;
    expect(triage.isActive).toBe(false);
    expect(triage.isRunning).toBe(false);
  });

  it("phaseCosts present → costUSD/tokens populated + plumbed; absent → null + pending", () => {
    const t = ticket({
      phase: "implement",
      phaseSummary: [
        phaseTiming({ phase: "research", status: "done" }),
        phaseTiming({ phase: "implement", status: "in_progress", completedAt: null }),
      ],
      phaseCosts: { research: { costUSD: 0.21, tokens: 400_000, turns: 3 } },
    });
    const rows = resolveTimelineRows(t, NOW);
    const research = rows.find((r) => r.phase === "research")!;
    expect(research.costUSD).toBe(0.21);
    expect(research.tokens).toBe(400_000);
    expect(research.costSparkline).toBe("plumbed");
    const impl = rows.find((r) => r.phase === "implement")!;
    expect(impl.costUSD).toBeNull();
    expect(impl.tokens).toBeNull();
    expect(impl.costSparkline).toBe("pending");
  });

  it("an empty phaseSummary yields no rows", () => {
    expect(resolveTimelineRows(ticket({ phaseSummary: [] }), NOW)).toEqual([]);
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
