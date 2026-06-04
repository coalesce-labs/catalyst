// autotune-decision.test.mjs — Phase 1 TDD for the pure auto-tuner decision core
// (CTL-684). All functions are seam-injected; no timers, fs, or real system load.
//
// Run: cd plugins/dev/scripts/execution-core && bun test autotune-decision.test.mjs

import { describe, test, expect } from "bun:test";
import {
  availableMemPct,
  sampleSystem,
  pushSample,
  detectTrend,
  memGuard,
  decideMaxParallel,
} from "./autotune.mjs";

// A realistic darwin vm_stat body — header carries the page size, every data
// line carries a TRAILING PERIOD (verified live). The label spellings match the
// macOS output exactly: "Pages free/inactive/speculative/purgeable".
function makeVmStat({ pageSize = 16384, free = 100, inactive = 200, speculative = 50, purgeable = 150 } = {}) {
  return [
    `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)`,
    `Pages free:                               ${free}.`,
    `Pages active:                           1509896.`,
    `Pages inactive:                         ${inactive}.`,
    `Pages speculative:                         ${speculative}.`,
    `Pages throttled:                              0.`,
    `Pages wired down:                        431514.`,
    `Pages purgeable:                          ${purgeable}.`,
  ].join("\n");
}

// --- availableMemPct (CTL-772) ----------------------------------------------

describe("availableMemPct", () => {
  test("darwin: sums free+inactive+speculative+purgeable pages × pageSize / total", () => {
    const total = 10e9;
    const pct = availableMemPct({
      freemem: () => 1, // must be IGNORED on the darwin parse path
      totalmem: () => total,
      platform: "darwin",
      execSync: () => makeVmStat({ pageSize: 16384, free: 100, inactive: 200, speculative: 50, purgeable: 150 }),
    });
    const expected = Math.round(((100 + 200 + 50 + 150) * 16384 / total) * 1000) / 10;
    expect(pct).toBe(expected);
  });

  test("non-darwin: returns freemem/totalmem pct identical to the old formula", () => {
    const pct = availableMemPct({
      freemem: () => 2e9,
      totalmem: () => 10e9,
      platform: "linux",
      execSync: () => { throw new Error("should not be called on linux"); },
    });
    expect(pct).toBe(20);
  });

  test("darwin + execSync throws → falls back to freemem pct, no throw", () => {
    let pct;
    expect(() => {
      pct = availableMemPct({
        freemem: () => 2e9,
        totalmem: () => 10e9,
        platform: "darwin",
        execSync: () => { throw new Error("spawn EAGAIN"); },
      });
    }).not.toThrow();
    expect(pct).toBe(20);
  });

  test("darwin + unparseable output (no page size / no Pages lines) → fallback to freemem pct, no throw", () => {
    let pct;
    expect(() => {
      pct = availableMemPct({
        freemem: () => 3e9,
        totalmem: () => 10e9,
        platform: "darwin",
        execSync: () => "garbage output with no recognizable fields",
      });
    }).not.toThrow();
    expect(pct).toBe(30);
  });

  test("darwin: tolerates trailing periods (parses the digits, not the period)", () => {
    const total = 16384 * 1000; // makes the math clean: 400 pages → 40%
    const pct = availableMemPct({
      freemem: () => 1,
      totalmem: () => total,
      platform: "darwin",
      execSync: () => makeVmStat({ pageSize: 16384, free: 100, inactive: 100, speculative: 100, purgeable: 100 }),
    });
    expect(pct).toBe(40);
  });

  test("darwin: missing Pages line counts as 0 (defensive, not an error)", () => {
    const out = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               100.",
      // no inactive/speculative/purgeable lines
    ].join("\n");
    const total = 16384 * 1000;
    const pct = availableMemPct({
      freemem: () => 999,
      totalmem: () => total,
      platform: "darwin",
      execSync: () => out,
    });
    // only free=100 counts → 100/1000 = 10%
    expect(pct).toBe(10);
  });
});

// --- sampleSystem darwin integration (CTL-772) ------------------------------

