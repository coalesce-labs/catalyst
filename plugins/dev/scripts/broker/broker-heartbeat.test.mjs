// broker-heartbeat.test.mjs — CTL-1171.
//
// The broker emits a periodic liveness heartbeat so an idle broker (no registered
// interests, no webhooks) does NOT false-report "down" in the monitor, which
// classifies broker health purely by event-log recency (service.name=catalyst.broker:
// degraded > 3m, down > 10m). These guards pin the pure event factory's shape and
// the cadence invariant; the setInterval wiring in main() is a one-liner over them.
import { describe, test, expect } from "bun:test";
import {
  buildBrokerHeartbeatEvent,
  BROKER_HEARTBEAT_INTERVAL_MS,
} from "./index.mjs";

describe("CTL-1171 broker liveness heartbeat", () => {
  test("buildBrokerHeartbeatEvent emits a catalyst.broker lifecycle beat", () => {
    const ev = buildBrokerHeartbeatEvent({ pid: 4242, activeInterests: 0 });
    // The monitor keys off the event NAME recency under service.name=catalyst.broker
    // (appendEvent stamps the resource); broker:true marks it a daemon lifecycle event.
    expect(ev.event).toBe("broker.daemon.heartbeat");
    expect(ev.detail.broker).toBe(true);
    expect(ev.severity).toBe("INFO");
  });

  test("carries pid + active-interest count for at-a-glance liveness", () => {
    const ev = buildBrokerHeartbeatEvent({ pid: 99, activeInterests: 3 });
    expect(ev.detail.pid).toBe(99);
    expect(ev.detail.active_interests).toBe(3);
    // it is an unattributed daemon-level event (not orchestrator/worker scoped)
    expect(ev.orchestrator).toBeNull();
    expect(ev.worker).toBeNull();
  });

  test("the beat is an INFO heartbeat, NOT a degraded/warn signal", () => {
    // Regression guard: an idle broker beat must never read as degraded — that was
    // the whole false-down problem. Severity stays INFO regardless of interest count.
    expect(buildBrokerHeartbeatEvent({ pid: 1, activeInterests: 0 }).severity).toBe("INFO");
  });

  test("cadence stays comfortably under the monitor's 3-minute degraded threshold", () => {
    // Monitor: degraded > 3m, down > 10m (orch-monitor service-health.ts). A beat
    // well under 3m guarantees recency never crosses degraded while the broker lives.
    expect(BROKER_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
    expect(BROKER_HEARTBEAT_INTERVAL_MS).toBeLessThan(3 * 60_000);
  });
});
