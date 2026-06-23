// admission-state.test.mjs — CTL-1322. readAdmissionState truth table: the
// heartbeat admission block must mirror the scheduler's new-work gate exactly.
//
// Run: cd plugins/dev/scripts/execution-core && bun test admission-state.test.mjs

import { describe, test, expect } from "bun:test";
import { readAdmissionState } from "./admission-state.mjs";

// Build a readAdmissionState call with all four seams injected so no real
// subprocess / fs runs. `fresh`/`draining` drive the gate; `workers`/`maxParallel`
// drive the capacity values.
function resolve({ fresh, draining, workers = 0, maxParallel = 6 }) {
  return readAdmissionState({
    orchDir: "/tmp/ec",
    concurrency: {},
    agentsSnapshotFn: () => ({ isFresh: fresh, agents: [] }),
    isDrainingFn: () => draining,
    countWorkersFn: () => workers,
    maxParallelFn: () => maxParallel,
  });
}

describe("readAdmissionState (CTL-1322)", () => {
  test("fresh + not draining → accepting, no hold, capacity = maxParallel", () => {
    const a = resolve({ fresh: true, draining: false, workers: 2, maxParallel: 6 });
    expect(a.accepting).toBe(true);
    expect(a.holdReason).toBe(null);
    expect(a.effectiveCapacity).toBe(6);
    expect(a.activeWorkers).toBe(2);
  });

  test("draining → not accepting, holdReason=drain, effectiveCapacity=0", () => {
    const a = resolve({ fresh: true, draining: true, workers: 3, maxParallel: 6 });
    expect(a.accepting).toBe(false);
    expect(a.holdReason).toBe("drain");
    expect(a.effectiveCapacity).toBe(0);
    expect(a.activeWorkers).toBe(3); // still reports live workers while held
  });

  test("stale liveness (not draining) → not accepting, holdReason=liveness-cold, capacity=0", () => {
    const a = resolve({ fresh: false, draining: false, workers: 1, maxParallel: 6 });
    expect(a.accepting).toBe(false);
    expect(a.holdReason).toBe("liveness-cold");
    expect(a.effectiveCapacity).toBe(0);
  });

  test("draining + stale → holdReason=drain (drain takes precedence)", () => {
    const a = resolve({ fresh: false, draining: true, workers: 0, maxParallel: 6 });
    expect(a.accepting).toBe(false);
    expect(a.holdReason).toBe("drain");
    expect(a.effectiveCapacity).toBe(0);
  });

  test("activeWorkers reflects the live background count even at capacity", () => {
    const a = resolve({ fresh: true, draining: false, workers: 6, maxParallel: 6 });
    expect(a.activeWorkers).toBe(6);
    expect(a.accepting).toBe(true); // capacity is a ceiling, not free-slots — accepting stays true
  });

  test("shares a single agents snapshot between freshness and worker count", () => {
    let snapCalls = 0;
    const snap = { isFresh: true, agents: [{ kind: "background" }] };
    const a = readAdmissionState({
      orchDir: "/tmp/ec",
      agentsSnapshotFn: () => { snapCalls++; return snap; },
      isDrainingFn: () => false,
      countWorkersFn: ({ agents }) => agents.length, // receives the SAME snapshot's agents
      maxParallelFn: () => 4,
    });
    expect(snapCalls).toBe(1);
    expect(a.activeWorkers).toBe(1);
  });

  test("fail-safe: a null/empty snapshot reads as not-fresh → held, never throws", () => {
    const a = readAdmissionState({
      orchDir: "/tmp/ec",
      agentsSnapshotFn: () => null,
      isDrainingFn: () => false,
      countWorkersFn: () => 0,
      maxParallelFn: () => 6,
    });
    expect(a.accepting).toBe(false);
    expect(a.holdReason).toBe("liveness-cold");
  });
});
