// autotune-decision.test.mjs — Phase 1 TDD for the pure auto-tuner decision core
// (CTL-684). All functions are seam-injected; no timers, fs, or real system load.
//
// Run: cd plugins/dev/scripts/execution-core && bun test autotune-decision.test.mjs

import { describe, test, expect } from "bun:test";
import {
  sampleSystem,
  pushSample,
  detectTrend,
  memGuard,
  decideMaxParallel,
} from "./autotune.mjs";

// --- sampleSystem -----------------------------------------------------------

describe("sampleSystem", () => {
  test("returns load1/load5/load15 from injected loadavg seam", () => {
    const s = sampleSystem({
      loadavg: () => [8, 4, 2],
      freemem: () => 2e9,
      totalmem: () => 10e9,
      cpus: () => Array(12),
    });
    expect(s.load1).toBe(8);
    expect(s.load5).toBe(4);
    expect(s.load15).toBe(2);
  });

  test("computes memFreePct from freemem/totalmem", () => {
    const s = sampleSystem({
      loadavg: () => [0, 0, 0],
      freemem: () => 2e9,
      totalmem: () => 10e9,
      cpus: () => Array(4),
    });
    expect(s.memFreePct).toBe(20);
  });

  test("computes coreCount from cpus array length", () => {
    const s = sampleSystem({
      loadavg: () => [0, 0, 0],
      freemem: () => 8e9,
      totalmem: () => 16e9,
      cpus: () => Array(12),
    });
    expect(s.coreCount).toBe(12);
  });

  test("rounds memFreePct to one decimal place", () => {
    const s = sampleSystem({
      loadavg: () => [0, 0, 0],
      freemem: () => 1e9,
      totalmem: () => 3e9,
      cpus: () => Array(4),
    });
    expect(s.memFreePct).toBeCloseTo(33.3, 1);
  });
});

// --- pushSample -------------------------------------------------------------

describe("pushSample", () => {
  test("appends a sample to the window", () => {
    const w = pushSample([], { load1: 1, load5: 2, load15: 3, memFreePct: 50, coreCount: 4 }, 10);
    expect(w).toHaveLength(1);
    expect(w[0].load1).toBe(1);
  });

  test("trims to maxSamples (FIFO — oldest dropped)", () => {
    let w = [];
    for (let i = 0; i < 12; i++) {
      w = pushSample(w, { load1: i, load5: 0, load15: 0, memFreePct: 50, coreCount: 4 }, 10);
    }
    expect(w).toHaveLength(10);
    expect(w[0].load1).toBe(2); // oldest surviving = index 2
    expect(w[9].load1).toBe(11);
  });

  test("never mutates the input array", () => {
    const orig = [{ load1: 1, load5: 1, load15: 1, memFreePct: 50, coreCount: 4 }];
    const frozen = Object.freeze([...orig]);
    const w = pushSample(frozen, { load1: 2, load5: 2, load15: 2, memFreePct: 50, coreCount: 4 }, 10);
    expect(w).not.toBe(frozen);
    expect(frozen).toHaveLength(1);
  });

  test("length never exceeds maxSamples", () => {
    let w = [];
    for (let i = 0; i < 100; i++) {
      w = pushSample(w, { load1: i, load5: 0, load15: 0, memFreePct: 50, coreCount: 4 }, 5);
    }
    expect(w).toHaveLength(5);
  });
});

// --- detectTrend ------------------------------------------------------------

