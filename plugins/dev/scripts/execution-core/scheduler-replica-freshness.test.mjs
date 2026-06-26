// CTL-1366 — unit tests for the read-replica freshness gauge
// (scheduler.mjs:maybeEmitReplicaFreshness). The full schedulerTick is heavy to
// drive, so we exercise the extracted helper directly with an injected logger +
// clock. Metric-threshold alerting on this gauge is owned by Grafana, not in-code.
// Run:
//   bun test plugins/dev/scripts/execution-core/scheduler-replica-freshness.test.mjs
import { describe, test, expect } from "bun:test";
import { maybeEmitReplicaFreshness } from "./scheduler.mjs";

// a capturing logger that records (obj, msg) info calls.
function makeLog() {
  const lines = [];
  return { lines, info: (obj, msg) => lines.push({ obj, msg }), warn() {}, error() {}, debug() {} };
}

const GAUGE_MSG = "scheduler: replica freshness (CTL-1366)";
const NOW_MS = 1_000_000_000_000;
const now = () => NOW_MS;

describe("maybeEmitReplicaFreshness — gauge emit (CTL-1366)", () => {
  test("emits the gauge line with staleness ≈ (now - maxUpdatedAtMs)/1000 + rows", () => {
    const log = makeLog();
    const replica = { freshness: () => ({ maxUpdatedAtMs: NOW_MS - 120_000, rowCount: 42 }) };
    maybeEmitReplicaFreshness({ replica, now, env: {}, log });
    const line = log.lines.find((l) => l.msg === GAUGE_MSG);
    expect(line).toBeTruthy();
    expect(line.obj["catalyst.linear.replica.staleness"]).toBeCloseTo(120, 6);
    expect(line.obj["catalyst.linear.replica.rows"]).toBe(42);
  });

  test("NO-OP when the replica reader is absent (tier off → no emit)", () => {
    const log = makeLog();
    maybeEmitReplicaFreshness({ replica: undefined, now, env: {}, log });
    expect(log.lines).toHaveLength(0);
  });

  test("NO-OP when freshness() returns undefined (fail-open MISS → no emit)", () => {
    const log = makeLog();
    const replica = { freshness: () => undefined };
    maybeEmitReplicaFreshness({ replica, now, env: {}, log });
    expect(log.lines).toHaveLength(0);
  });

  test("NO-OP + no throw when freshness() throws (fail-open)", () => {
    const log = makeLog();
    const replica = {
      freshness: () => {
        throw new Error("db gone");
      },
    };
    expect(() => maybeEmitReplicaFreshness({ replica, now, env: {}, log })).not.toThrow();
    expect(log.lines).toHaveLength(0);
  });
});
