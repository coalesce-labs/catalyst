// CTL-1366 — unit tests for the read-replica freshness gauge + data_stale edge
// trigger (scheduler.mjs:maybeEmitReplicaFreshness). The full schedulerTick is
// heavy to drive, so we exercise the extracted helper directly with an injected
// logger + alert emitter + clock. Run:
//   bun test plugins/dev/scripts/execution-core/scheduler-replica-freshness.test.mjs
import { describe, test, expect, beforeEach } from "bun:test";
import {
  maybeEmitReplicaFreshness,
  _resetReplicaStaleAlertState,
  REPLICA_STALENESS_THRESHOLD_DEFAULT_S,
} from "./scheduler.mjs";

// a capturing logger that records (obj, msg) info calls.
function makeLog() {
  const lines = [];
  return { lines, info: (obj, msg) => lines.push({ obj, msg }), warn() {}, error() {}, debug() {} };
}
// a capturing alert emitter.
function makeAlerts() {
  const calls = [];
  return { calls, emit: (input) => calls.push(input) };
}

const GAUGE_MSG = "scheduler: replica freshness (CTL-1366)";
const NOW_MS = 1_000_000_000_000;
const now = () => NOW_MS;

beforeEach(() => _resetReplicaStaleAlertState());

describe("maybeEmitReplicaFreshness — gauge emit (CTL-1366)", () => {
  test("emits the gauge line with staleness ≈ (now - maxUpdatedAtMs)/1000 + rows", () => {
    const log = makeLog();
    const replica = { freshness: () => ({ maxUpdatedAtMs: NOW_MS - 120_000, rowCount: 42 }) };
    maybeEmitReplicaFreshness({ replica, now, env: {}, log, emitAlert: () => {} });
    const line = log.lines.find((l) => l.msg === GAUGE_MSG);
    expect(line).toBeTruthy();
    expect(line.obj["catalyst.linear.replica.staleness"]).toBeCloseTo(120, 6);
    expect(line.obj["catalyst.linear.replica.rows"]).toBe(42);
  });

  test("NO-OP when the replica reader is absent (tier off → no emit)", () => {
    const log = makeLog();
    maybeEmitReplicaFreshness({ replica: undefined, now, env: {}, log, emitAlert: () => {} });
    expect(log.lines).toHaveLength(0);
  });

  test("NO-OP when freshness() returns undefined (fail-open MISS → no emit)", () => {
    const log = makeLog();
    const replica = { freshness: () => undefined };
    maybeEmitReplicaFreshness({ replica, now, env: {}, log, emitAlert: () => {} });
    expect(log.lines).toHaveLength(0);
  });

  test("NO-OP + no throw when freshness() throws (fail-open)", () => {
    const log = makeLog();
    const replica = {
      freshness: () => {
        throw new Error("db gone");
      },
    };
    expect(() =>
      maybeEmitReplicaFreshness({ replica, now, env: {}, log, emitAlert: () => {} }),
    ).not.toThrow();
    expect(log.lines).toHaveLength(0);
  });
});

describe("maybeEmitReplicaFreshness — data_stale edge trigger (CTL-1366)", () => {
  const env = { CATALYST_REPLICA_STALENESS_THRESHOLD_S: "600" };
  const replicaAt = (stalenessSeconds) => ({
    freshness: () => ({ maxUpdatedAtMs: NOW_MS - stalenessSeconds * 1000, rowCount: 1 }),
  });

  test("raises once on the up-crossing, holds while above (no re-raise)", () => {
    const alerts = makeAlerts();
    const log = makeLog();
    // tick 1: fresh (below threshold) → no alert
    maybeEmitReplicaFreshness({ replica: replicaAt(100), now, env, log, emitAlert: alerts.emit });
    expect(alerts.calls).toHaveLength(0);
    // tick 2: crosses up → raised once
    maybeEmitReplicaFreshness({ replica: replicaAt(900), now, env, log, emitAlert: alerts.emit });
    expect(alerts.calls).toHaveLength(1);
    expect(alerts.calls[0]).toMatchObject({ action: "raised", kind: "data_stale", layer: "replica" });
    expect(alerts.calls[0].lagSeconds).toBeCloseTo(900, 6);
    expect(alerts.calls[0].threshold).toBe(600);
    // tick 3: still above → held, no re-raise
    maybeEmitReplicaFreshness({ replica: replicaAt(1200), now, env, log, emitAlert: alerts.emit });
    expect(alerts.calls).toHaveLength(1);
  });

  test("clears once on recovery, no re-clear while below", () => {
    const alerts = makeAlerts();
    const log = makeLog();
    maybeEmitReplicaFreshness({ replica: replicaAt(900), now, env, log, emitAlert: alerts.emit }); // raised
    maybeEmitReplicaFreshness({ replica: replicaAt(100), now, env, log, emitAlert: alerts.emit }); // cleared
    expect(alerts.calls).toHaveLength(2);
    expect(alerts.calls[1]).toMatchObject({ action: "cleared", kind: "data_stale", layer: "replica" });
    // still below → no further emits
    maybeEmitReplicaFreshness({ replica: replicaAt(50), now, env, log, emitAlert: alerts.emit });
    expect(alerts.calls).toHaveLength(2);
  });

  test("default threshold applies when the env var is unset", () => {
    const alerts = makeAlerts();
    const log = makeLog();
    const justBelow = REPLICA_STALENESS_THRESHOLD_DEFAULT_S - 1;
    const justAbove = REPLICA_STALENESS_THRESHOLD_DEFAULT_S + 1;
    maybeEmitReplicaFreshness({ replica: replicaAt(justBelow), now, env: {}, log, emitAlert: alerts.emit });
    expect(alerts.calls).toHaveLength(0); // below default 600 → no raise
    maybeEmitReplicaFreshness({ replica: replicaAt(justAbove), now, env: {}, log, emitAlert: alerts.emit });
    expect(alerts.calls).toHaveLength(1);
    expect(alerts.calls[0].action).toBe("raised");
  });
});
