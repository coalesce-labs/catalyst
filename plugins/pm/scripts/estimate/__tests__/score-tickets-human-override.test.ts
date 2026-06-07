import { describe, expect, test } from "bun:test";
import {
  applyHumanOverride,
  buildCorpusEntry,
  humanOverridePoints,
  parseCsv,
  scoreRow,
  type SignalRow,
} from "../score-tickets";

// CTL-813: the compound-log human re-score (`human_actual_points` column from
// collect-ticket-signals) overrides the voted score — a post-merge human
// ground truth beats any heuristic vote, so the corpus entry should carry it.

function row(over: Partial<SignalRow> = {}): SignalRow {
  return {
    ticket_id: "CTL-1",
    title: "a medium ticket",
    state: "Done",
    priority: "2",
    project: "",
    created_at: "2026-06-01T00:00:00Z",
    closed_at: "2026-06-02T00:00:00Z",
    current_estimate: "3",
    pr_number: "10",
    additions: "100",
    deletions: "50",
    changed_files: "3",
    commits: "",
    review_comments: "",
    ci_runs: "",
    hours_to_merge: "4.0",
    had_force_push: "",
    otel_cost_usd: "",
    otel_input_tokens: "",
    otel_output_tokens: "",
    otel_turns: "",
    otel_wall_time_hours: "",
    otel_tool_success_rate: "",
    domains_touched: "plugins/dev",
    has_migration: "false",
    has_frontend: "false",
    has_backend: "true",
    ...over,
  };
}

describe("humanOverridePoints", () => {
  test("valid fib points parse", () => {
    for (const v of ["1", "3", "5", "8", "13"]) {
      expect(humanOverridePoints(row({ human_actual_points: v }))).toBe(Number(v));
    }
  });

  test("non-fib, non-numeric, and absent values → null", () => {
    expect(humanOverridePoints(row({ human_actual_points: "4" }))).toBeNull();
    expect(humanOverridePoints(row({ human_actual_points: "x" }))).toBeNull();
    expect(humanOverridePoints(row({ human_actual_points: "" }))).toBeNull();
    expect(humanOverridePoints(row())).toBeNull();
  });
});

describe("applyHumanOverride", () => {
  test("override rewrites tshirt/points/confidence and annotates rationale", () => {
    const r = row({ human_actual_points: "8" });
    const scored = applyHumanOverride(scoreRow(r, 2, []), r);
    expect(scored.points).toBe(8);
    expect(scored.proposed_tshirt).toBe("L");
    expect(scored.confidence).toBe("high");
    expect(scored.reasoning).toContain("human re-score override");
  });

  test("no column → scored result unchanged", () => {
    const r = row();
    const base = scoreRow(r, 2, []);
    expect(applyHumanOverride(base, r)).toEqual(base);
  });

  test("invalid value → scored result unchanged", () => {
    const r = row({ human_actual_points: "4" });
    const base = scoreRow(r, 2, []);
    expect(applyHumanOverride(base, r)).toEqual(base);
  });

  test("corpus entry carries the overridden points", () => {
    const r = row({ human_actual_points: "13" });
    const entry = buildCorpusEntry(r, applyHumanOverride(scoreRow(r, 2, []), r));
    expect(entry.points).toBe(13);
    expect(entry.tshirt).toBe("XL");
    expect(entry.confidence).toBe("high");
  });
});

describe("parseCsv carries the extra column", () => {
  test("human_actual_points survives CSV parsing", () => {
    const csv = [
      `"ticket_id","title","state","closed_at","pr_number","additions","deletions","changed_files","human_actual_points"`,
      `"CTL-9","t","Done","2026-06-01T00:00:00Z","1","10","5","2","5"`,
    ].join("\n");
    const rows = parseCsv(csv);
    expect(rows[0].human_actual_points).toBe("5");
  });
});
