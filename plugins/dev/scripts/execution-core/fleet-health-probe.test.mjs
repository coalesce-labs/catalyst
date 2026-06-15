// fleet-health-probe.test.mjs — CTL-1165 D5. The pre-exhaustion fleet-health
// guardrail core: classifyFleetHealth (pure), the four safe()-wrapped signal
// reads with NON-CROSSING sentinels, single-event-per-breach emit, hysteresis
// re-arm, selfHealEnabled default-OFF, and the bounded ppid===1 node/bun child
// sweep. All dependencies injected; tick() called directly — no real timer,
// sysctl, ps, or kill. Mirrors memory-sampler.test.mjs.
//
// Run: cd plugins/dev/scripts/execution-core && bun test fleet-health-probe.test.mjs

import { test, expect, describe } from "bun:test";
import {
  classifyFleetHealth,
  startFleetHealthProbe,
  defaultReadSwapUsedMb,
  defaultTriggerSelfHeal,
} from "./fleet-health-probe.mjs";
import { FLEET_HEALTH_DEGRADED } from "./fleet-health-event.mjs";

// Recording fake clock — same shape as memory-sampler.test.mjs
function recordingClock() {
  const handle = { id: Symbol("interval") };
  let cleared = false;
  return {
    setInterval: () => handle,
    clearInterval: (h) => {
      if (h === handle) cleared = true;
    },
    handle,
    wasCleared: () => cleared,
  };
}

const THRESHOLDS = {
  jobsThreshold: 500,
  agentsThreshold: 12,
  procsThreshold: 40,
  swapUsedMbThreshold: 4096,
};

function baseConfig(over = {}) {
  return {
    enabled: true,
    intervalMs: 120_000,
    selfHealEnabled: false,
    sustainedTicks: 2,
    ...THRESHOLDS,
    ...over,
  };
}

// Build a probe harness with injected readers + spies.
function harness({
  config = baseConfig(),
  jobs = 0,
  agents = 0,
  procs = 0,
  swap = 0,
  throwAll = false,
} = {}) {
  const refs = { jobs, agents, procs, swap };
  const emitted = [];
  const selfHeals = [];
  const clock = recordingClock();
  const p = startFleetHealthProbe({
    clock,
    config,
    readJobsCount: () => {
      if (throwAll) throw new Error("jobs read failed");
      return refs.jobs;
    },
    listAgents: () => {
      if (throwAll) throw new Error("agents read failed");
      return Array.from({ length: refs.agents }, (_, i) => ({ pid: 100 + i }));
    },
    psLines: () => {
      if (throwAll) throw new Error("ps read failed");
      return Array.from({ length: refs.procs }, (_, i) => `${200 + i} 1 node`);
    },
    readSwapUsedMb: () => {
      if (throwAll) throw new Error("swap read failed");
      return refs.swap;
    },
    emit: (payload) => emitted.push(payload),
    triggerSelfHeal: () => selfHeals.push(Date.now()),
  });
  return { p, refs, emitted, selfHeals, clock };
}

// ─── classifyFleetHealth (pure) ──────────────────────────────────────────────

describe("classifyFleetHealth (pure)", () => {
  test("jobs over threshold → degraded, tripped=['jobs']", () => {
    const r = classifyFleetHealth(
      { jobsCount: 600, agentsCount: 1, procsCount: 1, swapUsedMb: 0 },
      THRESHOLDS,
    );
    expect(r.degraded).toBe(true);
    expect(r.tripped).toEqual(["jobs"]);
  });

  test("boundary jobsCount===threshold also degraded (>=)", () => {
    const r = classifyFleetHealth(
      { jobsCount: 500, agentsCount: 1, procsCount: 1, swapUsedMb: 0 },
      THRESHOLDS,
    );
    expect(r.degraded).toBe(true);
    expect(r.tripped).toContain("jobs");
  });

  test("all four signals can trip together (stable order)", () => {
    const r = classifyFleetHealth(
      { jobsCount: 600, agentsCount: 20, procsCount: 50, swapUsedMb: 5000 },
      THRESHOLDS,
    );
    expect(r.degraded).toBe(true);
    expect(r.tripped).toEqual(["jobs", "agents", "procs", "swap"]);
  });

  test("below all thresholds → not degraded, empty tripped", () => {
    const r = classifyFleetHealth(
      { jobsCount: 10, agentsCount: 1, procsCount: 1, swapUsedMb: 0 },
      THRESHOLDS,
    );
    expect(r.degraded).toBe(false);
    expect(r.tripped).toEqual([]);
  });

  test("null/sentinel readings never trip", () => {
    const r = classifyFleetHealth(
      { jobsCount: null, agentsCount: null, procsCount: null, swapUsedMb: 0 },
      THRESHOLDS,
    );
    expect(r.degraded).toBe(false);
    expect(r.tripped).toEqual([]);
  });
});

