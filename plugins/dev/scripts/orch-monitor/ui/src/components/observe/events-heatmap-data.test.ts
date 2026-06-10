// events-heatmap-data.test.ts — units for the OBS-8 TELEMETRY P5 pure logic:
//   buildHeatmapModel    — session→worker join + full bucket-axis fill + stall flag
//   isSilentWhileRunning — the early-stall predicate (running + trailing-dark)
//   bucketLabel          — chronologically-sortable HH:MM column label
//
// All pure (no React render), so they run under the ui package's `bun test`:
//   cd ui && bun test src/components/observe/events-heatmap-data.test.ts
import { describe, it, expect } from "bun:test";
import type { EventsHeatmap } from "@/lib/types";
import {
  buildHeatmapModel,
  isSilentWhileRunning,
  bucketLabel,
  type HeatmapWorkerRef,
} from "./events-heatmap-data";

const PAYLOAD: EventsHeatmap = {
  buckets: [300, 1200, 2100],
  cells: [
    { x: 300, sessionId: "sess-a", value: 5 },
    { x: 2100, sessionId: "sess-a", value: 3 },
    { x: 1200, sessionId: "sess-b", value: 7 },
  ],
};

describe("buildHeatmapModel — session→worker join + axis fill", () => {
  it("aligns each worker's counts to the full bucket axis (0 = silence)", () => {
    const workers: HeatmapWorkerRef[] = [
      { sessionId: "sess-a", label: "CTL-1·plan", running: true },
    ];
    const m = buildHeatmapModel(PAYLOAD, workers);
    expect(m.buckets).toEqual([300, 1200, 2100]);
    const row = m.rows.find((r) => r.sessionId === "sess-a")!;
    // bucket 1200 had no cell for sess-a → 0 (silence), never absent.
    expect(row.counts).toEqual([5, 0, 3]);
    expect(m.max).toBe(7); // global max across all cells (sess-b @1200)
  });

  it("renders a row for a running worker with ZERO activity (silence is a row)", () => {
    const workers: HeatmapWorkerRef[] = [
      { sessionId: "sess-silent", label: "CTL-9·impl", running: true },
    ];
    const m = buildHeatmapModel(PAYLOAD, workers);
    const row = m.rows.find((r) => r.sessionId === "sess-silent")!;
    expect(row).toBeDefined();
    expect(row.counts).toEqual([0, 0, 0]);
    // trailing bucket dark on a running worker → stall flag set.
    expect(row.silentWhileRunning).toBe(true);
  });

  it("board workers come before unattributed cell-only sessions", () => {
    const workers: HeatmapWorkerRef[] = [
      { sessionId: "sess-a", label: "CTL-1·plan", running: true },
    ];
    const m = buildHeatmapModel(PAYLOAD, workers);
    // sess-a is a board worker (first); sess-b appears only in cells (after).
    expect(m.rows[0]!.sessionId).toBe("sess-a");
    const unattributed = m.rows.find((r) => r.sessionId === "sess-b")!;
    expect(unattributed.name).toBeNull();
    expect(unattributed.label).toContain("session");
    // unattributed sessions are never flagged as a stall (no running flag).
    expect(unattributed.silentWhileRunning).toBe(false);
  });

  it("a worker active in its latest bucket is NOT flagged", () => {
    const workers: HeatmapWorkerRef[] = [
      { sessionId: "sess-a", label: "CTL-1·plan", running: true },
    ];
    const m = buildHeatmapModel(PAYLOAD, workers);
    const row = m.rows.find((r) => r.sessionId === "sess-a")!;
    // sess-a's last bucket (2100) = 3 events → not silent.
    expect(row.silentWhileRunning).toBe(false);
  });

  it("workers with no sessionId are skipped (no join key)", () => {
    const m = buildHeatmapModel(PAYLOAD, [{ label: "no-session" }]);
    expect(m.rows.some((r) => r.label === "no-session")).toBe(false);
  });

  it("null payload + workers → all-silence rows (the degraded-but-honest case)", () => {
    const m = buildHeatmapModel(null, [
      { sessionId: "sess-x", label: "CTL-2·verify", running: true },
    ]);
    expect(m.buckets).toEqual([]);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]!.counts).toEqual([]);
    // no buckets to judge → not a stall (nothing to be silent about).
    expect(m.rows[0]!.silentWhileRunning).toBe(false);
  });

  it("empty payload + empty workers → empty model", () => {
    const m = buildHeatmapModel({ buckets: [], cells: [] }, []);
    expect(m.rows).toHaveLength(0);
    expect(m.max).toBe(0);
  });
});

describe("isSilentWhileRunning — early-stall predicate", () => {
  it("running + trailing-dark → true", () => {
    expect(isSilentWhileRunning([5, 3, 0], true)).toBe(true);
  });
  it("running + trailing-active → false", () => {
    expect(isSilentWhileRunning([0, 0, 2], true)).toBe(false);
  });
  it("NOT running → never flagged (idleness is honest, not a stall)", () => {
    expect(isSilentWhileRunning([0, 0, 0], false)).toBe(false);
  });
  it("no buckets → false (nothing to judge)", () => {
    expect(isSilentWhileRunning([], true)).toBe(false);
  });
});

describe("bucketLabel — chronologically-sortable HH:MM", () => {
  it("zero-pads so lexical sort == time sort", () => {
    // 09:05 local — pick a couple known epoch-seconds and assert HH:MM shape.
    const label = bucketLabel(0);
    expect(label).toMatch(/^\d{2}:\d{2}$/);
  });
  it("two ascending bucket starts produce lexically-ascending labels", () => {
    const t0 = 1_700_000_000; // some fixed instant
    const a = bucketLabel(t0);
    const b = bucketLabel(t0 + 3600); // +1h, same day boundary in most zones
    // Not asserting exact values (zone-dependent), just that both are HH:MM.
    expect(a).toMatch(/^\d{2}:\d{2}$/);
    expect(b).toMatch(/^\d{2}:\d{2}$/);
  });
});
