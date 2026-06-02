// autotune-lifecycle.test.mjs — Phase 3 TDD for the side-car lifecycle (CTL-684).
// Run: cd plugins/dev/scripts/execution-core && bun test autotune-lifecycle.test.mjs

import { describe, test, expect } from "bun:test";
import {
  autoTuneTick,
  startAutoTuner,
  stopAutoTuner,
} from "./autotune.mjs";

// --- autoTuneTick -----------------------------------------------------------

describe("autoTuneTick", () => {
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
      ...overrides,
    };
  }

  test("when liveBackgroundCount() === 0 → no sampled event, no write, window reset", () => {
    const state = makeState({ window: [{ load1: 1, load5: 2, load15: 3, memFreePct: 50, coreCount: 4 }] });
    const sampledCalls = [];
    const writeCalls = [];
    const seams = makeSeams({
      liveBackgroundCount: () => 0,
      appendSampledEvent: (args) => { sampledCalls.push(args); return true; },
      writeLayer2: (v) => { writeCalls.push(v); return true; },
    });
    autoTuneTick(state, seams);
    expect(sampledCalls).toHaveLength(0);
    expect(writeCalls).toHaveLength(0);
    expect(state.window).toHaveLength(0); // reset
  });

  test("when active → exactly one appendSampledEvent with correct fields", () => {
    const state = makeState();
    const sampledCalls = [];
    const seams = makeSeams({
      liveBackgroundCount: () => 3,
      loadavg: () => [2.5, 3.0, 3.5],
      freemem: () => 5e9,
      totalmem: () => 10e9,
      cpus: () => Array(8),
      readConcurrency: () => ({ maxParallel: 12, minParallel: 2, maxParallelCeiling: 20 }),
      appendSampledEvent: (args) => { sampledCalls.push(args); return true; },
    });
    autoTuneTick(state, seams);
    expect(sampledCalls).toHaveLength(1);
    const call = sampledCalls[0];
    expect(call.load1).toBe(2.5);
    expect(call.load5).toBe(3.0);
    expect(call.load15).toBe(3.5);
    expect(call.bgCount).toBe(3);
    expect(call.maxParallelCurrent).toBe(12);
  });

  test("when active → state.window grows (trimmed to windowSamples)", () => {
    const state = makeState({ windowSamples: 3, window: [] });
    const seams = makeSeams();
    autoTuneTick(state, seams);
    expect(state.window).toHaveLength(1);
    autoTuneTick(state, seams);
    autoTuneTick(state, seams);
    autoTuneTick(state, seams);
    expect(state.window).toHaveLength(3); // trimmed
  });

  test("when decide returns next !== current → exactly one writeLayer2 AND one appendAdjustedEvent", () => {
    // Seed 2 up-trend samples; the seam provides a 3rd completing the trend.
    const upSamples = [
      { load1: 10, load5: 8, load15: 6, memFreePct: 50, coreCount: 4 },
      { load1: 12, load5: 9, load15: 7, memFreePct: 50, coreCount: 4 },
    ];
    const state = makeState({ window: upSamples });
    const writeCalls = [];
    const adjustedCalls = [];
    const seams = makeSeams({
      loadavg: () => [15, 11, 8], // 3rd up-trend sample — completes minSamples=3
      readConcurrency: () => ({ maxParallel: 10, minParallel: 2, maxParallelCeiling: 20 }),
      writeLayer2: (v) => { writeCalls.push(v); return true; },
      appendAdjustedEvent: (args) => { adjustedCalls.push(args); return true; },
    });
    autoTuneTick(state, seams);
    // trend-up → next = floor(10 * 0.75) = 7 ≠ 10
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).toBe(7);
    expect(adjustedCalls).toHaveLength(1);
    expect(adjustedCalls[0].oldMaxParallel).toBe(10);
    expect(adjustedCalls[0].newMaxParallel).toBe(7);
    expect(adjustedCalls[0].reason).toBe("trend-up");
  });

  test("when next === current → no writeLayer2, no appendAdjustedEvent", () => {
    // Only 1 sample → insufficient-samples → hold
    const state = makeState({ window: [{ load1: 5, load5: 5, load15: 5, memFreePct: 50, coreCount: 4 }] });
    const writeCalls = [];
    const adjustedCalls = [];
    const seams = makeSeams({
      readConcurrency: () => ({ maxParallel: 10, minParallel: 2, maxParallelCeiling: 20 }),
      writeLayer2: (v) => { writeCalls.push(v); return true; },
      appendAdjustedEvent: (args) => { adjustedCalls.push(args); return true; },
    });
    autoTuneTick(state, seams);
    expect(writeCalls).toHaveLength(0);
    expect(adjustedCalls).toHaveLength(0);
  });

  test("a throwing writeLayer2 does not propagate out of autoTuneTick", () => {
    const upSamples = [
      { load1: 10, load5: 8, load15: 6, memFreePct: 50, coreCount: 4 },
      { load1: 12, load5: 9, load15: 7, memFreePct: 50, coreCount: 4 },
    ];
    const state = makeState({ window: upSamples });
    const seams = makeSeams({
      loadavg: () => [15, 11, 8], // completes trend-up
      readConcurrency: () => ({ maxParallel: 10, minParallel: 2, maxParallelCeiling: 20 }),
      writeLayer2: () => { throw new Error("disk full"); },
    });
    expect(() => autoTuneTick(state, seams)).not.toThrow();
  });

  test("a throwing appendSampledEvent does not propagate out of autoTuneTick", () => {
    const state = makeState();
    const seams = makeSeams({
      appendSampledEvent: () => { throw new Error("io error"); },
    });
    expect(() => autoTuneTick(state, seams)).not.toThrow();
  });

  test("autoTuneTick passes layer1Max from readLayer1Concurrency to decideMaxParallel", () => {
    // Seed 2 down-trend samples; seam provides a 3rd completing the trend.
    // Layer-2 has maxParallel=1, Layer-1 has maxParallel=4, mem=ok → should jump to 4.
    const downSamples = [
      { load1: 2, load5: 4, load15: 6, memFreePct: 50, coreCount: 4 },
      { load1: 1, load5: 3, load15: 5, memFreePct: 50, coreCount: 4 },
    ];
    const state = makeState({ window: downSamples, trendMinSamples: 3 });
    const decisions = [];
    const seams = makeSeams({
      loadavg: () => [1, 2, 4], // 3rd down-trend sample (load1<load5<load15)
      freemem: () => 8e9,
      totalmem: () => 16e9,   // 50% free = ok
      cpus: () => Array(4),
      readConcurrency: () => ({ maxParallel: 1, minParallel: 1, maxParallelCeiling: 20 }),
      readLayer1Concurrency: () => ({ maxParallel: 4, minParallel: 1, maxParallelCeiling: 20 }),
      writeLayer2: (v) => { decisions.push(v); return true; },
    });
    autoTuneTick(state, seams);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toBe(4); // jumped to layer1Max, not 2
  });
});

