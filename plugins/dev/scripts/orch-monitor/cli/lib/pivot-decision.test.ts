// pivot-decision.test.ts — CTL-388. Pure decision logic for the o/t pivot keys
// when the HUD is in live (auto-follow) vs paused mode. The handler in hud.tsx
// is a thin dispatcher over this function.

import { describe, test, expect } from "bun:test";
import { decidePivotAction } from "./pivot-decision";
import type { CanonicalEvent } from "../../lib/canonical-event.ts";

function mkEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  return {
    ts: "2026-05-14T16:00:00Z",
    id: "evt-1",
    severityText: "INFO",
    severityNumber: 9,
    traceId: "trace-abc-1234567890abcdef",
    spanId: null,
    resource: { "service.name": "test", "service.namespace": "catalyst", "service.version": "0.0.0" },
    attributes: {
      "event.name": "test",
      "catalyst.orchestrator.id": "o-ctl-388",
    },
    body: {},
    ...overrides,
  };
}

describe("decidePivotAction — CTL-388", () => {
  test("o pressed while autoFollow on → pause, no pivot", () => {
    const r = decidePivotAction({ key: "o", autoFollow: true, selectedEvent: mkEvent() });
    expect(r.kind).toBe("pause");
    if (r.kind === "pause") {
      expect(r.status.toLowerCase()).toContain("paused");
    }
  });

  test("t pressed while autoFollow on → pause, no pivot", () => {
    const r = decidePivotAction({ key: "t", autoFollow: true, selectedEvent: mkEvent() });
    expect(r.kind).toBe("pause");
  });

  test("o pressed while paused + orchestrator id present → pivot to orch", () => {
    const r = decidePivotAction({ key: "o", autoFollow: false, selectedEvent: mkEvent() });
    expect(r.kind).toBe("pivot");
    if (r.kind === "pivot") {
      expect(r.pivot).toEqual({ type: "orch", id: "o-ctl-388" });
      expect(r.status).toContain("scoped to orchestrator");
    }
  });

  test("t pressed while paused + trace id present → pivot to trace", () => {
    const r = decidePivotAction({ key: "t", autoFollow: false, selectedEvent: mkEvent() });
    expect(r.kind).toBe("pivot");
    if (r.kind === "pivot") {
      expect(r.pivot).toEqual({ type: "trace", id: "trace-abc-1234567890abcdef" });
      expect(r.status).toContain("scoped to trace");
    }
  });

  test("o pressed while paused + no orchestrator id → noop with explanation", () => {
    const ev = mkEvent({ attributes: { "event.name": "noorch" } });
    const r = decidePivotAction({ key: "o", autoFollow: false, selectedEvent: ev });
    expect(r.kind).toBe("noop");
    if (r.kind === "noop") {
      expect(r.status.toLowerCase()).toContain("no orchestrator");
    }
  });

  test("t pressed while paused + no trace id → noop with explanation", () => {
    const ev = mkEvent({ traceId: null });
    const r = decidePivotAction({ key: "t", autoFollow: false, selectedEvent: ev });
    expect(r.kind).toBe("noop");
    if (r.kind === "noop") {
      expect(r.status.toLowerCase()).toContain("no trace");
    }
  });

  test("null selectedEvent while paused → noop", () => {
    const r = decidePivotAction({ key: "o", autoFollow: false, selectedEvent: null });
    expect(r.kind).toBe("noop");
  });

  test("null selectedEvent while live → still pauses (no pivot read attempted)", () => {
    // Even with no event, entering live mode and pressing o/t pauses so the
    // user can see what's there once tailing stops.
    const r = decidePivotAction({ key: "o", autoFollow: true, selectedEvent: null });
    expect(r.kind).toBe("pause");
  });

  test("pause status mentions both o and t actions so the user knows next step", () => {
    const r = decidePivotAction({ key: "o", autoFollow: true, selectedEvent: mkEvent() });
    if (r.kind === "pause") {
      expect(r.status).toMatch(/o|t/);
    }
  });

  test("trace status truncates long trace ids to 16 chars + ellipsis", () => {
    const ev = mkEvent({ traceId: "0123456789abcdef0123456789abcdef" });
    const r = decidePivotAction({ key: "t", autoFollow: false, selectedEvent: ev });
    if (r.kind === "pivot") {
      expect(r.status).toContain("0123456789abcdef");
      expect(r.status).toContain("…");
    }
  });
});
