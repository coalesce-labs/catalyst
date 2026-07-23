// fleet-health-probe.test.mjs — CTL-1165 D5. The pre-exhaustion fleet-health
// guardrail core: classifyFleetHealth (pure), the four safe()-wrapped signal
// reads with NON-CROSSING sentinels, single-event-per-breach emit, hysteresis
// re-arm, selfHealEnabled default-OFF, and the bounded ppid===1 node/bun child
// sweep. All dependencies injected; tick() called directly — no real timer,
// sysctl, ps, or kill. Mirrors memory-sampler.test.mjs.
//
// Run: cd plugins/dev/scripts/execution-core && bun test fleet-health-probe.test.mjs

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyFleetHealth,
  classifyFleetHealthClear,
  nextFleetHealthLatch,
  startFleetHealthProbe,
  defaultReadSwapUsedMb,
  defaultTriggerSelfHeal,
  __resetFleetHealthLatch,
} from "./fleet-health-probe.mjs";
import { getFleetHealthDir } from "./config.mjs";
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
  // CTL-1503 — lower clear threshold for the swap hysteresis band. In the
  // discrete jobs/agents/procs tests below the swap stays 0 so the band is
  // irrelevant; where swap is exercised the band is [3000, 4096).
  swapUsedMbClearThreshold: 3000,
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
  const emitted = []; // payloads only (back-compat with existing assertions)
  const records = []; // CTL-1503 — { action, payload } per emit (edge capture)
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
    emit: (payload, { action = "degraded" } = {}) => {
      emitted.push(payload);
      records.push({ action, payload });
    },
    triggerSelfHeal: () => selfHeals.push(Date.now()),
  });
  return { p, refs, emitted, records, selfHeals, clock };
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
  // CTL-1503: the probe now persists an edge-trigger latch under
  // getFleetHealthDir() (CATALYST_DIR-scoped). Pin CATALYST_DIR to a fresh temp
  // dir + reset the in-memory latch before each test so latch state never leaks
  // across tests (mirrors the fleet-freeze-alert isolation pattern).
  let prevDir;
  let tmpDir;
  beforeEach(() => {
    prevDir = process.env.CATALYST_DIR;
    tmpDir = mkdtempSync(join(tmpdir(), "ctl1503-probe-"));
    process.env.CATALYST_DIR = tmpDir;
    __resetFleetHealthLatch();
  });
  afterEach(() => {
    __resetFleetHealthLatch();
    if (prevDir === undefined) delete process.env.CATALYST_DIR;
    else process.env.CATALYST_DIR = prevDir;
    rmSync(tmpDir, { recursive: true, force: true });
  });

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
    // CTL-1503: edge-triggered — ONE degraded emit for the whole sustained run
    // (was: one per tick). Self-heal still fires exactly once.
    expect(emitted.length).toBe(1);
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

  test("selfHealEnabled=false (default) → emits ONCE on the degraded edge but never sweeps", async () => {
    const { p, emitted, selfHeals } = harness({
      config: baseConfig({ selfHealEnabled: false, sustainedTicks: 2 }),
      jobs: 600,
    });
    await p.tick();
    await p.tick();
    await p.tick();
    // CTL-1503: one degraded on the edge; the sustained run is silent thereafter.
    expect(emitted.length).toBe(1);
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

  // ── CTL-1503: edge-trigger + hysteresis band + recovered ──────────────────
  test("constant high swap across 4 ticks → exactly ONE degraded emit (edge), sustained_n=1", async () => {
    const { p, records } = harness({
      config: baseConfig({ swapUsedMbThreshold: 4096, swapUsedMbClearThreshold: 3000 }),
      swap: 5000,
    });
    await p.tick();
    await p.tick();
    await p.tick();
    await p.tick();
    const degraded = records.filter((r) => r.action === "degraded");
    expect(degraded.length).toBe(1);
    expect(degraded[0].payload.sustained_n).toBe(1);
    expect(degraded[0].payload.tripped).toEqual(["swap"]);
  });

  test("swap into the band [clear,trip) holds the latch — recovered fires only once swap < clear", async () => {
    const { p, refs, records } = harness({
      config: baseConfig({ swapUsedMbThreshold: 4096, swapUsedMbClearThreshold: 3000 }),
      swap: 5000,
    });
    await p.tick(); // healthy→degraded edge → one degraded
    expect(records.filter((r) => r.action === "degraded").length).toBe(1);
    // drop INTO the band: clear (3000) <= swap (3500) < trip (4096)
    refs.swap = 3500;
    await p.tick(); // in-band → latch held, NO recovered
    await p.tick();
    expect(records.filter((r) => r.action === "recovered").length).toBe(0);
    // drop BELOW the clear threshold → exactly one recovered
    refs.swap = 2000;
    await p.tick();
    await p.tick();
    const recovered = records.filter((r) => r.action === "recovered");
    expect(recovered.length).toBe(1);
    expect(recovered[0].payload.tripped).toEqual([]); // no signal tripping at recovery
  });

  test("full episode: high→one degraded; recover→one recovered; high again→one degraded (re-arm)", async () => {
    const { p, refs, records } = harness({
      config: baseConfig({ swapUsedMbThreshold: 4096, swapUsedMbClearThreshold: 3000 }),
      swap: 5000,
    });
    await p.tick(); // degraded #1
    refs.swap = 1000; // below clear
    await p.tick(); // recovered #1
    refs.swap = 5000; // high again
    await p.tick(); // degraded #2 (latch re-armed)
    expect(records.map((r) => r.action)).toEqual(["degraded", "recovered", "degraded"]);
  });

  test("hydrated latch {latched:true} + still-degraded first tick → NO re-emit; clear tick → one recovered", async () => {
    // Simulate a daemon restart mid-episode: write the persisted latch, then a
    // fresh probe hydrates it and must NOT re-fire degraded on the first tick.
    mkdirSync(getFleetHealthDir(), { recursive: true });
    writeFileSync(
      join(getFleetHealthDir(), "fleet-health-latch.json"),
      JSON.stringify({ latched: true, ts: Date.now() }),
    );
    __resetFleetHealthLatch(); // clear in-memory so hydrate re-reads the marker
    const { p, refs, records } = harness({
      config: baseConfig({ swapUsedMbThreshold: 4096, swapUsedMbClearThreshold: 3000 }),
      swap: 5000, // still degraded
    });
    await p.tick(); // hydrated latch suppresses the restart re-fire
    expect(records.filter((r) => r.action === "degraded").length).toBe(0);
    // now recover
    refs.swap = 1000;
    await p.tick();
    const recovered = records.filter((r) => r.action === "recovered");
    expect(recovered.length).toBe(1);
  });

  test("latch marker is written on the degraded edge and rewritten {latched:false} on the recovered edge", async () => {
    const markerPath = join(getFleetHealthDir(), "fleet-health-latch.json");
    const { p, refs } = harness({
      config: baseConfig({ swapUsedMbThreshold: 4096, swapUsedMbClearThreshold: 3000 }),
      swap: 5000,
    });
    await p.tick(); // degraded edge → persist {latched:true}
    expect(existsSync(markerPath)).toBe(true);
    expect(JSON.parse(readFileSync(markerPath, "utf8")).latched).toBe(true);
    refs.swap = 1000;
    await p.tick(); // recovered edge → persist {latched:false}
    expect(JSON.parse(readFileSync(markerPath, "utf8")).latched).toBe(false);
  });
});

