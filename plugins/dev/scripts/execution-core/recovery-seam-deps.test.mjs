import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRecoverySeamDeps,
  startScheduler,
  __getRunningOpts,
  __resetForTests,
} from "./scheduler.mjs";
import * as linearWrite from "./linear-write.mjs";

// Every jobLifecycle test injects getAgents. The real getAgentsCached refreshes
// by spawning `claude agents --json`, which a hermetic unit test must not do.
const build = (opts = {}, seams = {}) =>
  buildRecoverySeamDeps(opts, {
    readSignals: () => [],
    getAgents: () => ({ agents: [] }),
    clearStallFactory: () => null,
    ...seams,
  });

test("resolvePrState returns null without a PR adapter", () => {
  const deps = build({}, { readSignals: () => expect.unreachable() });
  expect(deps.resolvePrState("CAT-1")).toBeNull();
});

test("resolvePrState returns null when prView is not callable", () => {
  for (const prAdapter of [{}, { prView: 42 }]) {
    const deps = build({ prAdapter }, { readSignals: () => expect.unreachable() });
    expect(deps.resolvePrState("CAT-1")).toBeNull();
  }
});

test("resolvePrState returns null when no signal has a PR number", () => {
  let calls = 0;
  const deps = build(
    { orchDir: "/orch", prAdapter: { prView: () => calls++ } },
    { readSignals: () => [{ ticket: "CAT-1", raw: { pr: {} } }] }
  );
  expect(deps.resolvePrState("CAT-1")).toBeNull();
  expect(calls).toBe(0);
});

test("resolvePrState selects the first numbered signal and prefers raw.pr", () => {
  const calls = [];
  const deps = build(
    { orchDir: "/orch", prAdapter: { prView: (...args) => (calls.push(args), { state: "OPEN" }) } },
    {
      readSignals: (orchDir) => {
        expect(orchDir).toBe("/orch");
        return [
          { ticket: "CAT-1", pr: {} },
          { ticket: "CAT-1", raw: { pr: { number: 77 } }, pr: { number: 88 } },
          { ticket: "CAT-1", pr: { number: 99 } },
        ];
      },
    }
  );
  expect(deps.resolvePrState("CAT-1")).toBe("OPEN");
  expect(calls).toEqual([["CAT-1", { number: 77 }]]);
});

test("resolvePrState normalizes merged state and mergedAt", () => {
  for (const view of [{ state: "MERGED" }, { state: "OPEN", mergedAt: "now" }]) {
    const deps = build(
      { prAdapter: { prView: () => view } },
      { readSignals: () => [{ ticket: "CAT-1", pr: { number: 1 } }] }
    );
    expect(deps.resolvePrState("CAT-1")).toBe("MERGED");
  }
});

test("resolvePrState passes through state and nullifies absent state", () => {
  for (const [view, expected] of [
    [{ state: "OPEN" }, "OPEN"],
    [null, null],
    [{}, null],
  ]) {
    const deps = build(
      { prAdapter: { prView: () => view } },
      { readSignals: () => [{ ticket: "CAT-1", pr: { number: 1 } }] }
    );
    expect(deps.resolvePrState("CAT-1")).toBe(expected);
  }
});

test("resolvePrState fails closed when prView throws", () => {
  const deps = build(
    {
      prAdapter: {
        prView: () => {
          throw new Error("gh failed");
        },
      },
    },
    { readSignals: () => [{ ticket: "CAT-1", pr: { number: 1 } }] }
  );
  expect(deps.resolvePrState("CAT-1")).toBeNull();
});

test("jobLifecycle short-circuits without a liveness probe", () => {
  const deps = build({}, { getAgents: () => expect.unreachable() });
  expect(deps.jobLifecycle("job-1")).toBe(false);
});

test("jobLifecycle rejects falsy job ids without probing", () => {
  let calls = 0;
  const deps = build({ isBgJobAlive: () => calls++ });
  for (const id of [null, "", undefined]) expect(deps.jobLifecycle(id)).toBe(false);
  expect(calls).toBe(0);
});

test("jobLifecycle coerces probe results and threads the agents snapshot", () => {
  const calls = [];
  const agents = [{ id: "agent-1" }];
  const deps = build(
    { isBgJobAlive: (...args) => (calls.push(args), 1) },
    { getAgents: () => ({ agents }) }
  );
  expect(deps.jobLifecycle("job-1")).toBe(true);
  expect(calls).toEqual([["job-1", { agents }]]);
});

test("jobLifecycle fails closed when the probe throws", () => {
  const deps = build({
    isBgJobAlive: () => {
      throw new Error("probe failed");
    },
  });
  expect(deps.jobLifecycle("job-1")).toBe(false);
});

test("bundle defaults writeStatus and passes it with orchDir to clearStallFactory", () => {
  for (const writeStatus of [undefined, { sentinel: true }]) {
    const calls = [];
    const clearStall = () => true;
    const deps = build(
      { orchDir: "/orch", writeStatus },
      { clearStallFactory: (...args) => (calls.push(args), clearStall) }
    );
    const expected = writeStatus ?? linearWrite;
    expect(deps.orchDir).toBe("/orch");
    expect(deps.writeStatus).toBe(expected);
    expect(deps.clearStall).toBe(clearStall);
    expect(calls).toEqual([["/orch", expected]]);
  }
});

