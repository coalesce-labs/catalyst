// stall-janitor-throttle.test.mjs — CTL-1324. The THIN scheduler-seam test that
// proves the EXPENSIVE per-tick worktree census (Pass 0j J1 orphan / J3
// stall-clear / J4 GC) is throttled OFF the hot path.
//
// Run: cd plugins/dev/scripts/execution-core && bun test stall-janitor-throttle.test.mjs
//
// Lives in its OWN file (not scheduler.test.mjs) so it runs in CI: scheduler.test.mjs
// is excluded from the CI allowlist for its real-timer / fs.watch suite. These cases
// call schedulerTick synchronously with injected census stubs + an injected clock —
// no timers, no fs.watch, no real git — so they are CI-safe and deterministic.
//
// ROOT CAUSE (CTL-1324): the J1 orphan-worktree census fires a synchronous
// `git worktree list` per repo + a `git status` per terminal worktree EVERY tick.
// On a many-worktree host (mini: 61) that ~50–70s of blocking spawnSync ages
// node.heartbeat past the CTL-731 degraded threshold and HOLDS new-work dispatch.
// The fix throttles those heavy censuses to a 15-min cadence (default), while the
// CHEAP J2 ghost-session census (warm agents snapshot only) keeps running every tick.
//
// These tests assert the FREQUENCY contract:
//   (1) the heavy census RUNS on the first tick;
//   (2) it is SKIPPED on a tick within the interval;
//   (3) it RUNS again on a tick after the interval elapses (injected clock seam);
//   (4) the cheap J2 ghost census is NOT throttled — it runs on every tick.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulerTick, __resetForTests } from "./scheduler.mjs";

let orchDir;
let catalystDir;
let prevCatalystDir;
let prevJanitorEnv;
let prevIntervalEnv;

beforeEach(() => {
  __resetForTests(); // zero the module-level _stallJanitorCensusLastRunMs throttle
  orchDir = mkdtempSync(join(tmpdir(), "sj-throttle-"));
  prevCatalystDir = process.env.CATALYST_DIR;
  catalystDir = mkdtempSync(join(tmpdir(), "sj-throttle-cat-"));
  process.env.CATALYST_DIR = catalystDir; // getEventLogPath() resolves under the fixture
  // Pin the janitor mode + interval so the test is independent of any operator
  // Layer-2 config / ambient env on the CI host.
  prevJanitorEnv = process.env.CATALYST_STALL_JANITOR;
  prevIntervalEnv = process.env.CATALYST_STALL_JANITOR_INTERVAL_MS;
  delete process.env.CATALYST_STALL_JANITOR;
  delete process.env.CATALYST_STALL_JANITOR_INTERVAL_MS;
});

afterEach(() => {
  __resetForTests();
  rmSync(orchDir, { recursive: true, force: true });
  rmSync(catalystDir, { recursive: true, force: true });
  if (prevCatalystDir === undefined) delete process.env.CATALYST_DIR;
  else process.env.CATALYST_DIR = prevCatalystDir;
  if (prevJanitorEnv === undefined) delete process.env.CATALYST_STALL_JANITOR;
  else process.env.CATALYST_STALL_JANITOR = prevJanitorEnv;
  if (prevIntervalEnv === undefined) delete process.env.CATALYST_STALL_JANITOR_INTERVAL_MS;
  else process.env.CATALYST_STALL_JANITOR_INTERVAL_MS = prevIntervalEnv;
});

// Minimal schedulerTick options that wire the stall-janitor seam with counting
// census stubs + an injected clock, and keep every other pass an inert no-op.
function makeOpts({ orphanCalls, ghostCalls, nowFn, intervalMs }) {
  return {
    readEligible: () => [],
    dispatch: () => ({ code: 0, stdout: "", stderr: "" }),
    writeStatus: () => {},
    reclaimDeadWork: () => "noop",
    liveBackgroundCount: () => 0,
    stallJanitor: {
      mode: "shadow",
      censusIntervalMs: intervalMs,
      nowMs: nowFn,
      // J1 orphan census — the GIT-HEAVY one being throttled. Count its calls.
      // Returns [] so no real classification / git runs.
      collectOrphanCandidates: () => {
        orphanCalls.n++;
        return [];
      },
      // J2 ghost census — CHEAP (warm agents snapshot only), NOT throttled.
      collectGhostCandidates: () => {
        ghostCalls.n++;
        return [];
      },
      // J3/J4 left unwired (undefined) — they default to () => [] inside the pass.
      emit: () => Promise.resolve(true),
    },
  };
}

describe("schedulerTick — Pass 0j heavy-census throttle (CTL-1324)", () => {
  test("(1) first tick RUNS the heavy worktree census", () => {
    const orphanCalls = { n: 0 };
    const ghostCalls = { n: 0 };
    let fakeNow = 1_000_000;
    const opts = makeOpts({
      orphanCalls,
      ghostCalls,
      nowFn: () => fakeNow,
      intervalMs: 900_000,
    });

    schedulerTick(orchDir, opts);
    expect(orphanCalls.n).toBe(1);
  });

  test("(2) a second tick WITHIN the interval SKIPS the heavy census", () => {
    const orphanCalls = { n: 0 };
    const ghostCalls = { n: 0 };
    let fakeNow = 1_000_000;
    const opts = makeOpts({
      orphanCalls,
      ghostCalls,
      nowFn: () => fakeNow,
      intervalMs: 900_000,
    });

    schedulerTick(orchDir, opts); // t=1_000_000 → runs
    expect(orphanCalls.n).toBe(1);

    fakeNow += 30_000; // +30s — well inside the 15-min window
    schedulerTick(orchDir, opts); // throttled
    expect(orphanCalls.n).toBe(1); // UNCHANGED — heavy census did NOT run again
  });

  test("(3) a tick AFTER the interval elapses RUNS the heavy census again", () => {
    const orphanCalls = { n: 0 };
    const ghostCalls = { n: 0 };
    let fakeNow = 1_000_000;
    const opts = makeOpts({
      orphanCalls,
      ghostCalls,
      nowFn: () => fakeNow,
      intervalMs: 900_000,
    });

    schedulerTick(orchDir, opts); // t=1_000_000 → runs (1)
    expect(orphanCalls.n).toBe(1);

    fakeNow += 30_000;
    schedulerTick(orchDir, opts); // throttled — still 1
    expect(orphanCalls.n).toBe(1);

    fakeNow += 900_001; // advance past the 15-min interval
    schedulerTick(orchDir, opts); // runs again (2)
    expect(orphanCalls.n).toBe(2);
  });

  test("(4) the CHEAP J2 ghost census is NOT throttled — runs every tick", () => {
    const orphanCalls = { n: 0 };
    const ghostCalls = { n: 0 };
    let fakeNow = 1_000_000;
    const opts = makeOpts({
      orphanCalls,
      ghostCalls,
      nowFn: () => fakeNow,
      intervalMs: 900_000,
    });

    schedulerTick(orchDir, opts); // tick 1
    fakeNow += 30_000;
    schedulerTick(orchDir, opts); // tick 2 (heavy census throttled)
    fakeNow += 30_000;
    schedulerTick(orchDir, opts); // tick 3 (heavy census throttled)

    // J1 throttled to a single run; J2 ran on all three ticks.
    expect(orphanCalls.n).toBe(1);
    expect(ghostCalls.n).toBe(3);
  });
});
