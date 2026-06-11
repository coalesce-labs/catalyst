// observe-kit.test.ts — units for the OBS-2 panel honesty kit's two PURE
// decision functions:
//   1. resolveChartCardState — the 4-state honesty ladder (chart-card.tsx)
//   2. heatmapBucket          — the value→opacity-bucket ramp (calendar-heatmap.tsx)
//
// These imports pull in only the pure functions' module-local deps (cn, types),
// no React render, so they run under the ui package's `bun test`:
//   cd ui && bun test src/components/observe/observe-kit.test.ts
import { describe, it, expect } from "bun:test";
import type { OtelHealth } from "@/lib/types";
import {
  resolveChartCardState,
  dataSourceBackend,
} from "./chart-card";
import {
  heatmapBucket,
  HEATMAP_BUCKETS,
  HEATMAP_OPACITY_RAMP,
} from "./calendar-heatmap";

// Health-snapshot factory.
function health(overrides: Partial<{
  configured: boolean;
  prom: { url: string | null; reachable: boolean };
  loki: { url: string | null; reachable: boolean };
}> = {}): OtelHealth {
  return {
    configured: overrides.configured ?? true,
    prometheus: overrides.prom ?? { url: "http://prom:9090", reachable: true },
    loki: overrides.loki ?? { url: "http://loki:3100", reachable: true },
  };
}

describe("dataSourceBackend", () => {
  it("maps bracketed tags to the gating backend", () => {
    expect(dataSourceBackend("[prom]")).toBe("prometheus");
    expect(dataSourceBackend("[loki]")).toBe("loki");
    expect(dataSourceBackend("[board]")).toBe("board");
    expect(dataSourceBackend("[events]")).toBe("events");
  });

  it("prefers prometheus when a tag names both prom and loki", () => {
    expect(dataSourceBackend("[loki+prom]")).toBe("prometheus");
  });

  it("treats an unknown source as board (never gates on OTEL)", () => {
    expect(dataSourceBackend("[mystery]")).toBe("board");
  });
});

describe("resolveChartCardState — the 4-state honesty ladder", () => {
  // ── State 1: Unconfigured ──────────────────────────────────────────────
  it("(1) unconfigured: health.configured === false", () => {
    expect(
      resolveChartCardState({
        health: health({ configured: false }),
        dataSource: "[prom]",
      }),
    ).toBe("unconfigured");
  });

  it("(1) unconfigured: backend url absent even when configured", () => {
    expect(
      resolveChartCardState({
        health: health({ prom: { url: null, reachable: false } }),
        dataSource: "[prom]",
      }),
    ).toBe("unconfigured");
  });

  // ── State 2: Configured-but-unreachable ─────────────────────────────────
  it("(2) unreachable: backend has a url but reachable === false", () => {
    expect(
      resolveChartCardState({
        health: health({ prom: { url: "http://prom:9090", reachable: false } }),
        dataSource: "[prom]",
      }),
    ).toBe("unreachable");
  });

  it("(2) loki degrades independently of a healthy prometheus", () => {
    const h = health({ loki: { url: "http://loki:3100", reachable: false } });
    // loki panel → unreachable
    expect(resolveChartCardState({ health: h, dataSource: "[loki]" })).toBe(
      "unreachable",
    );
    // prom panel on the SAME snapshot → still live
    expect(resolveChartCardState({ health: h, dataSource: "[prom]" })).toBe(
      "live",
    );
  });

  // ── State 3: Reachable-but-empty ────────────────────────────────────────
  it("(3) empty: reachable backend but hasData === false", () => {
    expect(
      resolveChartCardState({
        health: health(),
        dataSource: "[loki]",
        hasData: false,
      }),
    ).toBe("empty");
  });

  // ── State 4: Live ───────────────────────────────────────────────────────
  it("(4) live: configured + reachable + hasData", () => {
    expect(
      resolveChartCardState({
        health: health(),
        dataSource: "[loki]",
        hasData: true,
      }),
    ).toBe("live");
  });

  it("(4) live by default when hasData is omitted", () => {
    expect(
      resolveChartCardState({ health: health(), dataSource: "[prom]" }),
    ).toBe("live");
  });

  // ── board/events never gate on OTEL health ──────────────────────────────
  it("board panels never read OTEL health (live even when stack is down)", () => {
    const dead = health({
      configured: false,
      prom: { url: null, reachable: false },
      loki: { url: null, reachable: false },
    });
    expect(resolveChartCardState({ health: dead, dataSource: "[board]" })).toBe(
      "live",
    );
    expect(
      resolveChartCardState({
        health: dead,
        dataSource: "[board]",
        hasData: false,
      }),
    ).toBe("empty");
  });

  // ── first-paint optimism: null health doesn't flash a degraded state ────
  it("null health resolves to live (no degraded flash before fetch resolves)", () => {
    expect(
      resolveChartCardState({ health: null, dataSource: "[prom]" }),
    ).toBe("live");
    expect(
      resolveChartCardState({
        health: null,
        dataSource: "[prom]",
        hasData: false,
      }),
    ).toBe("empty");
  });
});

describe("heatmapBucket — 5-level opacity ramp", () => {
  it("has a 5-level ramp", () => {
    expect(HEATMAP_BUCKETS).toBe(5);
    expect(HEATMAP_OPACITY_RAMP.length).toBe(5);
  });

  it("zero / non-positive value → bucket 0 (silence)", () => {
    expect(heatmapBucket(0, 100)).toBe(0);
    expect(heatmapBucket(-5, 100)).toBe(0);
  });

  it("guards a non-positive max → bucket 0 (no divide-by-zero)", () => {
    expect(heatmapBucket(5, 0)).toBe(0);
    expect(heatmapBucket(0, 0)).toBe(0);
  });

  it("value >= max → top bucket (4)", () => {
    expect(heatmapBucket(100, 100)).toBe(4);
    expect(heatmapBucket(150, 100)).toBe(4);
  });

  it("any positive value below max gets at least bucket 1 (never silently dropped)", () => {
    expect(heatmapBucket(1, 1000)).toBe(1);
    expect(heatmapBucket(0.0001, 1000)).toBe(1);
  });

  it("monotonic, non-decreasing across the range", () => {
    const max = 100;
    let prev = -1;
    for (let v = 0; v <= max; v += 5) {
      const b = heatmapBucket(v, max);
      expect(b).toBeGreaterThanOrEqual(prev);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(HEATMAP_BUCKETS - 1);
      prev = b;
    }
  });

  it("mid-range values land in the interior buckets {1,2,3}", () => {
    expect(heatmapBucket(50, 100)).toBeGreaterThanOrEqual(1);
    expect(heatmapBucket(50, 100)).toBeLessThanOrEqual(3);
    // a value just under max never reaches the top bucket (4 is reserved for >= max)
    expect(heatmapBucket(99, 100)).toBeLessThanOrEqual(3);
  });
});
