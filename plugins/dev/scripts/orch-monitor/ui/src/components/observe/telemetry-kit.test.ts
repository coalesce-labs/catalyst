// telemetry-kit.test.ts — units for the OBS-6 TELEMETRY pure logic:
//   1. heroState         — the FLOWING/QUIET/ERRORING/DARK state machine
//   2. freshnessLabel / errorRateLabel — the hero copy formatters
//   3. tail-group        — bucketing, filtering, error detection
//
// All pure (no React render), so they run under the ui package's `bun test`:
//   cd ui && bun test src/components/observe/telemetry-kit.test.ts
import { describe, it, expect } from "bun:test";
import type { TailRow } from "@/lib/types";
import {
  heroState,
  freshnessLabel,
  errorRateLabel,
  errorChipCopy,
  isReconnecting,
  HERO_TONE,
  FRESHNESS_FLOWING_MS,
  MIN_ERRORS_FOR_RED,
} from "./hero-state";
import {
  isErrorRow,
  filterTailRows,
  groupTailByWorker,
  bucketKeyFactory,
  distinctEventTypes,
  UNATTRIBUTED_KEY,
  EMPTY_TAIL_FILTER,
  type TailWorkerRef,
} from "./tail-group";

// ── row factory ──────────────────────────────────────────────────────────────
function row(over: Partial<TailRow> = {}): TailRow {
  return {
    ts: 1_000,
    eventName: "claude_code.tool_result",
    toolName: "Bash",
    toolInput: null,
    durationMs: 1200,
    costUsd: null,
    tokens: null,
    model: null,
    success: true,
    sessionId: null,
    linearKey: null,
    ...over,
  };
}

describe("heroState — the 4-state hero machine (CTL-1039 proportional)", () => {
  it("DARK when not configured (no-stack install)", () => {
    expect(
      heroState({ lokiSeverity: "up", configured: false, freshnessMs: 1000, errorRate: 0 }),
    ).toBe("DARK");
  });

  it("DARK when Loki severity is down (≥3 consecutive failures)", () => {
    expect(
      heroState({ lokiSeverity: "down", freshnessMs: 1000, errorRate: 0 }),
    ).toBe("DARK");
  });

  it("ERRORING when rate > 2% AND ≥ MIN_ERRORS_FOR_RED errors in last 15m", () => {
    expect(
      heroState({
        lokiSeverity: "up",
        freshnessMs: 1000,
        errorRate: 0.05,
        errorCount15m: MIN_ERRORS_FOR_RED,
      }),
    ).toBe("ERRORING");
  });

  it("NOT ERRORING for 1 error / 50 req (2%) — only one error → NOTED/FLOWING", () => {
    // 1 error / 50 requests = 2% rate but only ONE error → red criteria unmet.
    expect(
      heroState({
        lokiSeverity: "up",
        freshnessMs: 1000,
        errorRate: 1 / 50,
        errorCount15m: 1,
      }),
    ).not.toBe("ERRORING");
  });

  it("a degraded severity does NOT make the hero DARK (the proportional fix)", () => {
    // 1-2 failures / slow probe → quiet reconnecting hint; the hero keeps its
    // last data-driven state (here FLOWING), never DARK.
    expect(
      heroState({ lokiSeverity: "degraded", freshnessMs: 2_000, errorRate: 0 }),
    ).toBe("FLOWING");
    expect(isReconnecting("degraded")).toBe(true);
    expect(isReconnecting("down")).toBe(false);
  });

  it("reachability fault (down) wins over a high error-rate (DARK, not ERRORING)", () => {
    expect(
      heroState({
        lokiSeverity: "down",
        freshnessMs: 1000,
        errorRate: 0.9,
        errorCount15m: 100,
      }),
    ).toBe("DARK");
  });

  it("FLOWING when fresh (≤60s) and sub-threshold errors", () => {
    expect(
      heroState({ lokiSeverity: "up", freshnessMs: 4_000, errorRate: 0.004 }),
    ).toBe("FLOWING");
  });

  it("FLOWING exactly at the freshness threshold", () => {
    expect(
      heroState({ lokiSeverity: "up", freshnessMs: FRESHNESS_FLOWING_MS, errorRate: 0 }),
    ).toBe("FLOWING");
  });

  it("QUIET when reachable but no recent events (freshness null) — NOT an error", () => {
    expect(
      heroState({ lokiSeverity: "up", freshnessMs: null, errorRate: null }),
    ).toBe("QUIET");
  });

  it("QUIET when reachable but events are stale (> 60s)", () => {
    expect(
      heroState({ lokiSeverity: "up", freshnessMs: 300_000, errorRate: 0 }),
    ).toBe("QUIET");
  });

  it("optimistic (not DARK) while the probe is unresolved (lokiSeverity null)", () => {
    expect(
      heroState({ lokiSeverity: null, freshnessMs: 2_000, errorRate: 0 }),
    ).toBe("FLOWING");
  });

  it("QUIET maps to a NEUTRAL tone (never amber — §5 violation #1)", () => {
    expect(HERO_TONE.QUIET).toBe("neutral");
    expect(HERO_TONE.DARK).toBe("stale");
    expect(HERO_TONE.FLOWING).toBe("ok");
    expect(HERO_TONE.ERRORING).toBe("err");
  });
});