// ─── classifyFleetHealthClear (pure, CTL-1503) ───────────────────────────────

describe("classifyFleetHealthClear (pure)", () => {
  const CLEAR = {
    jobsThreshold: 500,
    agentsThreshold: 12,
    procsThreshold: 40,
    swapUsedMbThreshold: 3000, // swap's CLEAR threshold passed in this slot
  };

  test("all readings strictly below their clear thresholds → clear:true", () => {
    expect(
      classifyFleetHealthClear(
        { jobsCount: 10, agentsCount: 1, procsCount: 1, swapUsedMb: 2999 },
        CLEAR,
      ).clear,
    ).toBe(true);
  });

  test("swap == clearThreshold (boundary) → NOT clear (strict <)", () => {
    expect(
      classifyFleetHealthClear(
        { jobsCount: 10, agentsCount: 1, procsCount: 1, swapUsedMb: 3000 },
        CLEAR,
      ).clear,
    ).toBe(false);
  });

  test("any one signal at/above its clear threshold → clear:false", () => {
    expect(
      classifyFleetHealthClear(
        { jobsCount: 500, agentsCount: 1, procsCount: 1, swapUsedMb: 0 },
        CLEAR,
      ).clear,
    ).toBe(false);
  });

  test("null/sentinel readings count as below → never block a clear", () => {
    expect(
      classifyFleetHealthClear(
        { jobsCount: null, agentsCount: null, procsCount: null, swapUsedMb: 0 },
        CLEAR,
      ).clear,
    ).toBe(true);
  });
});

// ─── nextFleetHealthLatch (pure, CTL-1503) ───────────────────────────────────

describe("nextFleetHealthLatch (pure)", () => {
  test("prev=false, trip=true → latch + emit degraded", () => {
    expect(nextFleetHealthLatch(false, { trip: true, clear: false })).toEqual({
      latched: true,
      emit: "degraded",
    });
  });
  test("prev=true, trip=true → already latched, no re-emit", () => {
    expect(nextFleetHealthLatch(true, { trip: true, clear: false })).toEqual({
      latched: true,
      emit: null,
    });
  });
  test("prev=true, clear=true → release + emit recovered", () => {
    expect(nextFleetHealthLatch(true, { trip: false, clear: true })).toEqual({
      latched: false,
      emit: "recovered",
    });
  });
  test("prev=true, in-band (trip=false, clear=false) → hold, no emit", () => {
    expect(nextFleetHealthLatch(true, { trip: false, clear: false })).toEqual({
      latched: true,
      emit: null,
    });
  });
  test("prev=false, clear=true → stays unlatched, no emit", () => {
    expect(nextFleetHealthLatch(false, { trip: false, clear: true })).toEqual({
      latched: false,
      emit: null,
    });
  });
  test("prev=false, in-band → stays unlatched, no emit", () => {
    expect(nextFleetHealthLatch(false, { trip: false, clear: false })).toEqual({
      latched: false,
      emit: null,
    });
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
