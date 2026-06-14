// telemetry-panels.test.ts — units for the OBS-7 TELEMETRY P2/P3/P4 pure logic:
//   P2 — clusterApiErrors / errorTrendSparkline
//   P3 — toolMixByTotalTime (the TOTAL-TIME sort, not call count)
//   helpers — compactCount / latencyLabel / errorPercentLabel / barPercent / maxModelP95
//
// All pure (no React render), so they run under the ui package's `bun test`:
//   cd ui && bun test src/components/observe/telemetry-panels.test.ts
import { describe, it, expect } from "bun:test";
import type { OtelLogEntry, ModelLatencyRow } from "@/lib/types";
import {
  clusterApiErrors,
  errorTrendSparkline,
  toolMixByTotalTime,
  compactCount,
  latencyLabel,
  errorPercentLabel,
  barPercent,
  maxModelP95,
} from "./telemetry-panels";

function entry(over: Partial<OtelLogEntry> & { body?: Record<string, unknown> } = {}): OtelLogEntry {
  const { body, ...rest } = over;
  return {
    timestamp: rest.timestamp ?? "1713100000000000000",
    line: body ? JSON.stringify(body) : (rest.line ?? "{}"),
    labels: rest.labels ?? {},
  };
}

describe("clusterApiErrors — P2", () => {
  it("clusters by (error string + model) and counts occurrences", () => {
    const out = clusterApiErrors([
      entry({ timestamp: "1", body: { error: "socket closed", model: "opus" } }),
      entry({ timestamp: "2", body: { error: "socket closed", model: "opus" } }),
      entry({ timestamp: "3", body: { error: "529 overloaded", model: "fable" } }),
    ]);
    // ranked by count desc → socket closed (×2) leads
    expect(out).toHaveLength(2);
    expect(out[0]!.error).toBe("socket closed");
    expect(out[0]!.model).toBe("opus");
    expect(out[0]!.count).toBe(2);
    expect(out[1]!.error).toBe("529 overloaded");
    expect(out[1]!.count).toBe(1);
  });

  it("same error on different models forms separate clusters", () => {
    const out = clusterApiErrors([
      entry({ body: { error: "timeout", model: "opus" } }),
      entry({ body: { error: "timeout", model: "haiku" } }),
    ]);
    expect(out).toHaveLength(2);
  });

  it("keeps the NEWEST line's request metadata for the drill modal", () => {
    const out = clusterApiErrors([
      entry({ timestamp: "100", body: { error: "e", model: "m", request_id: "old", session_id: "s1" } }),
      entry({ timestamp: "200", body: { error: "e", model: "m", request_id: "new", session_id: "s2", linear_key: "CTL-9" } }),
    ]);
    expect(out[0]!.requestId).toBe("new");
    expect(out[0]!.sessionId).toBe("s2");
    expect(out[0]!.linearKey).toBe("CTL-9");
    expect(out[0]!.lastSeen).toBe("200");
  });

  it("a line with no model clusters under 'unknown', never dropped", () => {
    const out = clusterApiErrors([entry({ body: { error: "boom" } })]);
    expect(out[0]!.model).toBe("unknown");
    expect(out[0]!.count).toBe(1);
  });

  it("a non-JSON line still clusters under its raw text (never crashes / never dropped)", () => {
    const out = clusterApiErrors([entry({ line: "not json at all" })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.error).toContain("not json");
  });

  it("reads the error string + model FROM THE STREAM LABELS (body is the event-name string)", () => {
    // The REAL catalyst-otel shape: body is "claude_code.api_error", the error
    // string + model are STREAM LABELS. Reading the body would cluster every error
    // under "claude_code.api_error" — the structured-metadata bug.
    const out = clusterApiErrors([
      entry({
        timestamp: "1",
        line: "claude_code.api_error",
        labels: { error: "Connection error.", model: "claude-sonnet-4-6" },
      }),
      entry({
        timestamp: "2",
        line: "claude_code.api_error",
        labels: { error: "Connection error.", model: "claude-sonnet-4-6", session_id: "s1", linear_key: "CTL-9" },
      }),
      entry({
        timestamp: "3",
        line: "claude_code.api_error",
        labels: { error: "529 overloaded", model: "claude-fable-5" },
      }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]!.error).toBe("Connection error.");
    expect(out[0]!.model).toBe("claude-sonnet-4-6");
    expect(out[0]!.count).toBe(2);
    // metadata lifted from labels too
    expect(out[0]!.sessionId).toBe("s1");
    expect(out[0]!.linearKey).toBe("CTL-9");
  });

  it("an empty input is an empty array (the ChartCard shows the empty state)", () => {
    expect(clusterApiErrors([])).toEqual([]);
  });
});

describe("errorTrendSparkline — P2 header trend", () => {
  it("empty entries → [] (the sparkline renders nothing)", () => {
    expect(errorTrendSparkline([])).toEqual([]);
  });

  it("buckets timestamps into a [epochSeconds, count] series summing to N entries", () => {
    const base = 1_713_100_000; // seconds
    const mk = (sec: number) => entry({ timestamp: String(sec * 1_000_000_000) });
    const pts = errorTrendSparkline(
      [mk(base), mk(base + 60), mk(base + 3600)],
      6,
    );
    expect(pts.length).toBe(6);
    const total = pts.reduce((n, [, c]) => n + c, 0);
    expect(total).toBe(3);
  });
});

describe("toolMixByTotalTime — P3 (TOTAL TIME, not call count)", () => {
  it("a slow tool used few times outranks a fast tool used many times", () => {
    const counts = { Bash: 100, Read: 1000 };
    const latency = {
      Bash: { p50Ms: 2000, p95Ms: 8000 }, // total = 100 × 8000 = 800_000
      Read: { p50Ms: 100, p95Ms: 300 }, //    total = 1000 × 300 = 300_000
    };
    const rows = toolMixByTotalTime(counts, latency);
    // Bash leads despite 10× fewer calls — the WHOLE point of the panel.
    expect(rows[0]!.tool).toBe("Bash");
    expect(rows[0]!.totalTimeMs).toBe(800_000);
    expect(rows[1]!.tool).toBe("Read");
  });

  it("a tool with no latency sample sorts last (totalTime 0) but is NEVER dropped", () => {
    const rows = toolMixByTotalTime(
      { Bash: 10, Mystery: 5 },
      { Bash: { p50Ms: 100, p95Ms: 500 } },
    );
    expect(rows.map((r) => r.tool)).toEqual(["Bash", "Mystery"]);
    const mystery = rows.find((r) => r.tool === "Mystery")!;
    expect(mystery.p95Ms).toBeNull();
    expect(mystery.totalTimeMs).toBe(0);
  });

  it("with no latency at all, falls back to count desc", () => {
    const rows = toolMixByTotalTime({ A: 3, B: 9, C: 1 }, {});
    expect(rows.map((r) => r.tool)).toEqual(["B", "A", "C"]);
  });
});

describe("formatters", () => {
  it("compactCount: thousands / millions / small", () => {
    expect(compactCount(10_100)).toBe("10.1k");
    expect(compactCount(4_400)).toBe("4.4k");
    expect(compactCount(950)).toBe("950");
    expect(compactCount(2_500_000)).toBe("2.5M");
  });

  it("latencyLabel: ms under 1s, seconds above, null → —", () => {
    expect(latencyLabel(320)).toBe("320ms");
    expect(latencyLabel(8200)).toBe("8.2s");
    expect(latencyLabel(null)).toBe("—");
  });

  it("errorPercentLabel: one-decimal percent, null → —", () => {
    expect(errorPercentLabel(0.003)).toBe("0.3%");
    expect(errorPercentLabel(0)).toBe("0.0%");
    expect(errorPercentLabel(null)).toBe("—");
  });

  it("barPercent: clamps to [0,100], guards divide-by-zero", () => {
    expect(barPercent(50, 100)).toBe(50);
    expect(barPercent(200, 100)).toBe(100);
    expect(barPercent(5, 0)).toBe(0);
    expect(barPercent(0, 100)).toBe(0);
  });

  it("maxModelP95: max p95 across rows, ignores null", () => {
    const rows: ModelLatencyRow[] = [
      { model: "a", p50Ms: 100, p95Ms: 400, requests: 1, errors: 0, errorRate: 0 },
      { model: "b", p50Ms: null, p95Ms: null, requests: 0, errors: 0, errorRate: null },
      { model: "c", p50Ms: 200, p95Ms: 9000, requests: 5, errors: 1, errorRate: 0.2 },
    ];
    expect(maxModelP95(rows)).toBe(9000);
  });
});
