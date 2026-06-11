// worker-now-data.test.ts — units for the worker-detail v2 "Now" headline + the
// cost+tokens chart series shaping (CTL-925 / WORKER-DETAIL v2 Pass A). Pure
// module — no DOM (mirrors worker-burn-data.test.ts / live-tail-data.test.ts).
// Run from ui:  cd ui && bun test src/board/worker-now-data.test.ts
import { describe, it, expect } from "bun:test";
import {
  shortenArg,
  latestEvent,
  deriveNowHeadline,
  buildBurnChartData,
  burnSeriesHasData,
  fmtBucketLabel,
  NOW_ARG_MAX,
} from "./worker-now-data";
import type { StreamEvent } from "@/lib/types";
import type { WorkerBurnSeries } from "./worker-burn-data";

function ev(over: Partial<StreamEvent> & Pick<StreamEvent, "type">): StreamEvent {
  return { ts: 1781120897751, ...over };
}

describe("shortenArg", () => {
  it("collapses whitespace to a single readable line", () => {
    expect(shortenArg("bun test\n  --foo\tbar")).toBe("bun test --foo bar");
  });

  it("trims to NOW_ARG_MAX with an ellipsis", () => {
    const long = "x".repeat(NOW_ARG_MAX + 50);
    const out = shortenArg(long);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(NOW_ARG_MAX);
    expect(out!.endsWith("…")).toBe(true);
  });

  it("returns null for null / empty / whitespace-only input (never a fake arg)", () => {
    expect(shortenArg(null)).toBeNull();
    expect(shortenArg(undefined)).toBeNull();
    expect(shortenArg("   \n\t ")).toBeNull();
  });
});

describe("latestEvent", () => {
  it("returns the newest (last) buffer row, or null when empty", () => {
    expect(latestEvent([])).toBeNull();
    const a = ev({ type: "turn" });
    const b = ev({ type: "tool_start", tool: "Read" });
    expect(latestEvent([a, b])).toBe(b);
  });
});

describe("deriveNowHeadline", () => {
  it("empty buffer → the honest `none` headline (no fabricated action)", () => {
    const h = deriveNowHeadline([]);
    expect(h.kind).toBe("none");
    expect(h.label).toBe("");
    expect(h.ts).toBeNull();
  });

  it("tool_start → ▶ <tool> · <short arg>", () => {
    const h = deriveNowHeadline([
      ev({ type: "tool_start", tool: "Bash", toolInput: "grep -n foo\n  bar.ts" }),
    ]);
    expect(h.kind).toBe("tool");
    expect(h.glyph).toBe("▶");
    expect(h.label).toBe("Bash");
    expect(h.detail).toBe("grep -n foo bar.ts");
  });

  it("reasoning → ◌ thinking…", () => {
    const h = deriveNowHeadline([ev({ type: "reasoning", text: "" })]);
    expect(h.kind).toBe("thinking");
    expect(h.glyph).toBe("◌");
    expect(h.label).toBe("thinking…");
  });

  it("turn → ↻ new turn · joined tools", () => {
    const h = deriveNowHeadline([ev({ type: "turn", turnTools: ["Bash", "Read"] })]);
    expect(h.kind).toBe("turn");
    expect(h.glyph).toBe("↻");
    expect(h.detail).toBe("Bash, Read");
  });

  it("result → ✓ complete", () => {
    const h = deriveNowHeadline([ev({ type: "result" })]);
    expect(h.kind).toBe("result");
    expect(h.glyph).toBe("✓");
    expect(h.label).toBe("complete");
  });

  it("retry → ⚠ retry n/m with the error detail", () => {
    const h = deriveNowHeadline([
      ev({ type: "retry", retryInfo: { attempt: 2, maxRetries: 5, error: "overloaded" } }),
    ]);
    expect(h.kind).toBe("retry");
    expect(h.label).toBe("retry 2/5");
    expect(h.detail).toBe("overloaded");
  });

  it("uses the MOST-RECENT event (last row wins)", () => {
    const h = deriveNowHeadline([
      ev({ type: "tool_start", tool: "Read" }),
      ev({ type: "result", ts: 1781120900000 }),
    ]);
    expect(h.kind).toBe("result");
    expect(h.ts).toBe(1781120900000);
  });
});

describe("fmtBucketLabel", () => {
  it("formats an epoch-second bucket as zero-padded HH:MM", () => {
    const epoch = Math.floor(new Date(2026, 0, 1, 9, 5, 0).getTime() / 1000);
    expect(fmtBucketLabel(epoch)).toBe("09:05");
  });
});

describe("buildBurnChartData", () => {
  it("null series → empty rows", () => {
    expect(buildBurnChartData(null)).toEqual([]);
  });

  it("zips cost + tokens on shared buckets, sorted by t", () => {
    const series: WorkerBurnSeries = {
      cost: [
        [200, 0.05],
        [100, 0.01],
      ],
      tokens: [
        [100, 1000],
        [200, 5000],
      ],
      tokensByType: {},
      activeSeconds: [],
    };
    const rows = buildBurnChartData(series);
    expect(rows.map((r) => r.t)).toEqual([100, 200]);
    expect(rows[0].cost).toBe(0.01);
    expect(rows[0].tokens).toBe(1000);
    expect(rows[1].cost).toBe(0.05);
    expect(rows[1].tokens).toBe(5000);
  });

  it("a bucket present in only one series gets null for the other (never fabricated)", () => {
    const series: WorkerBurnSeries = {
      cost: [[100, 0.01]],
      tokens: [[200, 5000]],
      tokensByType: {},
      activeSeconds: [],
    };
    const rows = buildBurnChartData(series);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ t: 100, cost: 0.01, tokens: null });
    expect(rows[1]).toMatchObject({ t: 200, cost: null, tokens: 5000 });
  });

  it("drops non-finite points defensively", () => {
    const series: WorkerBurnSeries = {
      cost: [[100, Number.NaN], [200, 0.02]],
      tokens: [],
      tokensByType: {},
      activeSeconds: [],
    };
    const rows = buildBurnChartData(series);
    expect(rows.map((r) => r.t)).toEqual([200]);
  });
});

describe("burnSeriesHasData", () => {
  it("null / all-zero series → false (degrades to honest empty)", () => {
    expect(burnSeriesHasData(null)).toBe(false);
    expect(
      burnSeriesHasData({ cost: [[100, 0]], tokens: [[100, 0]], tokensByType: {}, activeSeconds: [] }),
    ).toBe(false);
  });

  it("any positive cost OR tokens point → true", () => {
    expect(
      burnSeriesHasData({ cost: [[100, 0.01]], tokens: [], tokensByType: {}, activeSeconds: [] }),
    ).toBe(true);
    expect(
      burnSeriesHasData({ cost: [], tokens: [[100, 5]], tokensByType: {}, activeSeconds: [] }),
    ).toBe(true);
  });
});
