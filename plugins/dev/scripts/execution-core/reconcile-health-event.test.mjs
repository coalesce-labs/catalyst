// reconcile-health-event.test.mjs — CTL-867: canonical
// monitor.reconcile.{failing,recovered} events.
// Run: cd plugins/dev/scripts/execution-core && bun test reconcile-health-event.test.mjs
import { describe, test, expect } from "bun:test";
import {
  buildReconcileHealthEvent,
  appendReconcileHealthEvent,
  RECONCILE_FAILING_ACTION,
  RECONCILE_RECOVERED_ACTION,
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

  test("recovered envelope — INFO severity", () => {
    const ev = JSON.parse(
      buildReconcileHealthEvent({ team: "CTL", action: RECONCILE_RECOVERED_ACTION }),
    );
    expect(ev.attributes["event.name"]).toBe("monitor.reconcile.recovered.CTL");
    expect(ev.attributes["event.action"]).toBe("reconcile.recovered");
    expect(ev.severityText).toBe("INFO");
    expect(ev.severityNumber).toBe(9);
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
