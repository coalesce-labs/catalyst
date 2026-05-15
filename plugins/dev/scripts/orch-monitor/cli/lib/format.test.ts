// CTL-419: unit tests for formatDetails wake-event rendering.
// Tests cover the batched stale_sessions payload and the recipient-short suffix
// appended to all filter.wake.* DETAILS cells.
import { describe, test, expect } from "bun:test";
import { formatDetails, formatRef } from "./format";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";

function makeWakeEvent(
  recipientSessId: string,
  payload: Record<string, unknown>,
): CanonicalEvent {
  return {
    id: "test-id",
    ts: "2026-05-14T00:00:00.000Z",
    observedTs: "2026-05-14T00:00:00.000Z",
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: { "service.name": "test" },
    attributes: { "event.name": `filter.wake.${recipientSessId}` },
    body: { payload },
  } as unknown as CanonicalEvent;
}

describe("formatDetails — filter.wake events (CTL-419)", () => {
  test("single stale session: shows reason with recipient short suffix", () => {
    const event = makeWakeEvent("sess_20260511T203845_16d33281", {
      reason: "No heartbeat from worker-A for >4 min",
      stale_sessions: ["worker-A"],
      stale_count: 1,
      source_event_ids: [],
      source_events: [],
    });
    const details = formatDetails(event);
    expect(details).toContain("wake →");
    expect(details).toContain("16d33281");
  });

  test("multi stale: shows stale count + recipient short", () => {
    const event = makeWakeEvent("sess_20260511T203845_16d33281", {
      reason: "3 sessions stale",
      stale_sessions: ["worker-A", "worker-B", "worker-C"],
      stale_count: 3,
      source_event_ids: [],
      source_events: [],
    });
    const details = formatDetails(event);
    expect(details).toMatch(/3 sessions stale/);
    expect(details).toContain("16d33281");
  });

  test("legacy reason without stale_sessions: still appends recipient", () => {
    const event = makeWakeEvent("sess_abc_deadbeef", {
      reason: "No heartbeat from old-worker for >5 min",
      source_event_ids: [],
      source_events: [],
    });
    const details = formatDetails(event);
    expect(details).toContain("deadbeef");
  });

  test("structured source_events path: appends recipient short", () => {
    const event = makeWakeEvent("sess_abc_feedface", {
      source_events: [
        {
          name: "linear.issue.state_changed",
          ticket: "CTL-99",
          payload_excerpt: { state: "Done" },
        },
      ],
      source_event_ids: ["evt-1"],
    });
    const details = formatDetails(event);
    expect(details).toMatch(/wake ← linear\.issue\.state_changed CTL-99 → Done/);
    expect(details).toContain("feedface");
  });

  test("session ID with no underscore: uses full id as short form", () => {
    const event = makeWakeEvent("orchestrator-1", {
      reason: "No heartbeat from w for >3 min",
      stale_sessions: ["w"],
      stale_count: 1,
      source_event_ids: [],
      source_events: [],
    });
    const details = formatDetails(event);
    expect(details).toContain("orchestrator-1");
  });
});

describe("formatRef — filter.wake (CTL-419 — unchanged)", () => {
  test("still returns stripped session id", () => {
    const event = makeWakeEvent("sess_20260511T203845_16d33281", {});
    expect(formatRef(event)).toBe("sess_20260511T203845_16d33281");
  });
});
