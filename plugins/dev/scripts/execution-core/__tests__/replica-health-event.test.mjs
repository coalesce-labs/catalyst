// replica-health-event.test.mjs — CAT-35: canonical
// monitor.replica.{degraded,recovered} events.
// Run: cd plugins/dev/scripts/execution-core && bun test __tests__/replica-health-event.test.mjs
//
// Mirrors reconcile-health-event.test.mjs, the sibling this module was modeled
// on. Every `append` seam is injected — a test must never write the real
// unified event log.
import { describe, test, expect } from "bun:test";
import {
  buildReplicaHealthEvent,
  appendReplicaHealthEvent,
  REPLICA_DEGRADED_ACTION,
  REPLICA_RECOVERED_ACTION,
} from "../replica-health-event.mjs";

describe("buildReplicaHealthEvent", () => {
  test("degraded envelope — WARN, team-keyed name, source attribute", () => {
    const line = buildReplicaHealthEvent({
      team: "CAT",
      action: REPLICA_DEGRADED_ACTION,
      source: "replica-miss",
      consecutiveDegraded: 3,
    });
    expect(typeof line).toBe("string");
    expect(line.endsWith("\n")).toBe(true);
    const ev = JSON.parse(line);
    expect(ev.attributes["event.name"]).toBe("monitor.replica.degraded.CAT");
    expect(ev.attributes["event.entity"]).toBe("monitor");
    expect(ev.attributes["event.action"]).toBe("replica.degraded");
    expect(ev.attributes["event.label"]).toBe("CAT");
    expect(ev.attributes["catalyst.team"]).toBe("CAT");
    expect(ev.attributes["replica.source"]).toBe("replica-miss");
    // A team-wide replica outage has no Linear issue identifier.
    expect(ev.attributes["linear.issue.identifier"]).toBeUndefined();
    expect(ev.resource["service.name"]).toBe("catalyst.execution-core");
    expect(ev.severityText).toBe("WARN");
    expect(ev.severityNumber).toBe(13);
    expect(ev.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(ev.observedTs).toBe(ev.ts);
    expect(ev.id).toMatch(/^[0-9a-f]{16}$/);
    expect(ev.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ev.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  test("recovered envelope — INFO severity, recovered action", () => {
    const ev = JSON.parse(
      buildReplicaHealthEvent({
        team: "CAT",
        action: REPLICA_RECOVERED_ACTION,
        source: "replica",
        consecutiveDegraded: 0,
      }),
    );
    expect(ev.attributes["event.name"]).toBe("monitor.replica.recovered.CAT");
    expect(ev.attributes["event.action"]).toBe("replica.recovered");
    expect(ev.severityText).toBe("INFO");
    expect(ev.severityNumber).toBe(9);
  });

  test("source is omitted entirely — not empty-string — when absent", () => {
    const ev = JSON.parse(
      buildReplicaHealthEvent({ team: "CAT", action: REPLICA_DEGRADED_ACTION }),
    );
    expect("replica.source" in ev.attributes).toBe(false);
    expect(ev.body.payload.source).toBeNull();
    expect(ev.body.payload.consecutiveDegraded).toBe(0);
  });

  test("body.payload carries the full context", () => {
    const ev = JSON.parse(
      buildReplicaHealthEvent({
        team: "SKI",
        action: REPLICA_DEGRADED_ACTION,
        source: "no-replica",
        consecutiveDegraded: 7,
      }),
    );
    expect(ev.body.payload).toEqual({
      team: "SKI",
      action: "degraded",
      source: "no-replica",
      consecutiveDegraded: 7,
    });
    // NOTE (CAT-35 verify finding): consecutiveDegraded currently lives ONLY in
    // body.payload, and otel-forward's OTLP conversion (otel-forward/lib/
    // destinations/otlp.ts) forwards only `resource`, `body.message`, and
    // `attributes` — so the streak count never reaches Loki/Grafana. The
    // sibling reconcile-health-event.mjs mirrors its equivalent field into
    // attributes for exactly this reason (CTL-1628). This assertion pins the
    // current shape; it is deliberately NOT an endorsement of the gap.
    expect(ev.attributes["replica.consecutive_degraded"]).toBeUndefined();
  });

  test("each event gets a fresh id / traceId / spanId", () => {
    const a = JSON.parse(buildReplicaHealthEvent({ team: "CAT", action: REPLICA_DEGRADED_ACTION }));
    const b = JSON.parse(buildReplicaHealthEvent({ team: "CAT", action: REPLICA_DEGRADED_ACTION }));
    expect(a.id).not.toBe(b.id);
    expect(a.traceId).not.toBe(b.traceId);
    expect(a.spanId).not.toBe(b.spanId);
  });

  test("no-arg call does not throw and yields a parseable line", () => {
    const ev = JSON.parse(buildReplicaHealthEvent());
    expect(ev.attributes["event.name"]).toBe("monitor.replica.undefined.undefined");
    // action !== "degraded" ⇒ the INFO branch; documents the defaulting, which
    // is unreachable from recordReplicaRead (it always passes a real action).
    expect(ev.severityText).toBe("INFO");
  });
});

describe("appendReplicaHealthEvent", () => {
  test("returns true and hands the built line to the injected append", () => {
    const lines = [];
    const ok = appendReplicaHealthEvent({
      append: (line) => lines.push(line),
      team: "CAT",
      action: REPLICA_DEGRADED_ACTION,
      source: "no-replica",
      consecutiveDegraded: 3,
    });
    expect(ok).toBe(true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).attributes["event.name"]).toBe("monitor.replica.degraded.CAT");
  });

  test("returns false and never throws when the append fails", () => {
    let result;
    expect(() => {
      result = appendReplicaHealthEvent({
        append: () => {
          throw new Error("ENOSPC: no space left on device");
        },
        team: "CAT",
        action: REPLICA_DEGRADED_ACTION,
      });
    }).not.toThrow();
    // false is load-bearing: recordReplicaRead leaves `alerting` unset on a
    // false return so the degraded alert retries on the next read.
    expect(result).toBe(false);
  });
});
