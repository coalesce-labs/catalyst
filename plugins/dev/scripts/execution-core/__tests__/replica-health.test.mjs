import { test, expect } from "bun:test";
import { recordReplicaRead, resetReplicaHealth } from "../replica-health.mjs";

const opts = (events) => ({
  appendEvent: (event) => events.push(event),
  readMarker: () => null,
  writeMarker: () => {},
  threshold: 3,
});

test("degraded emits exactly once at the threshold", () => {
  const events = [];
  resetReplicaHealth();
  for (let i = 0; i < 6; i += 1) recordReplicaRead("CAT", "no-replica", opts(events));
  expect(events.filter((event) => event.action === "degraded")).toHaveLength(1);
});

test("below threshold emits nothing", () => {
  const events = [];
  resetReplicaHealth();
  recordReplicaRead("CAT", "no-replica", opts(events));
  recordReplicaRead("CAT", "no-replica", opts(events));
  expect(events).toHaveLength(0);
});

test("healthy read after an alert emits recovered and resets", () => {
  const events = [];
  resetReplicaHealth();
  for (let i = 0; i < 3; i += 1) recordReplicaRead("CAT", "replica", opts(events));
  for (let i = 0; i < 3; i += 1) recordReplicaRead("CAT", "no-replica", opts(events));
  recordReplicaRead("CAT", "replica", opts(events));
  expect(events.at(-1).action).toBe("recovered");
});

test("healthy read after restart hydrates alert and emits recovered", () => {
  const events = [];
  resetReplicaHealth();
  recordReplicaRead("CAT", "replica", {
    ...opts(events),
    readMarker: () => ({
      consecutiveDegraded: 3,
      lastHealthyTs: "2026-08-08T00:00:00.000Z",
      alerting: true,
    }),
  });
  expect(events).toEqual([
    { team: "CAT", action: "recovered", source: "replica", consecutiveDegraded: 0 },
  ]);
});

// CAT-35 (Codex round 1): the alert latch must survive a failed recovery append.
// Clearing `alerting` before the append landed meant one failed write (disk full,
// EACCES) permanently swallowed the recovery — the persisted marker said "not
// alerting", so no later healthy read had an alert to recover from, and consumers
// stayed pinned to monitor.replica.degraded.<TEAM> forever. Mirrors the degraded
// branch, which has always gated its latch on a successful append.
test("failed recovery append keeps the latch so a later healthy read retries", () => {
  const events = [];
  const persisted = [];
  resetReplicaHealth();
  const hydrated = () => ({ consecutiveDegraded: 3, lastHealthyTs: null, alerting: true });

  // First healthy read: the append fails, so the latch must NOT clear.
  recordReplicaRead("CAT", "replica", {
    appendEvent: () => false,
    readMarker: hydrated,
    writeMarker: (_team, state) => persisted.push({ ...state }),
    threshold: 3,
  });
  expect(events).toHaveLength(0);
  expect(persisted.at(-1).alerting).toBe(true);

  // Second healthy read: the append succeeds, the recovery finally lands, latch clears.
  recordReplicaRead("CAT", "replica", {
    appendEvent: (event) => events.push(event),
    readMarker: hydrated,
    writeMarker: (_team, state) => persisted.push({ ...state }),
    threshold: 3,
  });
  expect(events).toEqual([
    { team: "CAT", action: "recovered", source: "replica", consecutiveDegraded: 0 },
  ]);
  expect(persisted.at(-1).alerting).toBe(false);
});

test("healthy without a prior alert emits nothing", () => {
  const events = [];
  resetReplicaHealth();
  recordReplicaRead("CAT", "replica", opts(events));
  expect(events).toHaveLength(0);
});

test("no-triage-status is not degradation", () => {
  const events = [];
  let writes = 0;
  resetReplicaHealth();
  for (let i = 0; i < 9; i += 1) {
    recordReplicaRead("CAT", "no-triage-status", {
      ...opts(events),
      writeMarker: () => { writes += 1; },
    });
  }
  expect(events).toHaveLength(0);
  expect(writes).toBe(0);
});

test("failed degraded event append retries on the next read", () => {
  const events = [];
  let attempts = 0;
  resetReplicaHealth();
  const retryingOpts = {
    ...opts(events),
    threshold: 1,
    appendEvent: (event) => {
      attempts += 1;
      if (attempts === 1) return false;
      events.push(event);
      return true;
    },
  };
  recordReplicaRead("CAT", "no-replica", retryingOpts);
  recordReplicaRead("CAT", "no-replica", retryingOpts);
  expect(attempts).toBe(2);
  expect(events).toHaveLength(1);
});

test("streaks are per team", () => {
  const events = [];
  resetReplicaHealth();
  for (let i = 0; i < 3; i += 1) {
    recordReplicaRead("CAT", "no-replica", opts(events));
    recordReplicaRead("SKI", "replica", opts(events));
  }
  expect(events.filter((event) => event.team === "CAT")).toHaveLength(1);
  expect(events.filter((event) => event.team === "SKI")).toHaveLength(0);
});

test("appendEvent throw never propagates", () => {
  resetReplicaHealth();
  expect(() =>
    recordReplicaRead("CAT", "no-replica", {
      appendEvent: () => { throw new Error("disk full"); },
      writeMarker: () => {},
      threshold: 1,
    }),
  ).not.toThrow();
});
