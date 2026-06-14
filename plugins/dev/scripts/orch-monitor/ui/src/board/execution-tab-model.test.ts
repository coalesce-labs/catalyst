// execution-tab-model.test.ts — unit tests for the Execution tab pure derivations.
// CTL-1102. Mirror the ticket-page-model.test.ts fixture style (bun:test, local
// builders). DOM-free; run from orch-monitor root: bun test src/board/execution-tab-model.test.ts
import { describe, it, expect } from "bun:test";
import {
  buildNowCard,
  buildNarrativeSummary,
  buildIdleGaps,
  buildExceptionsList,
  buildArtifactsRows,
} from "./execution-tab-model";
import type { BoardPhaseTiming, BoardTicket } from "./types";
import type { Journey, JourneyHop } from "../lib/journey-model";

// ── fixtures ──────────────────────────────────────────────────────────────────

function hop(over: Partial<JourneyHop> & { phase: string; eventType: string }): JourneyHop {
  return {
    phase: over.phase,
    eventType: over.eventType,
    ts: over.ts ?? "2026-06-13T10:00:00.000Z",
    host: over.host ?? "host-1",
    bg_job_id: over.bg_job_id,
    reason: over.reason,
    targetPhase: over.targetPhase,
    blockers: over.blockers,
  };
}

function journey(over: Partial<Journey> = {}): Journey {
  return {
    ticket: "CTL-1102",
    hops: over.hops ?? [],
    gates: over.gates ?? { checklist: [], nextPhase: null },
    verifyVerdict: over.verifyVerdict ?? { verdict: null },
    remediateCycles: over.remediateCycles ?? 0,
    unblockHints: over.unblockHints ?? [],
    hosts: over.hosts ?? ["host-1"],
  };
}

function phaseTiming(over: Partial<BoardPhaseTiming> & { phase: string }): BoardPhaseTiming {
  return {
    phase: over.phase,
    status: over.status ?? "done",
    durationMs: "durationMs" in over ? over.durationMs! : 42_000,
    startedAt: "startedAt" in over ? over.startedAt! : "2026-06-13T10:00:00.000Z",
    completedAt: "completedAt" in over ? over.completedAt! : "2026-06-13T10:00:42.000Z",
    model: "model" in over ? over.model! : null,
  };
}

function ticket(over: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id: "CTL-1102",
    title: "Execution tab",
    type: "feature",
    repo: "plugins/dev",
    team: "CTL",
    phase: "implement",
    status: "in_progress",
    model: "sonnet",
    linearState: "Implement",
    workerStatus: null,
    activeState: "active",
    working: true,
    lastActiveMs: 1000,
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
    updatedAt: "2026-06-13T10:00:00.000Z",
    held: null,
    ...over,
  };
}

// ── buildNowCard ──────────────────────────────────────────────────────────────

describe("buildNowCard", () => {
  it("reports the current phase and status from ticket", () => {
    const t = ticket({ phase: "implement" });
    const j = journey({
      gates: {
        checklist: [
          { phase: "implement", signalStatus: "running", satisfied: false },
        ],
        nextPhase: "verify",
      },
    });
    const card = buildNowCard(t, j);
    expect(card).not.toBeNull();
    expect(card!.phaseLabel).toBe("implement");
    expect(card!.status).toBe("current");
    expect(card!.nextLabel).toBe("verify");
  });

  it("surfaces attention when present on ticket", () => {
    const t = ticket({ attention: "needs-human", attentionSince: "2026-06-13T09:00:00.000Z" });
    const card = buildNowCard(t, null);
    expect(card).not.toBeNull();
    expect(card!.attention).toBe("needs-human");
  });

  it("returns null when ticket is undefined", () => {
    const card = buildNowCard(undefined, null);
    expect(card).toBeNull();
  });

  it("returns unknown status when journey is null", () => {
    const t = ticket({ phase: "plan" });
    const card = buildNowCard(t, null);
    expect(card).not.toBeNull();
    expect(card!.status).toBe("unknown");
    expect(card!.nextLabel).toBeNull();
  });

  it("reflects done status from a satisfied gate", () => {
    const t = ticket({ phase: "research" });
    const j = journey({
      gates: {
        checklist: [{ phase: "research", signalStatus: "complete", satisfied: true }],
        nextPhase: "plan",
      },
    });
    const card = buildNowCard(t, j);
    expect(card!.status).toBe("done");
  });
});