describe("detectTrend", () => {
  const minSamples = 3;
  const coreCount = 4;
  const loadSafeFactor = 2;

  function makeWindow(triples) {
    return triples.map(([load1, load5, load15]) => ({
      load1,
      load5,
      load15,
      memFreePct: 50,
      coreCount,
    }));
  }

  test("returns 'up' when last minSamples all have load1 > load5 > load15", () => {
    const w = makeWindow([
      [10, 8, 6],
      [12, 9, 7],
      [15, 11, 8],
    ]);
    expect(detectTrend(w, { minSamples, coreCount, loadSafeFactor })).toBe("up");
  });

  test("returns 'down' when last minSamples have load1 < load5 < load15 AND load1 < cores×factor", () => {
    const w = makeWindow([
      [2, 4, 6],
      [1, 3, 5],
      [1, 2, 4],
    ]);
    expect(detectTrend(w, { minSamples, coreCount, loadSafeFactor })).toBe("down");
  });

  test("down suppressed when load1 >= cores×factor even if strictly ordered", () => {
    // cores=4, factor=2 → threshold = 8; load1=9 → not safe
    const w = makeWindow([
      [9, 11, 13],
      [9, 10, 12],
      [9, 10, 11],
    ]);
    expect(detectTrend(w, { minSamples, coreCount, loadSafeFactor })).toBe("none");
  });

  test("returns 'flat-high' when load1 and load5 both exceed cores×factor but no trend", () => {
    const threshold = coreCount * loadSafeFactor; // 8
    const w = makeWindow([
      [threshold + 1, threshold + 1, threshold - 1],
      [threshold + 2, threshold + 1, threshold + 3],
      [threshold + 1, threshold + 2, threshold],
    ]);
    expect(detectTrend(w, { minSamples, coreCount, loadSafeFactor })).toBe("flat-high");
  });

  test("returns 'none' when fewer than minSamples exist", () => {
    const w = makeWindow([[10, 8, 6], [12, 9, 7]]);
    expect(detectTrend(w, { minSamples, coreCount, loadSafeFactor })).toBe("none");
  });

  test("returns 'none' when pattern is mixed (not consistently up or down)", () => {
    const w = makeWindow([
      [10, 8, 6],
      [5, 7, 9],
      [10, 8, 6],
    ]);
    expect(detectTrend(w, { minSamples, coreCount, loadSafeFactor })).toBe("none");
  });

  test("up uses only the last minSamples (ignores older contrary entries)", () => {
    const w = makeWindow([
      [2, 4, 6], // old — would be 'down'
      [10, 8, 6],
      [12, 9, 7],
      [15, 11, 8],
    ]);
    // With minSamples=3, only the last 3 matter → all up
    expect(detectTrend(w, { minSamples, coreCount, loadSafeFactor })).toBe("up");
  });
});

// --- memGuard ---------------------------------------------------------------

describe("memGuard", () => {
  const criticalPct = 5;
  const warnPct = 20;

  test("returns 'critical' when memFreePct < criticalPct", () => {
    expect(memGuard(3, { criticalPct, warnPct })).toBe("critical");
  });

  test("returns 'warn' when criticalPct <= memFreePct < warnPct", () => {
    expect(memGuard(10, { criticalPct, warnPct })).toBe("warn");
  });

  test("returns 'ok' when memFreePct >= warnPct", () => {
    expect(memGuard(20, { criticalPct, warnPct })).toBe("ok");
    expect(memGuard(50, { criticalPct, warnPct })).toBe("ok");
  });

  test("boundary: criticalPct exactly → warn (not critical)", () => {
    expect(memGuard(5, { criticalPct, warnPct })).toBe("warn");
  });

  test("boundary: warnPct exactly → ok (not warn)", () => {
    expect(memGuard(20, { criticalPct, warnPct })).toBe("ok");
  });
});

// --- decideMaxParallel ------------------------------------------------------

