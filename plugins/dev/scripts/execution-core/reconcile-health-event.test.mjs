// reconcile-health-event.test.mjs — CTL-867: canonical
// monitor.reconcile.{failing,recovered} events.
// Run: cd plugins/dev/scripts/execution-core && bun test reconcile-health-event.test.mjs
import { describe, test, expect } from "bun:test";
import {
  buildReconcileHealthEvent,
  appendReconcileHealthEvent,
  RECONCILE_FAILING_ACTION,
  RECONCILE_RECOVERED_ACTION,
  ELIGIBLE_PERSIST_FAILURE_ACTION,
} from "./reconcile-health-event.mjs";

describe("buildReconcileHealthEvent", () => {
  test("failing envelope — WARN, team-keyed name, payload carries failure context", () => {
    const line = buildReconcileHealthEvent({
      team: "CTL",
      action: RECONCILE_FAILING_ACTION,
      consecutiveFailures: 3,
      lastSuccessTs: "2026-06-08T10:00:00Z",
      staleMs: 1800000,
      reason: "removed-state: Ready",
    });
    expect(typeof line).toBe("string");
    expect(line.endsWith("\n")).toBe(true);
    const ev = JSON.parse(line);
    expect(ev.attributes["event.name"]).toBe("monitor.reconcile.failing.CTL");
    expect(ev.attributes["event.entity"]).toBe("monitor");
    expect(ev.attributes["event.action"]).toBe("reconcile.failing");
    expect(ev.attributes["event.label"]).toBe("CTL");
    expect(ev.attributes["catalyst.team"]).toBe("CTL");
    // A team-wide failure has no Linear issue identifier.
    expect(ev.attributes["linear.issue.identifier"]).toBeUndefined();
    expect(ev.resource["service.name"]).toBe("catalyst.execution-core");
    expect(ev.severityText).toBe("WARN");
    expect(ev.severityNumber).toBe(13);
    // CTL-1628: reason must also land in attributes — otel-forward's OTLP
    // conversion never reads body.payload, so a reason confined to the body
    // is invisible to every Loki/Grafana consumer.
    expect(ev.attributes["reconcile.reason"]).toBe("removed-state: Ready");
    expect(ev.body.payload).toMatchObject({
      team: "CTL",
      action: "failing",
      consecutiveFailures: 3,
      lastSuccessTs: "2026-06-08T10:00:00Z",
      staleMs: 1800000,
      reason: "removed-state: Ready",
    });
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test("reason attribute is truncated to 200 chars and omitted entirely when absent", () => {
    const long = "x".repeat(500);
    const withReason = JSON.parse(
      buildReconcileHealthEvent({ team: "CTL", action: RECONCILE_FAILING_ACTION, reason: long }),
    );
    expect(withReason.attributes["reconcile.reason"]).toHaveLength(200);
    expect(withReason.attributes["reconcile.reason"]).toBe(long.slice(0, 200));
    // full untruncated reason still survives for local/file consumers via the body
    expect(withReason.body.payload.reason).toBe(long);

    const withoutReason = JSON.parse(
      buildReconcileHealthEvent({ team: "CTL", action: RECONCILE_FAILING_ACTION }),
    );
    expect(withoutReason.attributes["reconcile.reason"]).toBeUndefined();
  });

  test("recovered envelope — INFO severity", () => {
    const ev = JSON.parse(
      buildReconcileHealthEvent({ team: "CTL", action: RECONCILE_RECOVERED_ACTION }),
    );
    expect(ev.attributes["event.name"]).toBe("monitor.reconcile.recovered.CTL");
    expect(ev.attributes["event.action"]).toBe("reconcile.recovered");
    expect(ev.severityText).toBe("INFO");
    expect(ev.severityNumber).toBe(9);
  });

  // CTL-1628: the eligible-set disk-projection write failure — a sibling
  // failure mode of the reconcile-poll failure above, but with no
  // consecutive-failure/alert-latch tracking (monitor.mjs fires this every
  // time, not after N consecutive misses) — reuses this same envelope
  // builder/action-naming scheme.
  test("eligible_persist_failure envelope — WARN, team-keyed name, carries the persist error", () => {
    const ev = JSON.parse(
      buildReconcileHealthEvent({
        team: "CTL",
        action: ELIGIBLE_PERSIST_FAILURE_ACTION,
        reason: "ENOSPC: no space left on device",
      }),
    );
    expect(ev.attributes["event.name"]).toBe("monitor.reconcile.eligible_persist_failure.CTL");
    expect(ev.attributes["event.action"]).toBe("reconcile.eligible_persist_failure");
    expect(ev.severityText).toBe("WARN");
    expect(ev.severityNumber).toBe(13);
    expect(ev.attributes["reconcile.reason"]).toBe("ENOSPC: no space left on device");
    expect(ev.body.payload).toMatchObject({
      team: "CTL",
      action: "eligible_persist_failure",
      reason: "ENOSPC: no space left on device",
    });
  });

  test("optional payload fields default to null when omitted", () => {
    const ev = JSON.parse(buildReconcileHealthEvent({ team: "CTL", action: "failing" }));
    expect(ev.body.payload.consecutiveFailures).toBeNull();
    expect(ev.body.payload.lastSuccessTs).toBeNull();
    expect(ev.body.payload.staleMs).toBeNull();
    expect(ev.body.payload.reason).toBeNull();
  });
});

describe("appendReconcileHealthEvent", () => {
  test("best-effort: injected appendFn that throws returns false and does not throw", () => {
    const result = appendReconcileHealthEvent({
      team: "CTL",
      action: "failing",
      append: () => {
        throw new Error("disk full");
      },
    });
    expect(result).toBe(false);
  });

  test("best-effort: injected appendFn receives valid JSONL, returns true", () => {
    const appended = [];
    const result = appendReconcileHealthEvent({
      team: "CTL",
      action: "failing",
      consecutiveFailures: 4,
      append: (line) => appended.push(line),
    });
    expect(result).toBe(true);
    expect(appended).toHaveLength(1);
    const ev = JSON.parse(appended[0]);
    expect(ev.attributes["event.name"]).toBe("monitor.reconcile.failing.CTL");
    expect(ev.body.payload.consecutiveFailures).toBe(4);
  });
});