// --- startAutoTuner / stopAutoTuner lifecycle --------------------------------

describe("startAutoTuner / stopAutoTuner", () => {
  test("startAutoTuner calls setIntervalFn once with the configured interval and returns a stop handle", () => {
    const intervals = [];
    const setIntervalFn = (fn, ms) => { intervals.push(ms); return "timer-handle"; };
    const clearIntervalFn = () => {};
    const stop = startAutoTuner({
      configPath: null,
      layer2Path: null,
      enabled: true,
      sampleIntervalMs: 5000,
      setIntervalFn,
      clearIntervalFn,
    });
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toBe(5000);
    expect(typeof stop).toBe("function");
    stop({ clearIntervalFn });
  });

  test("stopAutoTuner calls clearIntervalFn with the stored handle", () => {
    const cleared = [];
    const setIntervalFn = (fn, ms) => "my-timer";
    const clearIntervalFn = (h) => cleared.push(h);
    startAutoTuner({
      configPath: null,
      layer2Path: null,
      enabled: true,
      sampleIntervalMs: 1000,
      setIntervalFn,
      clearIntervalFn,
    });
    stopAutoTuner({ clearIntervalFn });
    expect(cleared).toContain("my-timer");
  });

  test("stopAutoTuner is idempotent (safe to call twice)", () => {
    const cleared = [];
    const setIntervalFn = () => "t2";
    const clearIntervalFn = (h) => cleared.push(h);
    startAutoTuner({
      configPath: null, layer2Path: null, enabled: true, sampleIntervalMs: 1000,
      setIntervalFn, clearIntervalFn,
    });
    stopAutoTuner({ clearIntervalFn });
    stopAutoTuner({ clearIntervalFn }); // second call should not throw
    expect(cleared).toHaveLength(1); // only one real clear
  });

  test("stopAutoTuner before start does not throw", () => {
    expect(() => stopAutoTuner({ clearIntervalFn: () => {} })).not.toThrow();
  });

  test("when EXECUTION_CORE_AUTOTUNE disabled → setIntervalFn is NOT called", () => {
    const intervals = [];
    const setIntervalFn = () => { intervals.push(true); return "t"; };
    startAutoTuner({
      configPath: null, layer2Path: null,
      enabled: false,
      sampleIntervalMs: 1000,
      setIntervalFn,
      clearIntervalFn: () => {},
    });
    expect(intervals).toHaveLength(0);
  });

  test("when disabled → returned stop handle is a no-op (does not throw)", () => {
    const stop = startAutoTuner({
      configPath: null, layer2Path: null,
      enabled: false,
      sampleIntervalMs: 1000,
      setIntervalFn: () => "t",
      clearIntervalFn: () => {},
    });
    expect(() => stop()).not.toThrow();
  });
});
