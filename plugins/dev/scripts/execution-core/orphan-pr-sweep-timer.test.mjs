import { test, expect } from "bun:test";
import { runOrphanSweep } from "./orphan-pr-sweep-timer.mjs";

const repo = "org/repo";
const mkPr = (n, o = {}) => ({ number: n, url: `https://github.com/${repo}/pull/${n}`,
  title: `PR ${n}`, headRefName: `b${n}`, mergeStateStatus: "BLOCKED", isDraft: false, ...o });

test("PR tracked by a worker is filtered out (not an orphan)", async () => {
  const persisted = {};
  await runOrphanSweep({
    repo, nowMs: 1000, cfg: { stableSeconds: 300 },
    prList: async () => [mkPr(2061)],
    readWorkerTrackedNumbers: () => new Set([2061]),
    readState: () => ({}), persist: (s) => Object.assign(persisted, s), emit: () => {},
  });
  expect(Object.keys(persisted)).toHaveLength(0);
});

test("orphan blocker, first sighting → stamps firstSeenAt, no notify event yet", async () => {
  let persisted = null; const events = [];
  await runOrphanSweep({
    repo, nowMs: 1000, cfg: { stableSeconds: 300 },
    prList: async () => [mkPr(2061)],
    readWorkerTrackedNumbers: () => new Set(),
    readState: () => ({}), persist: (s) => (persisted = s), emit: (n, p) => events.push({ n, p }),
  });
  expect(persisted[`${repo}#2061`].firstSeenAt).toBeTruthy();
  expect(persisted[`${repo}#2061`].notifiedAt).toBeUndefined();
  expect(events).toHaveLength(0);
});

test("orphan blocker past stable window → sets notifiedAt + emits one detected event", async () => {
  const firstSeenAt = new Date(0).toISOString(); let persisted = null; const events = [];
  await runOrphanSweep({
    repo, nowMs: 300_000, cfg: { stableSeconds: 300 },
    prList: async () => [mkPr(2061)],
    readWorkerTrackedNumbers: () => new Set(),
    readState: () => ({ [`${repo}#2061`]: { repo, number: 2061, firstSeenAt } }),
    persist: (s) => (persisted = s), emit: (n, p) => events.push({ n, p }),
  });
  expect(persisted[`${repo}#2061`].notifiedAt).toBeTruthy();
  expect(events.map((e) => e.n)).toEqual(["phase.orphan-pr.detected.2061"]);
});

test("notified orphan that recovered to CLEAN is pruned from state (row disappears)", async () => {
  const prior = { [`${repo}#2061`]: { repo, number: 2061,
    firstSeenAt: new Date(0).toISOString(), notifiedAt: new Date(300_000).toISOString() } };
  let persisted = null;
  await runOrphanSweep({
    repo, nowMs: 600_000, cfg: { stableSeconds: 300 },
    prList: async () => [mkPr(2061, { mergeStateStatus: "CLEAN" })],
    readWorkerTrackedNumbers: () => new Set(),
    readState: () => prior, persist: (s) => (persisted = s), emit: () => {},
  });
  expect(persisted[`${repo}#2061`]).toBeUndefined();
});

test("a closed/merged PR (no longer listed open) is pruned from state", async () => {
  const prior = { [`${repo}#2061`]: { repo, number: 2061, firstSeenAt: new Date(0).toISOString() } };
  let persisted = null;
  await runOrphanSweep({
    repo, nowMs: 600_000, cfg: { stableSeconds: 300 },
    prList: async () => [], // PR gone from open list
    readWorkerTrackedNumbers: () => new Set(),
    readState: () => prior, persist: (s) => (persisted = s), emit: () => {},
  });
  expect(persisted[`${repo}#2061`]).toBeUndefined();
});

test("no resolvable repo slug → sweep is a no-op (fail-open), persist never called", async () => {
  let called = false;
  await runOrphanSweep({
    repo: null, nowMs: 1000, cfg: { stableSeconds: 300 },
    prList: async () => { throw new Error("must not list"); },
    readWorkerTrackedNumbers: () => new Set(),
    readState: () => ({}), persist: () => (called = true), emit: () => {},
  });
  expect(called).toBe(false);
});

test("notified orphan still blocked → entry carries forward with original notifiedAt (no re-event)", async () => {
  const firstSeenAt = new Date(0).toISOString();
  const notifiedAt = new Date(300_000).toISOString();
  const prior = { [`${repo}#2061`]: { repo, number: 2061, firstSeenAt, notifiedAt } };
  let persisted = null; const events = [];
  await runOrphanSweep({
    repo, nowMs: 600_000, cfg: { stableSeconds: 300 },
    prList: async () => [mkPr(2061)],
    readWorkerTrackedNumbers: () => new Set(),
    readState: () => prior, persist: (s) => (persisted = s), emit: (n, p) => events.push({ n, p }),
  });
  // Entry still there, notifiedAt unchanged, no new event
  expect(persisted[`${repo}#2061`].notifiedAt).toBe(notifiedAt);
  expect(events).toHaveLength(0);
});

test("torn state file (null) → sweep skips persistence", async () => {
  let called = false;
  await runOrphanSweep({
    repo, nowMs: 1000, cfg: { stableSeconds: 300 },
    prList: async () => [mkPr(2061)],
    readWorkerTrackedNumbers: () => new Set(),
    readState: () => null, persist: () => (called = true), emit: () => {},
  });
  expect(called).toBe(false);
});