describe("sampleSystem (darwin vm_stat seam)", () => {
  test("platform:darwin + stubbed execSync → memFreePct from availableMemPct, load/core from their seams", () => {
    const total = 10e9;
    const s = sampleSystem({
      loadavg: () => [2.5, 3.0, 3.5],
      freemem: () => 1, // ignored on darwin parse path
      totalmem: () => total,
      cpus: () => Array(12),
      platform: "darwin",
      execSync: () => makeVmStat({ pageSize: 16384, free: 100, inactive: 200, speculative: 50, purgeable: 150 }),
    });
    const expectedMem = Math.round(((100 + 200 + 50 + 150) * 16384 / total) * 1000) / 10;
    expect(s.memFreePct).toBe(expectedMem);
    expect(s.load1).toBe(2.5);
    expect(s.load5).toBe(3.0);
    expect(s.load15).toBe(3.5);
    expect(s.coreCount).toBe(12);
  });

  test("keep-green default: NO platform/execSync seam + injected freemem/totalmem → freemem-derived memFreePct (holds even on a darwin host)", () => {
    const s = sampleSystem({
      loadavg: () => [0, 0, 0],
      freemem: () => 2e9,
      totalmem: () => 10e9,
      cpus: () => Array(4),
    });
    expect(s.memFreePct).toBe(20);
  });

  test("mem-critical still fires under genuine darwin pressure (tiny available pages)", () => {
    const total = 10e9;
    // tiny page counts → availBytes ≪ total → availableMemPct < criticalPct (5)
    const s = sampleSystem({
      loadavg: () => [1, 1, 1],
      freemem: () => total, // freemem would say "100% free" — proves the darwin path overrides it
      totalmem: () => total,
      cpus: () => Array(8),
      platform: "darwin",
      execSync: () => makeVmStat({ pageSize: 16384, free: 1, inactive: 1, speculative: 1, purgeable: 1 }),
    });
    expect(s.memFreePct).toBeLessThan(5);

    const window = [s, s, s];
    const { next, reason } = decideMaxParallel({
      window,
      concurrency: { maxParallel: 10, minParallel: 2, maxParallelCeiling: 20 },
      minSamples: 3,
      loadSafeFactor: 4,
      criticalPct: 5,
      warnPct: 20,
    });
    expect(reason).toBe("mem-critical");
    expect(next).toBe(2); // minParallel
  });
});

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

  test("trend-down AND mem warn AND current ABOVE floor → hold (growth suppressed)", () => {
    // current=10, minParallel=2 (well above floor) — existing behavior unchanged
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 10); // 10% free — warn range
    const result = decideMaxParallel({ window: w, concurrency, ...base });
    expect(result.next).toBe(10);
    expect(result.reason).toBe("mem-warn");
  });

  test("trend-down + mem-warn + current AT minParallel → increments by 1 (mem-warn-recovery)", () => {
    // current=2 (minParallel), mem=10% (warn), trend=down
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 10);
    const atFloor = { maxParallel: 2, minParallel: 2, maxParallelCeiling: 20 };
    const result = decideMaxParallel({ window: w, concurrency: atFloor, ...base });
    expect(result.next).toBe(3);
    expect(result.reason).toBe("mem-warn-recovery");
  });

  test("trend-down + mem-warn + current ABOVE minParallel → holds (existing mem-warn behavior)", () => {
    // current=10, minParallel=2, mem=10% (warn) — above floor, still holds
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 10);
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

  test("trend-down + mem-ok + layer1Max provided + current BELOW layer1Max → jumps to layer1Max", () => {
    // Simulates mem-critical recovery: current=1 (minParallel), layer1Max=4, mem=50% (ok)
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 50);
    const atFloor = { maxParallel: 1, minParallel: 1, maxParallelCeiling: 20 };
    const result = decideMaxParallel({ window: w, concurrency: atFloor, layer1Max: 4, ...base });
    expect(result.next).toBe(4);
    expect(result.reason).toBe("recovery-to-layer1");
  });

  test("trend-down + mem-ok + layer1Max provided + current EQUAL TO layer1Max → standard +1", () => {
    // Already at layer1Max — normal +1 increment applies
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 50);
    const atLayer1 = { maxParallel: 4, minParallel: 1, maxParallelCeiling: 20 };
    const result = decideMaxParallel({ window: w, concurrency: atLayer1, layer1Max: 4, ...base });
    expect(result.next).toBe(5);
    expect(result.reason).toBe("trend-down");
  });

  test("trend-down + mem-ok + layer1Max provided + current ABOVE layer1Max → standard +1", () => {
    // Layer-2 had written a value above Layer-1 — standard increment
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 50);
    const aboveLayer1 = { maxParallel: 6, minParallel: 1, maxParallelCeiling: 20 };
    const result = decideMaxParallel({ window: w, concurrency: aboveLayer1, layer1Max: 4, ...base });
    expect(result.next).toBe(7);
    expect(result.reason).toBe("trend-down");
  });

  test("trend-down + mem-ok + layer1Max=null → standard +1 (backwards compatible)", () => {
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 50);
    const result = decideMaxParallel({ window: w, concurrency, layer1Max: null, ...base });
    expect(result.next).toBe(11); // current=10, +1
    expect(result.reason).toBe("trend-down");
  });

  test("trend-down + mem-ok + layer1Max omitted → standard +1 (default null, backwards compatible)", () => {
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 50);
    const result = decideMaxParallel({ window: w, concurrency, ...base }); // no layer1Max key
    expect(result.next).toBe(11);
    expect(result.reason).toBe("trend-down");
  });

  test("layer1Max clamped to maxParallelCeiling even when layer1Max > ceiling", () => {
    const w = makeWindow([[2, 4, 6], [1, 3, 5], [1, 2, 4]], 50);
    const tight = { maxParallel: 1, minParallel: 1, maxParallelCeiling: 5 };
    const result = decideMaxParallel({ window: w, concurrency: tight, layer1Max: 40, ...base });
    expect(result.next).toBe(5); // ceiling clamps layer1Max=40 to 5
    expect(result.reason).toBe("recovery-to-layer1");
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
    for (const { w } of cases) {
      const { next } = decideMaxParallel({ window: w, concurrency, ...base });
      expect(next).toBeGreaterThanOrEqual(concurrency.minParallel);
      expect(next).toBeLessThanOrEqual(concurrency.maxParallelCeiling);
    }
  });

  // --- CTL-770: setpoint-seeking convergence ---------------------------------

  describe("setpoint convergence (CTL-770)", () => {
    // A flat-idle window: trend==="none" (no strict up/down), load well below
    // the cores×factor safe line. coreCount=4, loadSafeFactor=2 → threshold=8.
    const flatIdle = makeWindow([[1.2, 1.2, 1.3], [1.2, 1.3, 1.2], [1.3, 1.2, 1.2]], 50);

    test("flat-idle + mem-ok + setpoint + current<setpoint → converge-to-setpoint", () => {
      // current=1 below setpoint=6. This is exactly the case that returns 'hold'
      // today when setpoint is omitted.
      const atFloor = { maxParallel: 1, minParallel: 1, maxParallelCeiling: 20 };
      const result = decideMaxParallel({ window: flatIdle, concurrency: atFloor, setpoint: 6, ...base });
      expect(result.next).toBe(6);
      expect(result.reason).toBe("converge-to-setpoint");
    });

    test("without setpoint, the same flat-idle window still holds (no regression)", () => {
      const atFloor = { maxParallel: 1, minParallel: 1, maxParallelCeiling: 20 };
      const result = decideMaxParallel({ window: flatIdle, concurrency: atFloor, ...base });
      expect(result.next).toBe(1);
      expect(result.reason).toBe("hold");
    });

    test("cold-start seed: window < minSamples + mem-ok + setpoint + current<setpoint", () => {
      // Only 1 flat-low sample → fewer than minSamples=3. Seeds to the target.
      const oneSample = makeWindow([[1.2, 1.2, 1.3]], 50);
      const atFloor = { maxParallel: 1, minParallel: 1, maxParallelCeiling: 20 };
      const result = decideMaxParallel({ window: oneSample, concurrency: atFloor, setpoint: 6, ...base });
      expect(result.next).toBe(6);
      expect(result.reason).toBe("cold-start-seed");
    });

    test("cold-start seed does NOT fire when current already >= setpoint", () => {
      const oneSample = makeWindow([[1.2, 1.2, 1.3]], 50);
      const atTarget = { maxParallel: 6, minParallel: 1, maxParallelCeiling: 20 };
      const result = decideMaxParallel({ window: oneSample, concurrency: atTarget, setpoint: 6, ...base });
      expect(result.next).toBe(6);
      expect(result.reason).toBe("insufficient-samples");
    });

    test("empty window keeps insufficient-samples even with a setpoint (one tick delay)", () => {
      const atFloor = { maxParallel: 1, minParallel: 1, maxParallelCeiling: 20 };
      const result = decideMaxParallel({ window: [], concurrency: atFloor, setpoint: 6, ...base });
      expect(result.next).toBe(1);
      expect(result.reason).toBe("insufficient-samples");
    });

    test("deadband: current === setpoint, flat-idle → at-setpoint, no change, stable across ticks", () => {
      const atTarget = { maxParallel: 6, minParallel: 1, maxParallelCeiling: 20 };
      const r1 = decideMaxParallel({ window: flatIdle, concurrency: atTarget, setpoint: 6, ...base });
      expect(r1.next).toBe(6);
      expect(r1.reason).toBe("at-setpoint");
      // Re-decide with the same inputs → identical, no ±1 oscillation.
      const r2 = decideMaxParallel({ window: flatIdle, concurrency: atTarget, setpoint: 6, ...base });
      expect(r2.next).toBe(6);
      expect(r2.reason).toBe("at-setpoint");
    });

    test("never overshoots: setpoint=6, current=5 converge → next<=6 (never 7)", () => {
      const justBelow = { maxParallel: 5, minParallel: 1, maxParallelCeiling: 20 };
      const result = decideMaxParallel({ window: flatIdle, concurrency: justBelow, setpoint: 6, ...base });
      expect(result.next).toBe(6);
      expect(result.next).toBeLessThanOrEqual(6);
      expect(result.reason).toBe("converge-to-setpoint");
    });

    test("converge clamped to ceiling when setpoint exceeds it", () => {
      const tight = { maxParallel: 1, minParallel: 1, maxParallelCeiling: 4 };
      const result = decideMaxParallel({ window: flatIdle, concurrency: tight, setpoint: 6, ...base });
      expect(result.next).toBe(4); // ceiling clamps the jump
      expect(result.reason).toBe("converge-to-setpoint");
    });

    test("no convergence when load is NOT safe (load1 >= cores×factor) even below setpoint", () => {
      // cores=4, factor=2 → threshold=8; load1=9 not safe. Flat-high pattern.
      const flatHigh = makeWindow([[9, 9, 7], [9, 9, 11], [9, 10, 8]], 50);
      const atFloor = { maxParallel: 1, minParallel: 1, maxParallelCeiling: 20 };
      const result = decideMaxParallel({ window: flatHigh, concurrency: atFloor, setpoint: 6, ...base });
      // flat-high fires (both load1,load5 > threshold) → hold, NOT converge.
      expect(result.reason).toBe("flat-high");
      expect(result.next).toBe(1);
    });

    test("no-regression: trend-up still sheds even below the setpoint", () => {
      // current=10 above-floor, strict up-trend, setpoint=6 → must still shed,
      // never converge upward toward the setpoint.
      const up = makeWindow([[10, 8, 6], [12, 9, 7], [15, 11, 8]], 50);
      const result = decideMaxParallel({ window: up, concurrency, setpoint: 6, ...base });
      expect(result.next).toBe(Math.floor(10 * 0.75)); // 7
      expect(result.reason).toBe("trend-up");
    });

    test("no-regression: mem-critical still clamps to minParallel even with a setpoint", () => {
      const w = makeWindow([[1, 2, 4]], 2); // 2% free < critical
      const atFloor = { maxParallel: 1, minParallel: 1, maxParallelCeiling: 20 };
      const result = decideMaxParallel({ window: w, concurrency: atFloor, setpoint: 6, ...base });
      expect(result.next).toBe(1);
      expect(result.reason).toBe("mem-critical");
    });
  });
});
