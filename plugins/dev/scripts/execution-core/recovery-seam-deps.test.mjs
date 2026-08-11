import { expect, test } from "bun:test";
import { buildRecoverySeamDeps } from "./scheduler.mjs";
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