describe("errorChipCopy — NOTED neutral chip with EXPLICIT windows", () => {
  it("0 errors today → '0 errors today'", () => {
    expect(errorChipCopy(0, 0)).toBe("0 errors today");
  });
  it("1 error today, none in 15m → '1 error today'", () => {
    expect(errorChipCopy(1, 0)).toBe("1 error today");
  });
  it("N errors today, none in 15m → 'N errors today'", () => {
    expect(errorChipCopy(4, 0)).toBe("4 errors today");
  });
  it("N today with M in last 15m → states BOTH windows", () => {
    expect(errorChipCopy(5, 2)).toBe("5 errors today · 2 in last 15m");
  });
  it("every copy names its window ('today' / 'last 15m')", () => {
    expect(errorChipCopy(3, 1)).toContain("today");
    expect(errorChipCopy(3, 1)).toContain("last 15m");
  });
});

describe("hero copy formatters", () => {
  it("freshnessLabel: seconds / minutes / hours / unknown", () => {
    expect(freshnessLabel(4_000)).toBe("4s ago");
    expect(freshnessLabel(90_000)).toBe("2m ago"); // 90s → 1.5m → rounds to 2m
    expect(freshnessLabel(120_000)).toBe("2m ago");
    expect(freshnessLabel(3_600_000)).toBe("1h ago"); // 60m → rolls over to hours
    expect(freshnessLabel(7_200_000)).toBe("2h ago");
    expect(freshnessLabel(null)).toBe("—");
  });

  it("errorRateLabel: one decimal percent, null → 0%", () => {
    expect(errorRateLabel(0.004)).toBe("0.4%");
    expect(errorRateLabel(0.025)).toBe("2.5%");
    expect(errorRateLabel(0)).toBe("0.0%");
    expect(errorRateLabel(null)).toBe("0%");
  });
});

describe("isErrorRow", () => {
  it("flags api_error events", () => {
    expect(isErrorRow(row({ eventName: "claude_code.api_error" }))).toBe(true);
  });
  it("flags explicit success === false", () => {
    expect(isErrorRow(row({ eventName: "claude_code.tool_result", success: false }))).toBe(true);
  });
  it("a normal successful row is not an error", () => {
    expect(isErrorRow(row({ success: true }))).toBe(false);
  });
});

