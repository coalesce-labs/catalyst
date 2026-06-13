// capacity-timeline.test.ts — Phase 5 (CTL-1092). Pure transform:
// readCapacityHistory output → per-host stepped chart series.
//
// Run: cd ui && bun test src/components/observe/capacity-timeline.test.ts
import { describe, it, expect } from "bun:test";
import { toCapacitySteps } from "./capacity-timeline";

type CapStep = { ts: string; old: number; new: number; reason: string };

describe("toCapacitySteps", () => {
  it("converts history to per-host stepped series with value = new maxParallel", () => {
    const history: Record<string, CapStep[]> = {
      mini: [
        { ts: "2026-06-13T10:00:00Z", old: 4, new: 6, reason: "saturated-scale-up" },
        { ts: "2026-06-13T12:00:00Z", old: 6, new: 8, reason: "saturated-scale-up" },
      ],
    };
    const series = toCapacitySteps(history);
    expect(series.mini).toHaveLength(2);
    expect(series.mini[0]).toMatchObject({ ts: "2026-06-13T10:00:00Z", value: 6, old: 4, reason: "saturated-scale-up" });
    expect(series.mini[1].value).toBe(8);
    expect(series.mini[1].old).toBe(6);
  });

  it("empty history yields empty series (not an error)", () => {
    const series = toCapacitySteps({});
    expect(series).toEqual({});
  });

  it("single-step host renders a series of length 1", () => {
    const series = toCapacitySteps({
      mini: [{ ts: "2026-06-13T10:00:00Z", old: 4, new: 6, reason: "x" }],
    });
    expect(series.mini).toHaveLength(1);
    expect(series.mini[0].value).toBe(6);
  });

  it("multiple hosts each get their own series", () => {
    const series = toCapacitySteps({
      mini: [{ ts: "2026-06-13T10:00:00Z", old: 4, new: 6, reason: "up" }],
      laptop: [{ ts: "2026-06-13T11:00:00Z", old: 8, new: 4, reason: "dn" }],
    });
    expect(Object.keys(series).sort()).toEqual(["laptop", "mini"]);
    expect(series.laptop[0].value).toBe(4);
  });

  it("empty steps array for a host yields empty series (no crash)", () => {
    const series = toCapacitySteps({ mini: [] });
    expect(series.mini).toEqual([]);
  });
});