describe("decideMaxParallel", () => {
  const base = {
    minSamples: 3,
    loadSafeFactor: 2,
    criticalPct: 5,
    warnPct: 20,
  };
  const concurrency = { maxParallel: 10, minParallel: 2, maxParallelCeiling: 20 };

  function makeWindow(triples, memPct = 50) {
    return triples.map(([load1, load5, load15]) => ({
      load1,
      load5,
      load15,
      memFreePct: memPct,
      coreCount: 4,
    }));
  }

  test("mem-critical overrides any trend → drop to minParallel", () => {
    const w = makeWindow([[1, 2, 4]], 2); // 2% free < 5% critical
    const result = decideMaxParallel({ window: w, concurrency, ...base });
    expect(result.next).toBe(2);
    expect(result.reason).toBe("mem-critical");
  });

  test("trend-up → floor(current * 0.75)", () => {
    const w = makeWindow([[10, 8, 6], [12, 9, 7], [15, 11, 8]]);
    const result = decideMaxParallel({ window: w, concurrency, ...base });
    expect(result.next).toBe(Math.floor(10 * 0.75)); // 7
    expect(result.reason).toBe("trend-up");
  });

  test("trend-up shrink never below minParallel", () => {
    const tightConcurrency = { maxParallel: 2, minParallel: 2, maxParallelCeiling: 20 };
    const w = makeWindow([[10, 8, 6], [12, 9, 7], [15, 11, 8]]);
    const result = decideMaxParallel({ window: w, concurrency: tightConcurrency, ...base });
    expect(result.next).toBe(2); // floor(2 * 0.75) = 1 → clamped to 2
    expect(result.reason).toBe("trend-up");
  });

  test("trend-down AND mem ok → current + 1", () => {
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 50);
    const result = decideMaxParallel({ window: w, concurrency, ...base });
    expect(result.next).toBe(11);
    expect(result.reason).toBe("trend-down");
  });

  test("trend-down AND mem warn → hold (growth suppressed)", () => {
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 10); // 10% free — warn range
    const result = decideMaxParallel({ window: w, concurrency, ...base });
    expect(result.next).toBe(10);
    expect(result.reason).toBe("mem-warn");
  });

  test("flat-high → hold", () => {
    const threshold = 4 * 2; // 8
    const w = makeWindow([
      [threshold + 1, threshold + 1, threshold - 1],
      [threshold + 2, threshold + 1, threshold + 3],
      [threshold + 1, threshold + 2, threshold],
    ]);
    const result = decideMaxParallel({ window: w, concurrency, ...base });
    expect(result.next).toBe(10);
    expect(result.reason).toBe("flat-high");
  });

  test("< minSamples → insufficient-samples, hold", () => {
    const w = makeWindow([[2, 4, 6]]);
    const result = decideMaxParallel({ window: w, concurrency, ...base });
    expect(result.next).toBe(10);
    expect(result.reason).toBe("insufficient-samples");
  });

  test("empty window → insufficient-samples, hold", () => {
    const result = decideMaxParallel({ window: [], concurrency, ...base });
    expect(result.next).toBe(10);
    expect(result.reason).toBe("insufficient-samples");
  });

  test("otherwise (hold) when no pattern matches", () => {
    const w = makeWindow([[5, 5, 5], [5, 5, 5], [5, 5, 5]], 50);
    const result = decideMaxParallel({ window: w, concurrency, ...base });
    expect(result.next).toBe(10);
    expect(result.reason).toBe("hold");
  });

  test("trend-down growth never above maxParallelCeiling", () => {
    const atCeiling = { maxParallel: 20, minParallel: 2, maxParallelCeiling: 20 };
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 50);
    const result = decideMaxParallel({ window: w, concurrency: atCeiling, ...base });
    expect(result.next).toBe(20); // already at ceiling → clamped
    expect(result.reason).toBe("trend-down");
  });

  test("every branch result is within [minParallel, maxParallelCeiling]", () => {
    const cases = [
      { w: makeWindow([[1, 2, 4]], 2), label: "mem-critical" },
      { w: makeWindow([[10, 8, 6], [12, 9, 7], [15, 11, 8]]), label: "trend-up" },
      { w: makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 50), label: "trend-down" },
    ];
    for (const { w, label } of cases) {
      const { next } = decideMaxParallel({ window: w, concurrency, ...base });
      expect(next).toBeGreaterThanOrEqual(concurrency.minParallel);
      expect(next).toBeLessThanOrEqual(concurrency.maxParallelCeiling);
    }
  });
});