// ── buildNarrativeSummary ─────────────────────────────────────────────────────

describe("buildNarrativeSummary", () => {
  it("returns a non-empty string even with an empty hops array", () => {
    const result = buildNarrativeSummary(journey({ hops: [] }));
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string when journey is null", () => {
    const result = buildNarrativeSummary(null);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("describes a clean run with consecutive started→complete hops", () => {
    const j = journey({
      hops: [
        hop({ phase: "triage", eventType: "started", ts: "2026-06-13T08:00:00.000Z" }),
        hop({ phase: "triage", eventType: "complete", ts: "2026-06-13T08:05:00.000Z" }),
        hop({ phase: "research", eventType: "started", ts: "2026-06-13T08:05:10.000Z" }),
        hop({ phase: "research", eventType: "complete", ts: "2026-06-13T08:30:00.000Z" }),
      ],
      gates: { checklist: [], nextPhase: "plan" },
    });
    const result = buildNarrativeSummary(j);
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("NaN");
    expect(result.length).toBeGreaterThan(0);
  });

  it("calls out the first failed hop and its reason", () => {
    const j = journey({
      hops: [
        hop({ phase: "implement", eventType: "started" }),
        hop({ phase: "implement", eventType: "failed", reason: "test_failures" }),
      ],
    });
    const result = buildNarrativeSummary(j);
    expect(result).toContain("implement");
  });

  it("counts remediate rounds when remediateCycles > 0", () => {
    const j = journey({ remediateCycles: 2 });
    const result = buildNarrativeSummary(j);
    expect(result).toContain("2");
  });

  it("states what is ahead from gates.nextPhase", () => {
    const j = journey({
      gates: { checklist: [], nextPhase: "verify" },
    });
    const result = buildNarrativeSummary(j);
    expect(result).toContain("verify");
  });
});

// ── buildIdleGaps ─────────────────────────────────────────────────────────────

describe("buildIdleGaps", () => {
  it("computes gap between completedAt[N] and startedAt[N+1]", () => {
    const summary = [
      phaseTiming({
        phase: "triage",
        completedAt: "2026-06-13T10:00:00.000Z",
      }),
      phaseTiming({
        phase: "research",
        startedAt: "2026-06-13T10:01:00.000Z",
      }),
    ];
    const gaps = buildIdleGaps(summary);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].afterPhase).toBe("triage");
    expect(gaps[0].beforePhase).toBe("research");
    expect(gaps[0].ms).toBe(60_000);
  });

  it("skips pairs missing a timestamp (no NaN gaps)", () => {
    const summary = [
      phaseTiming({ phase: "triage", completedAt: null }),
      phaseTiming({ phase: "research", startedAt: "2026-06-13T10:01:00.000Z" }),
    ];
    const gaps = buildIdleGaps(summary);
    expect(gaps).toHaveLength(0);
  });

  it("returns [] for a single timed phase", () => {
    const summary = [phaseTiming({ phase: "triage" })];
    const gaps = buildIdleGaps(summary);
    expect(gaps).toHaveLength(0);
  });

  it("returns [] for empty phaseSummary", () => {
    expect(buildIdleGaps([])).toHaveLength(0);
  });
});

// ── buildExceptionsList ───────────────────────────────────────────────────────

