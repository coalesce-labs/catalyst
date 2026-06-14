// process-dots.test.ts — CTL-1101 Phase 5. Pure unit tests for buildPhaseDots.
// No DOM, no @xyflow/react. Mirrors the dep-graph-edges.ts precedent.
import { describe, it, expect } from "bun:test";
import {
  buildPhaseDots,
  MAX_VISIBLE_DOTS,
  type DotTicket,
  type PhaseDotGroup,
} from "./process-dots";
import { LIVE } from "./board-tokens";
import { C } from "./board-tokens";

const NODE_IDS = new Set([
  "triage","research","plan","implement","verify","review","pr",
  "monitor-merge","monitor-deploy","teardown",
]);

function t(id: string, phase: string, overrides: Partial<DotTicket> = {}): DotTicket {
  return { id, phase, status: "in_progress", activeState: null, working: false, ...overrides };
}

// ── buildPhaseDots — basic grouping ───────────────────────────────────────────

describe("buildPhaseDots — basic grouping", () => {
  it("groups in-flight tickets by phase", () => {
    const groups = buildPhaseDots(
      [t("A", "implement"), t("B", "implement"), t("C", "verify")],
      NODE_IDS,
    );
    const impl = groups.find((g) => g.phase === "implement");
    const vfy = groups.find((g) => g.phase === "verify");
    expect(impl).toBeDefined();
    expect(impl!.total).toBe(2);
    expect(vfy).toBeDefined();
    expect(vfy!.total).toBe(1);
  });

  it("returns empty array for no in-flight tickets", () => {
    expect(buildPhaseDots([], NODE_IDS)).toHaveLength(0);
  });

  it("returns one group per occupied phase (not one per ticket)", () => {
    const groups = buildPhaseDots(
      [t("A", "implement"), t("B", "implement"), t("C", "implement")],
      NODE_IDS,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].phase).toBe("implement");
  });
});

// ── buildPhaseDots — overflow collapse ────────────────────────────────────────

describe("buildPhaseDots — overflow collapse", () => {
  it("collapses >5 on one node to 5 dots + overflow N (7 → 5 + 2)", () => {
    const g = buildPhaseDots(
      ["A","B","C","D","E","F","G"].map((id) => t(id, "implement")),
      NODE_IDS,
    ).find((x) => x.phase === "implement")!;
    expect(g.dots).toHaveLength(MAX_VISIBLE_DOTS);
    expect(g.overflow).toBe(2);
    expect(g.total).toBe(7);
  });

  it("shows exactly 5 dots and overflow=0 when exactly 5 tickets", () => {
    const g = buildPhaseDots(
      ["A","B","C","D","E"].map((id) => t(id, "implement")),
      NODE_IDS,
    ).find((x) => x.phase === "implement")!;
    expect(g.dots).toHaveLength(5);
    expect(g.overflow).toBe(0);
    expect(g.total).toBe(5);
  });

  it("shows all dots and overflow=0 when <5 tickets", () => {
    const g = buildPhaseDots(
      [t("A", "verify"), t("B", "verify")],
      NODE_IDS,
    ).find((x) => x.phase === "verify")!;
    expect(g.dots).toHaveLength(2);
    expect(g.overflow).toBe(0);
    expect(g.total).toBe(2);
  });
});

// ── buildPhaseDots — filtering ─────────────────────────────────────────────────

describe("buildPhaseDots — filtering", () => {
  it("ignores a ticket whose phase has no node", () => {
    const groups = buildPhaseDots(
      [t("A", "implement"), t("X", "queued")],
      NODE_IDS,
    );
    expect(groups.map((g) => g.phase)).toEqual(["implement"]);
  });

  it("excludes terminal tickets (done)", () => {
    const groups = buildPhaseDots(
      [t("A", "implement"), t("D", "teardown", { status: "done" })],
      NODE_IDS,
    );
    expect(groups.map((g) => g.phase)).toEqual(["implement"]);
  });

  it("excludes terminal tickets (failed/stalled/skipped/signal_corrupt/superseded/canceled)", () => {
    const terminal = ["failed","stalled","skipped","signal_corrupt","superseded","canceled"];
    for (const status of terminal) {
      const groups = buildPhaseDots([t("X", "implement", { status })], NODE_IDS);
      expect(groups).toHaveLength(0);
    }
  });

  it("includes tickets with non-terminal status even if working=false", () => {
    const groups = buildPhaseDots([t("A", "verify", { working: false })], NODE_IDS);
    expect(groups).toHaveLength(1);
  });
});

// ── buildPhaseDots — dot coloring ─────────────────────────────────────────────

describe("buildPhaseDots — dot coloring", () => {
  it("colors active tickets as LIVE cyan", () => {
    const g = buildPhaseDots([t("A", "implement", { activeState: "active" })], NODE_IDS)[0]!;
    expect(g.dots[0].color).toBe(LIVE);
  });

  it("colors stuck tickets as red", () => {
    const g = buildPhaseDots([t("A", "implement", { activeState: "stuck" })], NODE_IDS)[0]!;
    expect(g.dots[0].color).toBe(C.red);
  });

  it("colors failed-status tickets as red", () => {
    const g = buildPhaseDots([t("A", "implement", { status: "in_progress", activeState: null })], NODE_IDS)[0]!;
    const gf = buildPhaseDots([t("A", "implement", { status: "in_progress", activeState: "dead" })], NODE_IDS)[0]!;
    // dead → muted (not red unless activeState==="stuck" or status==="failed")
    expect(gf.dots[0].color).toBe(C.fgDim);
  });

  it("colors idle in-flight tickets as fgDim muted", () => {
    const g = buildPhaseDots([t("A", "research", { activeState: null })], NODE_IDS)[0]!;
    expect(g.dots[0].color).toBe(C.fgDim);
  });
});

// ── buildPhaseDots — determinism ──────────────────────────────────────────────

describe("buildPhaseDots — determinism", () => {
  it("produces groups in nodeIds iteration order (deterministic)", () => {
    const groups = buildPhaseDots(
      [t("A", "verify"), t("B", "implement"), t("C", "research")],
      NODE_IDS,
    );
    const phases = groups.map((g) => g.phase);
    // research < implement < verify in NODE_IDS iteration order
    expect(phases.indexOf("research")).toBeLessThan(phases.indexOf("implement"));
    expect(phases.indexOf("implement")).toBeLessThan(phases.indexOf("verify"));
  });

  it("sorts dots within a group by ticket id (stable across calls)", () => {
    const g = buildPhaseDots(
      [t("C", "implement"), t("A", "implement"), t("B", "implement")],
      NODE_IDS,
    ).find((x) => x.phase === "implement")!;
    expect(g.dots.map((d) => d.id)).toEqual(["A", "B", "C"]);
  });
});
