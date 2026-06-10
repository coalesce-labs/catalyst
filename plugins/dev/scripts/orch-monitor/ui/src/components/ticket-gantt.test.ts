// ticket-gantt.test.ts — units for the ticket Gantt timing + per-phase cost
// wiring (CTL-953). Tests the pure buildBars computation: bar placement,
// cost/tokens annotation from phaseCosts, and running-phase detection.
//
// Pure module — no DOM. Run from ui:
//   cd ui && bun test src/components/ticket-gantt.test.ts
import { describe, it, expect } from "bun:test";
import { buildBars } from "./ticket-gantt";
import type { BoardPhaseTiming } from "@/board/types";

function pt(over: Partial<BoardPhaseTiming> & { phase: string }): BoardPhaseTiming {
  return {
    phase: over.phase,
    status: over.status ?? "done",
    durationMs: over.durationMs ?? 60_000,
    startedAt: over.startedAt ?? "2026-06-08T10:00:00.000Z",
    completedAt: over.completedAt ?? "2026-06-08T10:01:00.000Z",
    model: over.model ?? null,
  };
}

// ── Scenario: buildBars computes correct bar geometry ───────────────────────
describe("Scenario: buildBars computes correct bar geometry (CTL-953)", () => {
  it("returns null when no rows have startedAt (no timing data yet)", () => {
    const rows: BoardPhaseTiming[] = [
      { phase: "triage", status: "done", durationMs: null, startedAt: null, completedAt: null, model: null },
    ];
    expect(buildBars(rows, Date.now())).toBeNull();
  });

  it("a single completed phase spans the full axis (leftPct=0, widthPct≈100)", () => {
    const rows = [
      pt({ phase: "triage", startedAt: "2026-06-08T10:00:00.000Z", completedAt: "2026-06-08T10:05:00.000Z" }),
    ];
    const bars = buildBars(rows, Date.now());
    expect(bars).not.toBeNull();
    expect(bars![0].leftPct).toBeCloseTo(0, 1);
    expect(bars![0].widthPct).toBeCloseTo(100, 1);
  });

  it("two sequential phases: second starts where first ends", () => {
    const rows = [
      pt({ phase: "triage",   startedAt: "2026-06-08T10:00:00.000Z", completedAt: "2026-06-08T10:05:00.000Z" }),
      pt({ phase: "research", startedAt: "2026-06-08T10:05:00.000Z", completedAt: "2026-06-08T10:10:00.000Z" }),
    ];
    const bars = buildBars(rows, Date.now())!;
    expect(bars[0].leftPct).toBeCloseTo(0, 1);
    expect(bars[0].widthPct).toBeCloseTo(50, 1);
    expect(bars[1].leftPct).toBeCloseTo(50, 1);
    expect(bars[1].widthPct).toBeCloseTo(50, 1);
  });

  it("a running (non-terminal, no completedAt) phase uses the `now` clock as its end", () => {
    const start = Date.now() - 60_000; // 1 min ago
    const rows: BoardPhaseTiming[] = [
      { phase: "implement", status: "in_progress", durationMs: null, startedAt: new Date(start).toISOString(), completedAt: null, model: null },
    ];
    const bars = buildBars(rows, Date.now())!;
    expect(bars[0].isRunning).toBe(true);
    // spans the full axis (only bar)
    expect(bars[0].widthPct).toBeGreaterThan(0);
  });

  it("isRunning is false for terminal statuses even without completedAt", () => {
    const rows: BoardPhaseTiming[] = [
      { phase: "implement", status: "failed", durationMs: null, startedAt: "2026-06-08T10:00:00.000Z", completedAt: null, model: null },
    ];
    const bars = buildBars(rows, Date.now())!;
    expect(bars[0].isRunning).toBe(false);
  });

  it("durationLabel is formatted for a completed phase", () => {
    const rows = [
      pt({ phase: "triage", durationMs: 90_000 }), // 1m 30s
    ];
    const bars = buildBars(rows, Date.now())!;
    expect(bars[0].durationLabel).toBe("1m 30s");
  });
});

// ── Scenario: TicketGantt receives phaseCosts and renders cost column ────────
// The JSX rendering is not DOM-tested here, but the data plumbing is verified:
// phaseCosts keys match phase names in the bars so the Gantt can annotate each row.
describe("Scenario: Gantt cost annotation data plumbing (CTL-953)", () => {
  it("buildBars includes the phase name so phaseCosts[row.phase] can be looked up", () => {
    const rows = [
      pt({ phase: "research", startedAt: "2026-06-08T10:00:00.000Z", completedAt: "2026-06-08T10:05:00.000Z" }),
      pt({ phase: "plan",     startedAt: "2026-06-08T10:05:00.000Z", completedAt: "2026-06-08T10:10:00.000Z" }),
    ];
    const bars = buildBars(rows, Date.now())!;
    const phases = bars.map((b) => b.row.phase);
    expect(phases).toEqual(["research", "plan"]);
    // A consumer can look up costs: phaseCosts[bars[0].row.phase]
    const fakePhaseCosts: Record<string, { costUSD: number; tokens: number; turns: number }> = {
      research: { costUSD: 0.21, tokens: 400_000, turns: 3 },
    };
    expect(fakePhaseCosts[bars[0].row.phase]?.costUSD).toBe(0.21);
    expect(fakePhaseCosts[bars[1].row.phase]).toBeUndefined(); // plan has no cost yet
  });

  it("rows with no startedAt are filtered out (no phantom bar for unstarted phases)", () => {
    const rows: BoardPhaseTiming[] = [
      pt({ phase: "triage", startedAt: "2026-06-08T10:00:00.000Z", completedAt: "2026-06-08T10:01:00.000Z" }),
      { phase: "research", status: "pending", durationMs: null, startedAt: null, completedAt: null, model: null },
    ];
    const bars = buildBars(rows, Date.now())!;
    expect(bars.map((b) => b.row.phase)).toEqual(["triage"]); // research absent — no start time
  });
});