test("closures lazily observe options assigned after construction", () => {
  const opts = { orchDir: "/orch", prAdapter: undefined, isBgJobAlive: undefined };
  const deps = build(opts, {
    readSignals: () => [{ ticket: "CAT-1", pr: { number: 1 } }],
    getAgents: () => ({ agents: ["warm"] }),
  });
  opts.prAdapter = { prView: () => ({ state: "OPEN" }) };
  opts.isBgJobAlive = (_id, snapshot) => snapshot.agents[0] === "warm";
  expect(deps.resolvePrState("CAT-1")).toBe("OPEN");
  expect(deps.jobLifecycle("job-1")).toBe(true);
});

test("seam fallback suppression follows the effective operator registry override", () => {
  const partial = { "dirty-tree": () => {} };
  for (const [opts, expected] of [
    [{ orchDir: "/orch" }, false],
    [{ orchDir: "/orch", unstuckActByCategory: {} }, true],
    [{ orchDir: "/orch", unstuckActByCategory: partial }, true],
    [{ orchDir: "/orch", unstuckActByCategory: undefined }, false],
    [{ orchDir: "/orch", unstuckSweep: { actByCategory: {} } }, true],
  ]) {
    expect(build(opts).seamFallbackSuppressed).toBe(expected);
  }
});

// ── CAT-124 (Codex #3223 P1): the override must survive the PRODUCTION entry point ──
//
// The suppression contract above is derived inside buildRecoverySeamDeps, which the
// daemon calls as `buildRecoverySeamDeps(runningOpts)`. startScheduler originally
// destructured none of the unstuck-* keys, so an operator's
// `startScheduler({ unstuckActByCategory: {} })` never reached runningOpts: the
// derivation saw `undefined`, seamFallbackSuppressed stayed false, and Pass 0r went
// on rebuilding live seams behind a registry that was supposed to bind both passes.
// Asserting only on a hand-built opts object cannot catch that — these tests go
// through startScheduler so the wiring itself is pinned.
// Temp orchDirs created per test, removed in afterEach. CATALYST_DIR itself is
// already pinned to a hermetic temp dir by the bun [test].preload (test-setup.mjs),
// so booting a real scheduler here cannot touch ~/catalyst or reach live Linear —
// run this file from plugins/dev/scripts/execution-core so that preload applies.
const bootDirs = [];
function bootOrchDir() {
  const dir = mkdtempSync(join(tmpdir(), "cat124-seam-wiring-"));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ maxParallel: 1 }));
  bootDirs.push(dir);
  return dir;
}

const bootOpts = (orchDir, extra) => ({
  orchDir,
  dispatch: () => ({ code: 0 }),
  readEligible: () => [],
  liveBackgroundCount: () => 0,
  tickIntervalMs: 60_000,
  debounceMs: 5,
  ...extra,
});

afterEach(() => {
  // __resetForTests stops the scheduler timer/watcher and clears runningOpts.
  __resetForTests();
  while (bootDirs.length) rmSync(bootDirs.pop(), { recursive: true, force: true });
});

test("startScheduler retains the unstuck override seams in runningOpts", () => {
  const orchDir = bootOrchDir();
  const unstuckActByCategory = {};
  const unstuckSweep = { actByCategory: { "dirty-tree": () => {} } };
  const unstuckEscalate = () => {};
  const unstuckPostComment = () => {};

  startScheduler(
    bootOpts(orchDir, {
      unstuckSweep,
      unstuckActByCategory,
      unstuckEscalate,
      unstuckPostComment,
    })
  );

  const opts = __getRunningOpts();
  // Identity, not merely presence — runTick reads these off runningOpts directly.
  expect(opts.unstuckActByCategory).toBe(unstuckActByCategory);
  expect(opts.unstuckSweep).toBe(unstuckSweep);
  expect(opts.unstuckEscalate).toBe(unstuckEscalate);
  expect(opts.unstuckPostComment).toBe(unstuckPostComment);
});

test("an inert operator registry passed to startScheduler suppresses Pass 0r seam fallback", () => {
  const orchDir = bootOrchDir();
  // `{}` is the operator's "keep enforcement inert" posture — the exact shape the
  // finding named. It must bind BOTH passes, not just Pass 0u.
  startScheduler(bootOpts(orchDir, { unstuckActByCategory: {} }));

  expect(build(__getRunningOpts()).seamFallbackSuppressed).toBe(true);
});

test("startScheduler without an override leaves capability fallback active", () => {
  const orchDir = bootOrchDir();
  startScheduler(bootOpts(orchDir));

  const opts = __getRunningOpts();
  expect(opts.unstuckActByCategory).toBeUndefined();
  expect(opts.unstuckSweep).toBeUndefined();
  // No injected registry → Pass 0r keeps its capability-checked fallback (unchanged).
  expect(build(opts).seamFallbackSuppressed).toBe(false);
});
