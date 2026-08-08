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

test("healthy without a prior alert emits nothing", () => {
  const events = [];
  resetReplicaHealth();
  recordReplicaRead("CAT", "replica", opts(events));
  expect(events).toHaveLength(0);
});

test("no-triage-status is not degradation", () => {
  const events = [];
  resetReplicaHealth();
  for (let i = 0; i < 9; i += 1) recordReplicaRead("CAT", "no-triage-status", opts(events));
  expect(events).toHaveLength(0);
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
