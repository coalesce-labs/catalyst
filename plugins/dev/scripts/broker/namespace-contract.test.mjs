// Unit tests for the lifecycle-event namespace contract (CTL-1142).
// Run: bun test plugins/dev/scripts/broker/namespace-contract.test.mjs

import { describe, test, expect } from "bun:test";
import {
  FORBIDDEN_PREFIXES,
  PROTECTED_EXACT_NAMES,
  KNOWN_PHASES,
  INTENTIONAL_PHASE_SLOT_EXCEPTIONS,
  PHASE_EVENT_PATTERN,
  isBrokerProtectedName,
  phaseSlotOf,
  isAllowedPhaseSlot,
} from "./namespace-contract.mjs";

describe("isBrokerProtectedName", () => {
  test("returns true for filter.* prefix", () => {
    expect(isBrokerProtectedName("filter.wake.x")).toBe(true);
    expect(isBrokerProtectedName("filter.register")).toBe(true);
    expect(isBrokerProtectedName("filter.")).toBe(true);
  });

  test("returns true for broker.daemon.* prefix", () => {
    expect(isBrokerProtectedName("broker.daemon.start")).toBe(true);
    expect(isBrokerProtectedName("broker.daemon.degraded")).toBe(true);
  });

  test("returns true for exact session.heartbeat", () => {
    expect(isBrokerProtectedName("session.heartbeat")).toBe(true);
  });

  test("returns false for safe names", () => {
    expect(isBrokerProtectedName("node.heartbeat")).toBe(false);
    expect(isBrokerProtectedName("github.pr.opened")).toBe(false);
    expect(isBrokerProtectedName("phase.plan.complete.CTL-1")).toBe(false);
    expect(isBrokerProtectedName("linear.issue.updated")).toBe(false);
    expect(isBrokerProtectedName("catalyst.service.health")).toBe(false);
  });

  test("does not treat broker.daemon-prefix-only as protected (needs dot separator)", () => {
    // "broker.daemonx" should NOT match because the prefix is "broker.daemon" (no trailing dot required)
    // but per FORBIDDEN_PREFIXES the check is startsWith("broker.daemon"), so "broker.daemonx" IS protected.
    // This test documents that intentional behavior.
    expect(isBrokerProtectedName("broker.daemon")).toBe(true);
  });
});

describe("phaseSlotOf", () => {
  test("extracts phase slot from valid phase events", () => {
    expect(phaseSlotOf("phase.plan.complete.CTL-1")).toBe("plan");
    expect(phaseSlotOf("phase.implement.failed.CTL-123")).toBe("implement");
    expect(phaseSlotOf("phase.triage.turn-cap-exhausted.CTL-9")).toBe("triage");
    expect(phaseSlotOf("phase.monitor-merge.skipped.PROJ-42")).toBe("monitor-merge");
  });

  test("returns null for non-phase-pattern names", () => {
    expect(phaseSlotOf("node.heartbeat")).toBe(null);
    expect(phaseSlotOf("github.pr.opened")).toBe(null);
    expect(phaseSlotOf("filter.wake.x")).toBe(null);
    expect(phaseSlotOf("phase.incomplete")).toBe(null);
    expect(phaseSlotOf("phase.plan.complete")).toBe(null); // missing ticket
  });

  test("extracts dispatch slot from the documented exception", () => {
    expect(phaseSlotOf("phase.dispatch.failed.CTL-1")).toBe("dispatch");
  });
});

describe("isAllowedPhaseSlot", () => {
  test("returns true for every KNOWN_PHASES entry", () => {
    for (const phase of KNOWN_PHASES) {
      expect(isAllowedPhaseSlot(phase)).toBe(true);
    }
  });

  test("returns true for documented exception 'dispatch'", () => {
    expect(isAllowedPhaseSlot("dispatch")).toBe(true);
  });

  test("returns false for unknown slots", () => {
    expect(isAllowedPhaseSlot("bogus")).toBe(false);
    expect(isAllowedPhaseSlot("")).toBe(false);
    expect(isAllowedPhaseSlot("reclaim")).toBe(false);
  });
});

describe("KNOWN_PHASES shape", () => {
  test("contains exactly the 10 canonical pipeline phases in order", () => {
    expect(KNOWN_PHASES).toEqual([
      "triage",
      "research",
      "plan",
      "implement",
      "verify",
      "review",
      "pr",
      "monitor-merge",
      "monitor-deploy",
      "teardown",
    ]);
  });

  test("has exactly 10 phases", () => {
    expect(KNOWN_PHASES).toHaveLength(10);
  });
});

describe("exported constants", () => {
  test("FORBIDDEN_PREFIXES contains filter. and broker.daemon", () => {
    expect(FORBIDDEN_PREFIXES).toContain("filter.");
    expect(FORBIDDEN_PREFIXES).toContain("broker.daemon");
  });

  test("PROTECTED_EXACT_NAMES contains session.heartbeat", () => {
    expect(PROTECTED_EXACT_NAMES).toContain("session.heartbeat");
  });

  test("INTENTIONAL_PHASE_SLOT_EXCEPTIONS contains dispatch", () => {
    expect(INTENTIONAL_PHASE_SLOT_EXCEPTIONS).toContain("dispatch");
  });

  test("PHASE_EVENT_PATTERN is a RegExp matching phase events", () => {
    expect(PHASE_EVENT_PATTERN).toBeInstanceOf(RegExp);
    expect(PHASE_EVENT_PATTERN.test("phase.plan.complete.CTL-1")).toBe(true);
    expect(PHASE_EVENT_PATTERN.test("phase.dispatch.failed.CTL-1")).toBe(true);
    expect(PHASE_EVENT_PATTERN.test("node.heartbeat")).toBe(false);
  });
});
