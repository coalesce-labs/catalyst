import { describe, it, expect } from "bun:test";
import type { CanonicalEvent } from "../lib/canonical-event.ts";
import {
  computeDispatchLatencies,
  latencyKeyForEvent,
} from "../cli/lib/dispatch-latency.ts";

// Minimal canonical-event factory — only the fields computeDispatchLatencies
// reads (ts, attributes["event.name"], body.payload.target_phase). The rest of
// the envelope is irrelevant to the pairing math.
function evt(
  name: string,
  ts: string,
  payload: Record<string, unknown> = {},
): CanonicalEvent {
  return {
    ts,
    id: "x",
    severityText: "INFO",
    severityNumber: 9,
    traceId: null,
    spanId: null,
    resource: { "service.name": "t", "service.namespace": "catalyst", "service.version": "0" },
    attributes: { "event.name": name },
    body: { payload },
  } as CanonicalEvent;
}

const T0 = "2026-05-27T10:00:00.000Z";
const T1 = "2026-05-27T10:00:02.500Z"; // +2500ms
const T2 = "2026-05-27T10:05:00.000Z"; // +297500ms from T1

describe("computeDispatchLatencies", () => {
  it("pairs requested→launched→complete into pickupMs + wallClockMs", () => {
    const events = [
      evt("phase.dispatch.requested.CTL-1", T0, { target_phase: "implement", reason: "advance" }),
      evt("phase.dispatch.launched.CTL-1", T1, { target_phase: "implement", bg_job_id: "ab12" }),
      evt("phase.implement.complete.CTL-1", T2, {}),
    ];
    const map = computeDispatchLatencies(events);
    const l = map.get("CTL-1:implement");
    expect(l).toBeDefined();
    expect(l?.pickupMs).toBe(Date.parse(T1) - Date.parse(T0)); // 2500
    expect(l?.wallClockMs).toBe(Date.parse(T2) - Date.parse(T1));
  });

  it("missing launched → pickupMs/wallClockMs undefined (no crash)", () => {
    const events = [
      evt("phase.dispatch.requested.CTL-2", T0, { target_phase: "research" }),
      evt("phase.research.complete.CTL-2", T2, {}),
    ];
    const map = computeDispatchLatencies(events);
    const l = map.get("CTL-2:research");
    expect(l).toBeDefined();
    expect(l?.requestedTs).toBe(Date.parse(T0));
    expect(l?.completeTs).toBe(Date.parse(T2));
    expect(l?.pickupMs).toBeUndefined();
    expect(l?.wallClockMs).toBeUndefined();
  });

  it("keys multiple tickets/phases independently and tolerates out-of-order arrival", () => {
    const events = [
      // complete arrives before its launched (out of order)
      evt("phase.implement.complete.CTL-3", T2, {}),
      evt("phase.dispatch.launched.CTL-3", T1, { target_phase: "implement" }),
      evt("phase.dispatch.requested.CTL-3", T0, { target_phase: "implement", reason: "advance" }),
      // a second, independent (ticket, phase) pairing
      evt("phase.dispatch.requested.CTL-4", T0, { target_phase: "research", reason: "new-work" }),
      evt("phase.dispatch.launched.CTL-4", T1, { target_phase: "research" }),
    ];
    const map = computeDispatchLatencies(events);
    expect(map.get("CTL-3:implement")?.pickupMs).toBe(Date.parse(T1) - Date.parse(T0));
    expect(map.get("CTL-3:implement")?.wallClockMs).toBe(Date.parse(T2) - Date.parse(T1));
    expect(map.get("CTL-4:research")?.pickupMs).toBe(Date.parse(T1) - Date.parse(T0));
    expect(map.get("CTL-4:research")?.wallClockMs).toBeUndefined(); // no complete
  });

  it("a dispatch event without target_phase is skipped (cannot be keyed)", () => {
    const events = [
      evt("phase.dispatch.requested.CTL-5", T0, {}), // no target_phase
      evt("phase.dispatch.launched.CTL-5", T1, { target_phase: "plan" }),
    ];
    const map = computeDispatchLatencies(events);
    // Only the launched event keyed CTL-5:plan; requested was dropped.
    const l = map.get("CTL-5:plan");
    expect(l?.launchedTs).toBe(Date.parse(T1));
    expect(l?.requestedTs).toBeUndefined();
  });

  it("ignores non-lifecycle events and unparseable timestamps", () => {
    const events = [
      evt("phase.dispatch.failed.CTL-6", T0, { target_phase: "implement" }), // failed not paired
      evt("github.pr.opened.CTL-6", T0, {}),
      evt("phase.dispatch.requested.CTL-6", "not-a-date", { target_phase: "implement" }),
    ];
    const map = computeDispatchLatencies(events);
    expect(map.size).toBe(0);
  });

  it("handles hyphenated phase slots in complete events (monitor-deploy)", () => {
    const events = [
      evt("phase.dispatch.launched.CTL-7", T1, { target_phase: "monitor-deploy" }),
      evt("phase.monitor-deploy.complete.CTL-7", T2, {}),
    ];
    const map = computeDispatchLatencies(events);
    expect(map.get("CTL-7:monitor-deploy")?.wallClockMs).toBe(Date.parse(T2) - Date.parse(T1));
  });
});

describe("latencyKeyForEvent", () => {
  it("derives <ticket>:<target_phase> for dispatch events", () => {
    expect(
      latencyKeyForEvent(evt("phase.dispatch.launched.CTL-1", T1, { target_phase: "implement" })),
    ).toBe("CTL-1:implement");
  });

  it("derives <ticket>:<phase> from the name for complete events", () => {
    expect(latencyKeyForEvent(evt("phase.implement.complete.CTL-1", T2, {}))).toBe("CTL-1:implement");
  });

  it("returns null for non-lifecycle events and dispatch events without target_phase", () => {
    expect(latencyKeyForEvent(evt("github.pr.opened.CTL-1", T0, {}))).toBeNull();
    expect(latencyKeyForEvent(evt("phase.dispatch.requested.CTL-1", T0, {}))).toBeNull();
  });
});