describe("groupTailByWorker", () => {
  const workers: TailWorkerRef[] = [
    { sessionId: "sess-a", ticket: "CTL-928", phase: "plan", name: "CTL-928:1" },
    { sessionId: "sess-b", ticket: "CTL-865", phase: "implement", name: "CTL-865:2" },
  ];

  it("buckets rows under their worker by sessionId join", () => {
    const groups = groupTailByWorker(
      [
        row({ sessionId: "sess-a", ts: 3 }),
        row({ sessionId: "sess-b", ts: 2 }),
        row({ sessionId: "sess-a", ts: 1 }),
      ],
      workers,
    );
    const a = groups.find((g) => g.key === "sess-a");
    expect(a?.label).toBe("CTL-928·plan");
    expect(a?.workerName).toBe("CTL-928:1");
    expect(a?.rows).toHaveLength(2);
  });

  it("collapses unknown / absent sessions into ONE unattributed bucket, sorted last", () => {
    const groups = groupTailByWorker(
      [
        row({ sessionId: "unknown-x" }),
        row({ sessionId: null }),
        row({ sessionId: "sess-a" }),
      ],
      workers,
    );
    expect(groups[groups.length - 1]!.key).toBe(UNATTRIBUTED_KEY);
    const unattr = groups.find((g) => g.key === UNATTRIBUTED_KEY);
    expect(unattr?.rows).toHaveLength(2); // both un-joinable rows, none dropped
    expect(unattr?.workerName).toBeNull();
  });

  it("never drops a row (every input row lands in some bucket)", () => {
    const input = [row({ sessionId: "sess-a" }), row({ sessionId: "zzz" }), row({ sessionId: null })];
    const groups = groupTailByWorker(input, workers);
    const total = groups.reduce((n, g) => n + g.rows.length, 0);
    expect(total).toBe(input.length);
  });
});

describe("filterTailRows", () => {
  const workers: TailWorkerRef[] = [
    { sessionId: "sess-a", ticket: "CTL-928", phase: "plan", name: "CTL-928:1" },
  ];
  const keyOf = bucketKeyFactory(workers);
  const rows = [
    row({ sessionId: "sess-a", eventName: "claude_code.api_error", toolName: null, success: false }),
    row({ sessionId: "sess-a", eventName: "claude_code.tool_result", toolName: "Bash" }),
    row({ sessionId: "other", eventName: "claude_code.tool_result", toolName: "Read" }),
  ];

  it("no filter is a pass-through", () => {
    expect(filterTailRows(rows, EMPTY_TAIL_FILTER, keyOf)).toHaveLength(3);
  });

  it("errorsOnly keeps only error rows", () => {
    const out = filterTailRows(rows, { ...EMPTY_TAIL_FILTER, errorsOnly: true }, keyOf);
    expect(out).toHaveLength(1);
    expect(out[0]!.eventName).toBe("claude_code.api_error");
  });

  it("worker filter keeps only that bucket's rows", () => {
    const out = filterTailRows(rows, { ...EMPTY_TAIL_FILTER, worker: "sess-a" }, keyOf);
    expect(out).toHaveLength(2);
  });

  it("tool filter keeps only that tool", () => {
    const out = filterTailRows(rows, { ...EMPTY_TAIL_FILTER, tool: "Read" }, keyOf);
    expect(out).toHaveLength(1);
    expect(out[0]!.toolName).toBe("Read");
  });

  it("axes AND together", () => {
    const out = filterTailRows(
      rows,
      { ...EMPTY_TAIL_FILTER, worker: "sess-a", errorsOnly: true },
      keyOf,
    );
    expect(out).toHaveLength(1);
  });
});

describe("distinctEventTypes", () => {
  it("returns sorted, deduped event names", () => {
    const out = distinctEventTypes([
      row({ eventName: "claude_code.tool_result" }),
      row({ eventName: "claude_code.api_request" }),
      row({ eventName: "claude_code.tool_result" }),
      row({ eventName: null }),
    ]);
    expect(out).toEqual(["claude_code.api_request", "claude_code.tool_result"]);
  });
});
