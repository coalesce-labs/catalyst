// sdk-slot-gate.test.mjs — CTL-1367 P1: the SDK slot-gate / triage-budget
// occupancy accounting.
//
// Run: cd plugins/dev/scripts/execution-core && bun test sdk-slot-gate.test.mjs
//
// Under executor=sdk a phase worker runs as an in-process query() with NO
// `claude --bg` job, so it is invisible to the bg liveness count that the
// scheduler slot gate and the monitor →Triage budget derive capacity from.
// Without counting it, a recorded SDK launch leaves the next tick/drain seeing
// ZERO occupied slots and admitting MORE tickets past maxParallel (each queuing
// behind the SDK semaphore). The fix adds the SDK occupancy (dispatched/running
// nested signals with no bg_job_id, via signal-reader:countSdkInflight) to the
// occupancy — GATED on dispatchMode === "sdk" so the bg/oneshot-legacy budget is
// byte-identical.
//
// This suite exercises the budget gating PURELY (all seams injected, no
// filesystem) so it is deterministic and CI-stable. The end-to-end schedulerTick
// + handleStateChangedEvent integrations live in the (CI-excluded) scheduler.test
// .mjs / monitor.test.mjs, mirroring how the rest of CTL-1367 P1 is tested.

import { describe, test, expect } from "bun:test";
import { computeTriageBudget } from "./monitor.mjs";

const seams = ({ live, sdk, maxParallel = 3, dispatchMode }) => ({
  orchDir: "/unused",
  concurrency: {},
  readMaxParallelFn: () => maxParallel,
  liveBackgroundCount: () => live,
  countSdkInflight: () => sdk,
  dispatchMode,
});

describe("computeTriageBudget — SDK occupancy gating (CTL-1367 P1)", () => {
  test("under dispatchMode=sdk, SDK in-flight workers consume budget", () => {
    // maxParallel 3, 0 bg jobs, 2 in-process SDK workers → 1 slot free.
    const b = computeTriageBudget(seams({ live: 0, sdk: 2, dispatchMode: "sdk" }));
    expect(b.remaining).toBe(1);
  });

  test("under dispatchMode=sdk, SDK occupancy can saturate the budget to 0", () => {
    const b = computeTriageBudget(seams({ live: 0, sdk: 3, dispatchMode: "sdk" }));
    expect(b.remaining).toBe(0);
  });

  test("under dispatchMode=sdk, SDK + bg occupancy both count", () => {
    // 1 bg + 1 SDK = 2 occupied of 3 → 1 free.
    const b = computeTriageBudget(seams({ live: 1, sdk: 1, dispatchMode: "sdk" }));
    expect(b.remaining).toBe(1);
  });

  test("never returns negative budget when over-occupied", () => {
    const b = computeTriageBudget(seams({ live: 2, sdk: 5, dispatchMode: "sdk", maxParallel: 3 }));
    expect(b.remaining).toBe(0);
  });

  // --- byte-identical bg path: countSdkInflight is NEVER consulted under bg ---

  test("under dispatchMode=phase-agents (bg), the SDK term is NOT added — budget is bg-only", () => {
    let sdkCalled = false;
    const b = computeTriageBudget({
      orchDir: "/unused",
      concurrency: {},
      readMaxParallelFn: () => 3,
      liveBackgroundCount: () => 1,
      countSdkInflight: () => { sdkCalled = true; return 99; },
      dispatchMode: "phase-agents",
    });
    expect(b.remaining).toBe(2); // 3 - 1 bg, SDK term ignored
    expect(sdkCalled).toBe(false); // provably not consulted under bg
  });

  test("default dispatchMode (omitted) behaves as bg — SDK term ignored", () => {
    let sdkCalled = false;
    const b = computeTriageBudget({
      orchDir: "/unused",
      concurrency: {},
      readMaxParallelFn: () => 3,
      liveBackgroundCount: () => 0,
      countSdkInflight: () => { sdkCalled = true; return 3; },
      // dispatchMode omitted → defaults to "phase-agents"
    });
    expect(b.remaining).toBe(3);
    expect(sdkCalled).toBe(false);
  });

  test("under dispatchMode=oneshot-legacy, the SDK term is NOT added", () => {
    let sdkCalled = false;
    const b = computeTriageBudget({
      orchDir: "/unused",
      concurrency: {},
      readMaxParallelFn: () => 2,
      liveBackgroundCount: () => 1,
      countSdkInflight: () => { sdkCalled = true; return 5; },
      dispatchMode: "oneshot-legacy",
    });
    expect(b.remaining).toBe(1);
    expect(sdkCalled).toBe(false);
  });
});
