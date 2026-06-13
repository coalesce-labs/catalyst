// autotune-capacity.test.mjs — CTL-1092. Verify appendCapacityChangedEvent seam
// fires alongside appendAdjustedEvent only when maxParallel changes.
//
// Run: cd plugins/dev/scripts/execution-core && bun test autotune-capacity.test.mjs

import { describe, test, expect } from "bun:test";
import { autoTuneTick } from "./autotune.mjs";

function makeState(overrides = {}) {
  return {
    window: [],
    windowSamples: 10,
    trendMinSamples: 3,
    loadSafeFactor: 4,
    criticalPct: 5,
    warnPct: 20,
    ...overrides,
  };
}

function makeSeams(overrides = {}) {
  return {
    liveBackgroundCount: () => 2,
    loadavg: () => [1, 2, 3],
    freemem: () => 8e9,
    totalmem: () => 10e9,
    cpus: () => Array(4),
    readConcurrency: () => ({ maxParallel: 10, minParallel: 2, maxParallelCeiling: 20 }),
    writeLayer2: () => true,
    appendSampledEvent: () => true,
    appendAdjustedEvent: () => true,
    appendCapacityChangedEvent: () => true,
    ...overrides,
  };
}

describe("appendCapacityChangedEvent seam (CTL-1092)", () => {
  test("fires alongside appendAdjustedEvent when maxParallel changes", () => {
    // Seed 2 up-trend samples; 3rd completes the trend → next !== current
    const upSamples = [
      { load1: 10, load5: 8, load15: 6, memFreePct: 50, coreCount: 4 },
      { load1: 12, load5: 9, load15: 7, memFreePct: 50, coreCount: 4 },
    ];
    const state = makeState({ window: upSamples });
    const capacityCalls = [];
    const adjustedCalls = [];
    const seams = makeSeams({
      loadavg: () => [15, 11, 8], // 3rd up-trend sample — completes minSamples=3
      readConcurrency: () => ({ maxParallel: 10, minParallel: 2, maxParallelCeiling: 20 }),
      writeLayer2: () => true,
      appendAdjustedEvent: (a) => { adjustedCalls.push(a); return true; },
      appendCapacityChangedEvent: (c) => { capacityCalls.push(c); return true; },
    });
    autoTuneTick(state, seams);
    // trend-up → next = floor(10 * 0.75) = 7 ≠ 10
    expect(adjustedCalls).toHaveLength(1);
    expect(adjustedCalls[0].oldMaxParallel).toBe(10);
    expect(adjustedCalls[0].newMaxParallel).toBe(7);

    expect(capacityCalls).toHaveLength(1);
    expect(capacityCalls[0].label).toBe("execution-core");
    expect(capacityCalls[0].oldMaxParallel).toBe(10);
    expect(capacityCalls[0].newMaxParallel).toBe(7);
    expect(capacityCalls[0].reason).toBe("trend-up");
  });

  test("does NOT fire appendCapacityChangedEvent when maxParallel is unchanged", () => {
    // Only 1 sample → insufficient-samples → hold → next === current
    const state = makeState({ window: [{ load1: 5, load5: 5, load15: 5, memFreePct: 50, coreCount: 4 }] });
    const capacityCalls = [];
    const seams = makeSeams({
      readConcurrency: () => ({ maxParallel: 10, minParallel: 2, maxParallelCeiling: 20 }),
      appendCapacityChangedEvent: (c) => { capacityCalls.push(c); return true; },
    });
    autoTuneTick(state, seams);
    expect(capacityCalls).toHaveLength(0);
  });

  test("a throwing appendCapacityChangedEvent does not propagate out of autoTuneTick", () => {
    const upSamples = [
      { load1: 10, load5: 8, load15: 6, memFreePct: 50, coreCount: 4 },
      { load1: 12, load5: 9, load15: 7, memFreePct: 50, coreCount: 4 },
    ];
    const state = makeState({ window: upSamples });
    const seams = makeSeams({
      loadavg: () => [15, 11, 8],
      readConcurrency: () => ({ maxParallel: 10, minParallel: 2, maxParallelCeiling: 20 }),
      appendCapacityChangedEvent: () => { throw new Error("io error"); },
    });
    expect(() => autoTuneTick(state, seams)).not.toThrow();
  });

  test("appendCapacityChangedEvent is independent of appendAdjustedEvent throwing", () => {
    const upSamples = [
      { load1: 10, load5: 8, load15: 6, memFreePct: 50, coreCount: 4 },
      { load1: 12, load5: 9, load15: 7, memFreePct: 50, coreCount: 4 },
    ];
    const state = makeState({ window: upSamples });
    const capacityCalls = [];
    const seams = makeSeams({
      loadavg: () => [15, 11, 8],
      readConcurrency: () => ({ maxParallel: 10, minParallel: 2, maxParallelCeiling: 20 }),
      appendAdjustedEvent: () => { throw new Error("adjusted fails"); },
      appendCapacityChangedEvent: (c) => { capacityCalls.push(c); return true; },
    });
    expect(() => autoTuneTick(state, seams)).not.toThrow();
    // Capacity seam must fire even when the adjusted seam threw
    expect(capacityCalls).toHaveLength(1);
  });
});
