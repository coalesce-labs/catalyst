// ticket-telemetry-data.test.ts — units for the ticket TELEMETRY strip
// derivations (CTL-917 / DETAIL6). Each describe maps to a Gherkin scenario;
// these pure functions ARE the strip's acceptance surface.
//
// Pure module — no DOM. Run from ui:
//   cd ui && bun test src/board/ticket-telemetry-data.test.ts
import { describe, it, expect } from "bun:test";
import {
  buildTelemetryTiles,
  resolveCostByPhase,
  resolveCostByModel,
  type TicketTelemetrySeries,
} from "./ticket-telemetry-data";
import type { BoardTicket } from "./types";

function ticket(over: Partial<BoardTicket>): BoardTicket {
  return {
    id: "CTL-845",
    title: "reclaim false-dead premature advance",
    type: "feature",
    repo: "plugins/dev",
    team: "CTL",
    phase: "implement",
    status: "in_progress",
    model: "opus",
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

const liveSeries: TicketTelemetrySeries = {
  cost: [[100, 0.6], [160, 1.14]],
  tokens: [[160, 2_500_000]],
  tokensByType: { input: [[160, 2_100_000]], output: [[160, 412_000]] },
  costByPhase: {
    plan: [[160, 0.38]],
    implement: [[160, 0.51]],
    research: [[160, 0.21]],
  },
  costByModel: { opus: [[160, 0.89]], sonnet: [[160, 0.25]] },
};

// ── Scenario: Ticket telemetry strip renders per-phase and per-model bars ────
describe("Scenario: Ticket telemetry strip renders per-phase and per-model bars", () => {
  it("total cost & tokens render REAL query_range sparklines keyed on the linear key", () => {
    const tiles = buildTelemetryTiles(liveSeries, ticket({}));
    const byLabel = Object.fromEntries(tiles.map((t) => [t.label, t]));
    expect(byLabel["COST"].source).toBe("sparkline");
    expect(byLabel["COST"].points).toEqual([[100, 0.6], [160, 1.14]]);
    expect(byLabel["COST"].value).toBe(1.14);
    expect(byLabel["TOKENS"].source).toBe("sparkline");
    expect(byLabel["TOKENS"].value).toBe(2_500_000);
  });

  it("cost-by-phase bars use the sum by(task_type) series, sorted biggest-first", () => {
    const { bars, source } = resolveCostByPhase(liveSeries, ticket({}));
    expect(source).toBe("sparkline");
    expect(bars.map((b) => b.label)).toEqual(["implement", "plan", "research"]);
    expect(bars[0]).toEqual({ label: "implement", value: 0.51 });
  });

  it("cost-by-model bars use the sum by(model) series, sorted biggest-first", () => {
    const { bars, source } = resolveCostByModel(liveSeries);
    expect(source).toBe("sparkline");
    expect(bars.map((b) => b.label)).toEqual(["opus", "sonnet"]);
    expect(bars[0]).toEqual({ label: "opus", value: 0.89 });
  });

  it("falls back to BoardTicket.{costUSD,tokens} + phaseCosts for an instant no-sparkline paint", () => {
    // No live series → instant paint off the resident scalars + phaseCosts.
    const t = ticket({
      costUSD: 1.14,
      tokens: 2_500_000,
      phaseCosts: {
        plan: { costUSD: 0.38, tokens: 1000, turns: 1 },
        implement: { costUSD: 0.51, tokens: 2000, turns: 5 },
      },
    });
    const tiles = buildTelemetryTiles(null, t);
    const cost = tiles.find((x) => x.label === "COST")!;
    expect(cost.source).toBe("scalar-fallback");
    expect(cost.value).toBe(1.14);
    expect(cost.points).toEqual([]); // no sparkline

    const phase = resolveCostByPhase(null, t);
    expect(phase.source).toBe("scalar-fallback");
    expect(phase.bars.map((b) => b.label)).toEqual(["implement", "plan"]); // biggest-first
    expect(phase.bars[0]).toEqual({ label: "implement", value: 0.51 });
  });

  it("cost-by-model has NO resident fallback → unavailable (dim), never a fabricated split", () => {
    // The resident phaseCosts carry no model split, so with no live series the
    // model bars are honestly unavailable.
    const t = ticket({
      phaseCosts: { plan: { costUSD: 0.38, tokens: 1000, turns: 1 } },
    });
    const model = resolveCostByModel(null);
    expect(model.source).toBe("unavailable");
    expect(model.bars).toEqual([]);
    // ...even though cost-by-phase DOES have a fallback for the same ticket.
    expect(resolveCostByPhase(null, t).source).toBe("scalar-fallback");
  });
});

// ── Scenario: Counters stay honest to their source ───────────────────────────
describe("Scenario: Counters stay honest to their source", () => {
  it("COMMITS and LoC are NEEDS-PLUMBING (git-sourced, not telemetry)", () => {
    const tiles = buildTelemetryTiles(liveSeries, ticket({}));
    const commits = tiles.find((t) => t.label === "COMMITS")!;
    const loc = tiles.find((t) => t.label === "LoC")!;
    expect(commits.source).toBe("needs-plumbing");
    expect(commits.value).toBeNull();
    expect(loc.source).toBe("needs-plumbing");
    expect(loc.value).toBeNull();
  });

  it("a flat/empty cost series with no resident scalar yields a null-valued fallback (never faked)", () => {
    const empty: TicketTelemetrySeries = {
      cost: [],
      tokens: [],
      tokensByType: {},
      costByPhase: {},
      costByModel: {},
    };
    const tiles = buildTelemetryTiles(empty, ticket({ costUSD: null, tokens: null }));
    const cost = tiles.find((t) => t.label === "COST")!;
    expect(cost.source).toBe("scalar-fallback");
    expect(cost.value).toBeNull();
  });
});
