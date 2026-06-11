// service-health-emitter.test.ts — CTL-1050 §3.1: the debounced outage AUDIT
// trail. Exactly one down envelope on enter-down; no emit on degraded; recovery
// only after 60s sustained up; flap inside the holddown emits nothing extra.

import { describe, it, expect } from "bun:test";
import {
  type ServiceHealthTransition,
  createServiceHealthEmitter,
  RECOVERY_HOLD_MS,
  REEMIT_HOLDDOWN_MS,
} from "../lib/service-health-emitter";
import type { ServiceStatus, ServiceSeverity } from "../lib/service-health";

function status(id: string, severity: ServiceSeverity, downSince: number | null = null): ServiceStatus {
  return {
    id: id as ServiceStatus["id"],
    label: id === "loki" ? "Loki" : id,
    severity,
    lastCheckedAt: 0,
    lastOkAt: null,
    consecutiveFailures: severity === "down" ? 3 : 0,
    latencyMs: null,
    detail: null,
    target: "http://x",
    configSource: "otel.lokiUrl",
    downSince,
  };
}

/** Drive an emitter and capture every appended transition. */
function harness() {
  const appended: ServiceHealthTransition[] = [];
  let clock = 0;
  const emitter = createServiceHealthEmitter({
    append: (t) => appended.push(t),
    now: () => clock,
  });
  return {
    appended,
    observe(services: ServiceStatus[], at: number) {
      clock = at;
      emitter.observe(services);
    },
  };
}

describe("enter-down emission", () => {
  it("emits exactly one down envelope on enter-down (already 3 failures)", () => {
    const h = harness();
    h.observe([status("loki", "up")], 0);
    h.observe([status("loki", "down", 60_000)], 60_000);
    // Still down on subsequent ticks → no re-emit.
    h.observe([status("loki", "down", 60_000)], 90_000);

    const downs = h.appended.filter((t) => t.action === "down");
    expect(downs).toHaveLength(1);
    expect(downs[0].serviceId).toBe("loki");
    expect(downs[0].severityText).toBe("ERROR");
    expect(downs[0].label).toBe("Loki");
    // Body carries the since-time + consequence clause.
    expect(downs[0].body).toContain("Loki is unreachable since");
    expect(downs[0].body).toContain("telemetry views degraded");
  });

  it("does NOT emit on degraded (only down)", () => {
    const h = harness();
    h.observe([status("loki", "up")], 0);
    h.observe([status("loki", "degraded")], 30_000);
    expect(h.appended).toHaveLength(0);
  });

  it("never emits for unknown/unconfigured services", () => {
    const h = harness();
    h.observe([status("grafana", "unknown")], 0);
    h.observe([status("grafana", "unknown")], 30_000);
    expect(h.appended).toHaveLength(0);
  });
});

describe("recovery (sustained 60s)", () => {
  it("emits recovered only after up has held RECOVERY_HOLD_MS", () => {
    const h = harness();
    h.observe([status("loki", "down", 0)], 0);
    expect(h.appended.filter((t) => t.action === "down")).toHaveLength(1);

    // up at t=100_000 — hold starts, no recovered yet.
    h.observe([status("loki", "up")], 100_000);
    expect(h.appended.filter((t) => t.action === "recovered")).toHaveLength(0);

    // Still up but BEFORE the hold elapses → no recovered.
    h.observe([status("loki", "up")], 100_000 + RECOVERY_HOLD_MS - 1);
    expect(h.appended.filter((t) => t.action === "recovered")).toHaveLength(0);

    // up SUSTAINED past the hold → recovered (INFO).
    h.observe([status("loki", "up")], 100_000 + RECOVERY_HOLD_MS);
    const recovered = h.appended.filter((t) => t.action === "recovered");
    expect(recovered).toHaveLength(1);
    expect(recovered[0].severityText).toBe("INFO");
  });

  it("a down→up→down flap inside the hold emits nothing extra", () => {
    const h = harness();
    h.observe([status("loki", "down", 0)], 0);
    h.observe([status("loki", "up")], 10_000); // hold starts
    h.observe([status("loki", "down", 20_000)], 20_000); // flap back inside hold
    h.observe([status("loki", "down", 20_000)], 30_000);

    // One down (the original enter), zero recovered (the flap killed the hold;
    // the re-down is inside the REEMIT holddown so no second down either).
    expect(h.appended.filter((t) => t.action === "down")).toHaveLength(1);
    expect(h.appended.filter((t) => t.action === "recovered")).toHaveLength(0);
  });
});

describe("re-emit holddown (flap guard)", () => {
  it("after a down/recovered pair, a re-down INSIDE the holddown is suppressed", () => {
    const h = harness();
    // down → recovered pair.
    h.observe([status("loki", "down", 0)], 0);
    h.observe([status("loki", "up")], 10_000);
    h.observe([status("loki", "up")], 10_000 + RECOVERY_HOLD_MS); // recovered emits
    expect(h.appended.filter((t) => t.action === "down")).toHaveLength(1);
    expect(h.appended.filter((t) => t.action === "recovered")).toHaveLength(1);

    // Re-down INSIDE the holddown window (measured from recovered) → suppressed.
    const recoveredAt = 10_000 + RECOVERY_HOLD_MS;
    h.observe([status("loki", "down", recoveredAt + 5_000)], recoveredAt + 5_000);
    expect(h.appended.filter((t) => t.action === "down")).toHaveLength(1);

    // A re-down AFTER the holddown elapses emits again (new pair). The service
    // must bounce up (sustained) first so downEmitted resets, then go down again.
    const afterHolddown = recoveredAt + REEMIT_HOLDDOWN_MS + RECOVERY_HOLD_MS + 1;
    h.observe([status("loki", "up")], afterHolddown - RECOVERY_HOLD_MS - 1);
    h.observe([status("loki", "up")], afterHolddown - 1); // sustained up resets state
    h.observe([status("loki", "down", afterHolddown)], afterHolddown);
    expect(h.appended.filter((t) => t.action === "down").length).toBeGreaterThanOrEqual(2);
  });
});