describe("buildExceptionsList", () => {
  it("returns [] when nothing unusual happened", () => {
    expect(buildExceptionsList(journey(), ticket())).toHaveLength(0);
  });

  it("emits a failure row for failed hops with a reason", () => {
    const j = journey({
      hops: [hop({ phase: "implement", eventType: "failed", reason: "test_failures" })],
    });
    const rows = buildExceptionsList(j, ticket());
    const failure = rows.find((r) => r.kind === "failure");
    expect(failure).toBeDefined();
    expect(failure!.phase).toBe("implement");
    expect(failure!.detail).toContain("test_failures");
  });

  it("emits a failure row for stalled hops", () => {
    const j = journey({
      hops: [hop({ phase: "verify", eventType: "stalled", reason: "turn_cap" })],
    });
    const rows = buildExceptionsList(j, ticket());
    expect(rows.some((r) => r.kind === "failure" && r.phase === "verify")).toBe(true);
  });

  it("emits operator-note rows from unblockHints", () => {
    const j = journey({
      unblockHints: [{ kind: "operator-note", note: "manual intervention" }],
    });
    const rows = buildExceptionsList(j, ticket());
    expect(rows.some((r) => r.kind === "operator-note")).toBe(true);
  });

  it("emits an auto-unstuck row from unblockHints", () => {
    const j = journey({
      unblockHints: [{ kind: "auto-unstuck", reason: "budget_unlocked" }],
    });
    const rows = buildExceptionsList(j, ticket());
    expect(rows.some((r) => r.kind === "auto-unstuck")).toBe(true);
  });

  it("emits a remediate-cycles row when remediateCycles > 0", () => {
    const j = journey({ remediateCycles: 3 });
    const rows = buildExceptionsList(j, ticket());
    expect(rows.some((r) => r.kind === "remediate-cycles")).toBe(true);
  });

  it("emits a verify-failure row when verifyVerdict.verdict is 'fail'", () => {
    const j = journey({
      verifyVerdict: { verdict: "fail", highFindings: 2, regressionRisk: 1 },
    });
    const rows = buildExceptionsList(j, ticket());
    expect(rows.some((r) => r.kind === "verify-failure")).toBe(true);
  });

  it("emits a decision-ahead row from gates.nextPhase", () => {
    const j = journey({
      gates: { checklist: [], nextPhase: "pr" },
    });
    const rows = buildExceptionsList(j, ticket());
    expect(rows.some((r) => r.kind === "decision-ahead")).toBe(true);
  });

  it("returns [] when journey is null", () => {
    expect(buildExceptionsList(null, ticket())).toHaveLength(0);
  });
});

// ── buildArtifactsRows ────────────────────────────────────────────────────────

describe("buildArtifactsRows", () => {
  it("returns [] when all inputs are empty/null", () => {
    expect(buildArtifactsRows([], undefined, null)).toHaveLength(0);
  });

  it("joins research artifacts into rows", () => {
    const artifacts = [
      { kind: "research", path: "thoughts/shared/research/2026-06-13-ctl-1102.md", peek: "Research for CTL-1102" },
    ];
    const rows = buildArtifactsRows(artifacts, ticket(), journey());
    const researchRow = rows.find((r) => r.research != null);
    expect(researchRow).toBeDefined();
    expect(researchRow!.research!.path).toContain("research");
  });

  it("joins plan artifacts into rows", () => {
    const artifacts = [
      { kind: "plan", path: "thoughts/shared/plans/2026-06-13-ctl-1102.md", peek: "Plan for CTL-1102" },
    ];
    const rows = buildArtifactsRows(artifacts, ticket(), journey());
    const planRow = rows.find((r) => r.plan != null);
    expect(planRow).toBeDefined();
  });

  it("includes pr from ticket when present", () => {
    const t = ticket({ pr: 1234 });
    const rows = buildArtifactsRows([], t, journey());
    const prRow = rows.find((r) => r.pr != null);
    expect(prRow).toBeDefined();
    expect(prRow!.pr).toBe(1234);
  });

  it("includes verifyVerdict from journey when present", () => {
    const j = journey({ verifyVerdict: { verdict: "pass", regressionRisk: 0 } });
    const rows = buildArtifactsRows([], ticket(), j);
    const verdictRow = rows.find((r) => r.verifyVerdict != null);
    expect(verdictRow).toBeDefined();
    expect(verdictRow!.verifyVerdict).toBe("pass");
  });

  it("tolerates null journey (returns ticket-only rows when pr is set)", () => {
    const t = ticket({ pr: 999 });
    const rows = buildArtifactsRows([], t, null);
    expect(rows.some((r) => r.pr === 999)).toBe(true);
  });
});
