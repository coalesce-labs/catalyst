// phase-outcome-data.test.ts — units for the worker-detail v2 phase-aware section
// mapping + signal readers (CTL-925 / WORKER-DETAIL v2 Pass B §6). Pure module —
// no DOM (mirrors worker-burn-data.test.ts). Run from ui:
//   cd ui && bun test src/board/phase-outcome-data.test.ts
import { describe, it, expect } from "bun:test";
import {
  phaseToSectionKind,
  artifactKindForPhase,
  prFromSignal,
  verdictFromSignal,
  deriveTriageOutcome,
  normalizeDependencies,
  type PhaseSectionKind,
} from "./phase-outcome-data";
import type { BoardTicket } from "./types";

function ticket(over: Partial<BoardTicket>): BoardTicket {
  return {
    id: "CTL-925",
    title: "t",
    type: "refactor",
    repo: "plugins/dev",
    team: "CTL",
    phase: "triage",
    status: "running",
    model: null,
    linearState: "In Progress",
    workerStatus: null,
    activeState: "active",
    working: true,
    lastActiveMs: 0,
    priority: 0,
    estimate: 3,
    estimateDisplay: "3",
    estimateMethod: "None",
    scope: "large",
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "",
    ...over,
  };
}

describe("phaseToSectionKind — exhaustive + total", () => {
  it("maps every known phase to its section kind", () => {
    const cases: [string, PhaseSectionKind][] = [
      ["triage", "triage"],
      ["research", "research"],
      ["plan", "plan"],
      ["implement", "implement"],
      ["verify", "verify"],
      ["review", "review"],
      ["monitor-merge", "monitor-merge"],
      ["monitor-deploy", "monitor-deploy"],
      ["remediate", "remediate"],
      ["teardown", "teardown"],
    ];
    for (const [phase, kind] of cases) {
      expect(phaseToSectionKind(phase)).toBe(kind);
    }
  });

  it("unknown/absent phase → 'default' (the page is never empty)", () => {
    expect(phaseToSectionKind("frobnicate")).toBe("default");
    expect(phaseToSectionKind(undefined)).toBe("default");
    expect(phaseToSectionKind(null)).toBe("default");
  });
});

describe("artifactKindForPhase", () => {
  it("research → research, plan → plan, others → null", () => {
    expect(artifactKindForPhase("research")).toBe("research");
    expect(artifactKindForPhase("plan")).toBe("plan");
    expect(artifactKindForPhase("implement")).toBeNull();
    expect(artifactKindForPhase("verify")).toBeNull();
  });
});

describe("prFromSignal — mirrors prFromSignal in ticket-runs.mjs", () => {
  it("prefers sig.pr.{number,url} when present", () => {
    const pr = prFromSignal({ pr: { number: 1708, url: "https://gh/pr/1708" } });
    expect(pr).toEqual({
      number: 1708,
      url: "https://gh/pr/1708",
      isDraft: false,
      ciStatus: null,
      mergedAt: null,
      mergeCommitSha: null,
    });
  });

  it("falls back to sig.draftPr.{number,url,isDraft}", () => {
    const pr = prFromSignal({ draftPr: { number: 42, url: "u", isDraft: true } });
    expect(pr?.number).toBe(42);
    expect(pr?.isDraft).toBe(true);
  });

  it("surfaces monitor-merge fields when the pr carries them", () => {
    const pr = prFromSignal({
      pr: { number: 9, ciStatus: "passing", mergedAt: "2026-06-10T00:00:00Z", mergeCommitSha: "abc123" },
    });
    expect(pr?.ciStatus).toBe("passing");
    expect(pr?.mergeCommitSha).toBe("abc123");
  });

  it("null when neither pr nor draftPr present (most phases — chip hidden)", () => {
    expect(prFromSignal({ status: "running" })).toBeNull();
    expect(prFromSignal(null)).toBeNull();
    expect(prFromSignal({ pr: { url: "u" } })).toBeNull(); // no number → not a PR
  });
});

describe("verdictFromSignal — verify/review verdict, honest dims", () => {
  it("reads a top-level verdict string", () => {
    expect(verdictFromSignal({ verdict: "fail" }).verdict).toBe("fail");
  });

  it("reads boolean reviewPassed/verifyPassed/passed", () => {
    expect(verdictFromSignal({ reviewPassed: true }).verdict).toBe("pass");
    expect(verdictFromSignal({ verifyPassed: false }).verdict).toBe("fail");
  });

  it("counts HIGH-severity findings", () => {
    const v = verdictFromSignal({
      findings: [{ severity: "high" }, { severity: "low" }, { severity: "high" }],
    });
    expect(v.highFindings).toBe(2);
  });

  it("the live envelope signal (no verdict/findings) dims everything honestly", () => {
    // GROUND-TRUTH: the live /api/ec-worker/<t>/verify signal carries only the
    // lifecycle envelope + an `artifact` pointer — no inline verdict.
    const v = verdictFromSignal({
      status: "done",
      artifact: "/.../verify.json",
      model: "opus",
    });
    expect(v.verdict).toBeNull();
    expect(v.highFindings).toBeNull();
    expect(v.regressionRisk).toBeNull();
    expect(v.remediated).toBeNull();
  });
});

describe("normalizeDependencies", () => {
  it("normalizes string[] / [{id}] / single string to ids", () => {
    expect(normalizeDependencies(["CTL-1", "CTL-2"])).toEqual(["CTL-1", "CTL-2"]);
    expect(normalizeDependencies([{ id: "CTL-3" }, { id: "CTL-4" }])).toEqual(["CTL-3", "CTL-4"]);
    expect(normalizeDependencies("CTL-5")).toEqual(["CTL-5"]);
  });

  it("absent/empty → []", () => {
    expect(normalizeDependencies(undefined)).toEqual([]);
    expect(normalizeDependencies([])).toEqual([]);
    expect(normalizeDependencies(null)).toEqual([]);
  });
});

describe("deriveTriageOutcome — signal + resident ticket, never fabricated", () => {
  it("prefers the signal's own classification/scope when inlined", () => {
    const t = deriveTriageOutcome(
      { classification: "bug", estimated_scope: "s", dependencies: ["CTL-1"] },
      ticket({ type: "refactor", scope: "large" }),
    );
    expect(t.classification).toBe("bug");
    expect(t.scope).toBe("s");
    expect(t.blockers).toEqual(["CTL-1"]);
  });

  it("falls back to the resident BoardTicket fields (the live triage signal omits them)", () => {
    // GROUND-TRUTH: the live triage signal posts classification/estimate to Linear,
    // not the on-disk file — so the resident ticket is the fallback truth.
    const t = deriveTriageOutcome(
      { status: "done", ticket: "CTL-925" },
      ticket({ type: "refactor", scope: "large", estimateDisplay: "3", estimateMethod: "None" }),
    );
    expect(t.classification).toBe("refactor");
    expect(t.scope).toBe("large");
    expect(t.estimateDisplay).toBe("3");
    expect(t.estimateMethod).toBeNull(); // "None" → null, never shown
    expect(t.blockers).toEqual([]);
  });

  it("dims everything when neither signal nor ticket has the field", () => {
    const t = deriveTriageOutcome(null, undefined);
    expect(t.classification).toBeNull();
    expect(t.scope).toBeNull();
    expect(t.estimateDisplay).toBeNull();
    expect(t.blockers).toEqual([]);
  });
});