// ─── Probe tick behaviour ────────────────────────────────────────────────────

describe("startFleetHealthProbe tick", () => {
  test("threshold-cross emits exactly one event with all four readings + tripped + sustained_n=1", async () => {
    const { p, emitted } = harness({ jobs: 600, agents: 3, procs: 5, swap: 100 });
    await p.tick();
    expect(emitted.length).toBe(1);
    const e = emitted[0];
    expect(e.jobsCount).toBe(600);
    expect(e.agentsCount).toBe(3);
    expect(e.procsCount).toBe(5);
    expect(e.swapUsedMb).toBe(100);
    expect(e.tripped).toEqual(["jobs"]);
    expect(e.sustained_n).toBe(1);
  });

  test("below-threshold is silent (0 events, 0 self-heal, counter stays 0)", async () => {
    const { p, emitted, selfHeals } = harness({
      config: baseConfig({ selfHealEnabled: true }),
      jobs: 10,
      agents: 1,
      procs: 1,
      swap: 0,
    });
    await p.tick();
    await p.tick();
    expect(emitted.length).toBe(0);
    expect(selfHeals.length).toBe(0);
  });

  test("self-heal fires ONCE on sustained breach (sustainedTicks=2)", async () => {
    const { p, emitted, selfHeals } = harness({
      config: baseConfig({ selfHealEnabled: true, sustainedTicks: 2 }),
      jobs: 600,
    });
    await p.tick(); // sustained_n=1, below sustainedTicks
    expect(selfHeals.length).toBe(0);
    await p.tick(); // sustained_n=2 === sustainedTicks → fires once
    expect(selfHeals.length).toBe(1);
    await p.tick(); // sustained_n=3, already fired this episode → still 1
    await p.tick(); // sustained_n=4 → still 1
    expect(selfHeals.length).toBe(1);
    // every degraded tick still emits an event
    expect(emitted.length).toBe(4);
  });

  test("hysteresis re-arms only after a healthy tick", async () => {
    const { p, refs, selfHeals } = harness({
      config: baseConfig({ selfHealEnabled: true, sustainedTicks: 2 }),
      jobs: 600,
    });
    await p.tick(); // n=1
    await p.tick(); // n=2 → fire #1
    expect(selfHeals.length).toBe(1);
    // recover
    refs.jobs = 10;
    await p.tick(); // healthy → resets counter + re-arms
    // fresh sustained run
    refs.jobs = 600;
    await p.tick(); // n=1
    expect(selfHeals.length).toBe(1);
    await p.tick(); // n=2 → fire #2
    expect(selfHeals.length).toBe(2);
  });

  test("reader failure degrades safe — all readers throw → sentinels, 0 events, 0 self-heal", async () => {
    const { p, emitted, selfHeals } = harness({
      config: baseConfig({ selfHealEnabled: true, sustainedTicks: 1 }),
      throwAll: true,
    });
    await p.tick();
    expect(emitted.length).toBe(0);
    expect(selfHeals.length).toBe(0);
  });

  test("selfHealEnabled=false (default) → emits every tick but never sweeps", async () => {
    const { p, emitted, selfHeals } = harness({
      config: baseConfig({ selfHealEnabled: false, sustainedTicks: 2 }),
      jobs: 600,
    });
    await p.tick();
    await p.tick();
    await p.tick();
    expect(emitted.length).toBe(3);
    expect(selfHeals.length).toBe(0);
  });

  test("stop() calls clock.clearInterval with the registered handle", () => {
    const { p, clock } = harness();
    expect(clock.wasCleared()).toBe(false);
    p.stop();
    expect(clock.wasCleared()).toBe(true);
  });

  test("awaits async readers and emits degraded when a threshold trips", async () => {
    const emitted = [];
    const { tick } = startFleetHealthProbe({
      clock: { setInterval: () => ({ unref() {} }), clearInterval() {} },
      config: { intervalMs: 120000, selfHealEnabled: false, sustainedTicks: 1,
        jobsThreshold: 1, agentsThreshold: 9999, procsThreshold: 9999, swapUsedMbThreshold: 999999 },
      readJobsCount: async () => 5,
      listAgents: () => [],
      psLines: async () => [],
      readSwapUsedMb: async () => 0,
      emit: (r) => emitted.push(r),
    });
    await tick();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].tripped).toContain("jobs");
  });

  test("a rejecting async reader yields the non-crossing sentinel (no crash, no trip)", async () => {
    const emitted = [];
    const { tick } = startFleetHealthProbe({
      clock: { setInterval: () => ({ unref() {} }), clearInterval() {} },
      config: { intervalMs: 120000, selfHealEnabled: false, sustainedTicks: 1,
        jobsThreshold: 1, agentsThreshold: 1, procsThreshold: 1, swapUsedMbThreshold: 1 },
      readJobsCount: async () => { throw new Error("readdir failed"); },
      listAgents: () => { throw new Error("x"); },
      psLines: async () => { throw new Error("ps failed"); },
      readSwapUsedMb: async () => { throw new Error("sysctl failed"); },
      emit: (r) => emitted.push(r),
    });
    await tick();
    expect(emitted).toHaveLength(0);
  });
});

