import { describe, test, expect } from "bun:test";
import { classifyEventStream, COORDINATION_PREFIXES } from "./event-stream-class.mjs";
import { KNOWN_PHASES, INTENTIONAL_PHASE_SLOT_EXCEPTIONS } from "../broker/namespace-contract.mjs";

describe("classifyEventStream", () => {
  test("phase.* for every KNOWN_PHASES entry classifies coordination", () => {
    for (const phase of KNOWN_PHASES) {
      expect(classifyEventStream(`phase.${phase}.complete.CTL-1`)).toBe("coordination");
    }
  });
  test.each([
    "worker.transition.CTL-1",
    "escalation.raised.CTL-1", // future name (Phase 5) — allowlisted now
    "resume.requested.CTL-1", // future name (Phase 4) — allowlisted now
    "linear.comment.created",
    "github.pr.merged",
    "comms.message.posted",
  ])("%s classifies coordination", (name) => {
    expect(classifyEventStream(name)).toBe("coordination");
  });
  test("phase.<slot>.* for every INTENTIONAL_PHASE_SLOT_EXCEPTIONS entry classifies coordination", () => {
    // dispatch/scheduler/advance emit `phase.<slot>.*.<ticket>` observability/failure events that are
    // still cross-host coordination signal (event-stream-class.mjs:27-30). Assert each, so a future
    // removal from the exceptions list can't silently reclassify them to telemetry.
    for (const slot of INTENTIONAL_PHASE_SLOT_EXCEPTIONS) {
      expect(classifyEventStream(`phase.${slot}.failed.CTL-1`)).toBe("coordination");
    }
  });
  test.each([
    "session.heartbeat", // PROTECTED_EXACT_NAMES (namespace-contract.mjs:31)
    "host.metrics.sampled",
    "host.process.sampled",
  ])("%s classifies telemetry", (name) => {
    expect(classifyEventStream(name)).toBe("telemetry");
  });
  test("unrecognized/future event name classifies telemetry (fail-closed default)", () => {
    expect(classifyEventStream("some.brand.new.event")).toBe("telemetry");
  });
  test("filter.* / broker.daemon.* (broker-protected namespaces) classify telemetry, never coordination", () => {
    expect(classifyEventStream("filter.wake.CTL-1")).toBe("telemetry");
    expect(classifyEventStream("broker.daemon.startup")).toBe("telemetry");
  });
  test("null/undefined/empty event name classifies telemetry (fail-closed)", () => {
    expect(classifyEventStream(undefined)).toBe("telemetry");
    expect(classifyEventStream(null)).toBe("telemetry");
    expect(classifyEventStream("")).toBe("telemetry");
  });
  test("COORDINATION_PREFIXES covers every KNOWN_PHASES phase (allowlists cannot drift)", () => {
    for (const phase of KNOWN_PHASES) {
      expect(COORDINATION_PREFIXES).toContain(`phase.${phase}.`);
    }
  });
  test("COORDINATION_PREFIXES covers every INTENTIONAL_PHASE_SLOT_EXCEPTIONS slot (allowlists cannot drift)", () => {
    for (const slot of INTENTIONAL_PHASE_SLOT_EXCEPTIONS) {
      expect(COORDINATION_PREFIXES).toContain(`phase.${slot}.`);
    }
  });
});
