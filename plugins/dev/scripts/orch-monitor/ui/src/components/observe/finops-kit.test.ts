// finops-kit.test.ts — units for the OBS-10 FINOPS pure logic (finops-panels.ts):
//   1. dollar / percent / multiplier formatters (the hero copy + dense rows)
//   2. delta semantics (null baseline → "—", never a fabricated 0%)
//   3. spend-bar shaping + spike count (the P-A chart data, spike flags preserved)
//
// All pure (no React render), so they run under the ui package's `bun test`:
//   cd ui && bun test src/components/observe/finops-kit.test.ts
import { describe, it, expect } from "bun:test";
import type { CostSeriesPoint } from "@/lib/types";
import {
  formatUsd,
  compactUsd,
  formatDeltaPercent,
  deltaPercentValue,
  formatMultiplier,
  hourLabel,
  toSpendBars,
  spikeCount,
} from "./finops-panels";

describe("formatUsd", () => {
  it("drops cents above $100 (a glance number)", () => {
    expect(formatUsd(469.85)).toBe("$470");
    expect(formatUsd(1323.27)).toBe("$1,323");
  });

  it("keeps one decimal in the $10–$100 band and two below $10", () => {
    expect(formatUsd(42.5)).toBe("$42.5");
    expect(formatUsd(7.03)).toBe("$7.03");
  });

  it("a thousands separator above 1000", () => {
    expect(formatUsd(5236.89)).toBe("$5,237");
  });

  it("non-finite → $0 (honest, never NaN)", () => {
    expect(formatUsd(NaN)).toBe("$0");
    expect(formatUsd(Infinity)).toBe("$0");
  });
});

describe("compactUsd", () => {
  it("compacts thousands and millions", () => {
    expect(compactUsd(1607.43)).toBe("$1.6k");
    expect(compactUsd(588)).toBe("$588");
    expect(compactUsd(22)).toBe("$22");
    expect(compactUsd(2_400_000)).toBe("$2.4M");
  });

  it("non-finite → $0", () => {
    expect(compactUsd(NaN)).toBe("$0");
  });
});

describe("formatDeltaPercent + deltaPercentValue", () => {
  it("signs a positive delta and rounds", () => {
    expect(formatDeltaPercent(0.384)).toBe("+38%");
    expect(deltaPercentValue(0.384)).toBe(38);
  });

  it("renders a negative delta without a + sign", () => {
    expect(formatDeltaPercent(-0.1034)).toBe("-10%");
    expect(deltaPercentValue(-0.1034)).toBe(-10);
  });

  it("null baseline → '—' string and undefined value (no fabricated 0%)", () => {
    expect(formatDeltaPercent(null)).toBe("—");
    expect(deltaPercentValue(null)).toBeUndefined();
  });

  it("non-finite → '—' / undefined", () => {
    expect(formatDeltaPercent(Infinity)).toBe("—");
    expect(deltaPercentValue(NaN)).toBeUndefined();
  });
});

describe("formatMultiplier", () => {
  it("renders the (Nx) suffix to one decimal", () => {
    expect(formatMultiplier(3.498)).toBe("3.5×");
    expect(formatMultiplier(4.1)).toBe("4.1×");
  });

  it("null → '' (dropped, never (NaN×) / fabricated (1×))", () => {
    expect(formatMultiplier(null)).toBe("");
    expect(formatMultiplier(Infinity)).toBe("");
  });
});

describe("toSpendBars + spikeCount", () => {
  const pts: CostSeriesPoint[] = [
    { t: 1781011878, usd: 41.4, isSpike: false },
    { t: 1781015478, usd: 110.97, isSpike: true },
    { t: 1781019078, usd: 5.44, isSpike: false },
  ];

  it("carries usd + the spike flag through to the bars", () => {
    const bars = toSpendBars(pts);
    expect(bars).toHaveLength(3);
    expect(bars[1]!.isSpike).toBe(true);
    expect(bars[1]!.usd).toBe(110.97);
    // the epoch-second key is preserved (the drill re-query key).
    expect(bars[1]!.t).toBe(1781015478);
  });

  it("adds an hh:00 label (local time)", () => {
    const bars = toSpendBars(pts);
    expect(bars[0]!.label).toMatch(/^\d{2}:00$/);
  });

  it("empty input → empty bars (no fabricated bar)", () => {
    expect(toSpendBars([])).toEqual([]);
  });

  it("spikeCount tallies only the flagged hours", () => {
    expect(spikeCount(pts)).toBe(1);
    expect(spikeCount([])).toBe(0);
  });
});

describe("hourLabel", () => {
  it("is a two-digit local hour ending in :00", () => {
    expect(hourLabel(1781015478)).toMatch(/^\d{2}:00$/);
  });
});