// ─── defaultReadSwapUsedMb ───────────────────────────────────────────────────

describe("defaultReadSwapUsedMb", () => {
  // platform:"darwin" is pinned explicitly — the default reads process.platform,
  // which is "linux" on CI, where the function short-circuits to 0 (sysctl is a
  // macOS-only signal). Pinning darwin exercises the real parse path everywhere.
  test("parses the used field from sysctl vm.swapusage output", async () => {
    const sample =
      "total = 8192.00M  used = 4500.06M  free = 3691.94M  (encrypted)";
    expect(await defaultReadSwapUsedMb({ platform: "darwin", run: () => sample })).toBe(4500);
  });

  test("off-darwin / non-darwin platform → 0 safe sentinel", async () => {
    expect(await defaultReadSwapUsedMb({ platform: "linux" })).toBe(0);
  });

  test("throwing sysctl → 0 safe sentinel", async () => {
    expect(
      await defaultReadSwapUsedMb({
        platform: "darwin",
        run: () => {
          throw new Error("sysctl missing");
        },
      }),
    ).toBe(0);
  });

  test("no-match output → 0 safe sentinel", async () => {
    expect(
      await defaultReadSwapUsedMb({ platform: "darwin", run: () => "garbage no used field" }),
    ).toBe(0);
  });
});

// ─── defaultTriggerSelfHeal ──────────────────────────────────────────────────

describe("defaultTriggerSelfHeal", () => {
  test("emits the three gated reap intents (incl procOrphans.reap-requested) and never kills directly", async () => {
    const intents = [];
    await expect(
      defaultTriggerSelfHeal({
        emitIntent: async (name) => intents.push(name),
      }),
    ).resolves.toBeUndefined();
    // CTL-1165 (hardened): self-heal routes the child sweep through the gated,
    // shadow-default proc-reaper via procOrphans.reap-requested — it gains NO new
    // kill authority and has NO direct ppid===1 node/bun SIGTERM path of its own
    // (a bare sweep with an empty skip set would take down the daemon itself).
    expect(intents).toEqual([
      "orphans.reap-requested",
      "phase.reconcile.reap-requested",
      "procOrphans.reap-requested",
    ]);
  });

  test("a throwing emitIntent does not prevent the remaining intents and never throws", async () => {
    const intents = [];
    await expect(
      defaultTriggerSelfHeal({
        emitIntent: async (name) => {
          intents.push(name);
          if (name === "orphans.reap-requested") throw new Error("event log unwritable");
        },
      }),
    ).resolves.toBeUndefined();
    // All three are attempted even though the first throws (independent guards).
    expect(intents).toEqual([
      "orphans.reap-requested",
      "phase.reconcile.reap-requested",
      "procOrphans.reap-requested",
    ]);
  });
});
