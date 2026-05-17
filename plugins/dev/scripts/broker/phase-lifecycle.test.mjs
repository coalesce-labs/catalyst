// Unit tests for catalyst-broker phase_lifecycle interest type (CTL-447).
// Run: bun test plugins/dev/scripts/broker/phase-lifecycle.test.mjs
//
// Six tests track the success criteria in the architecture plan §Initiative 1
// Phase 1: register, ticket isolation, phase isolation, failed-event wake,
// checkout deregister, and persistence round-trip.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleRegister,
  handleAgentCheckout,
  tryPhaseLifecycleRoute,
  buildGroqPrompt,
  buildBrokerState,
  getInterests,
  clearInterests,
  loadPersistedInterests,
  saveInterests,
  __clearEmittedWakeCacheForTest,
} from "./index.mjs";
import { openBrokerStateDb, closeBrokerStateDb } from "./broker-state.mjs";

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "broker-phase-test-"));
  process.env.CATALYST_DIR = tmpDir;
  openBrokerStateDb(join(tmpDir, "test.db"));
  clearInterests();
  __clearEmittedWakeCacheForTest();
});

afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CATALYST_DIR;
});

function registerPhaseInterest({
  interestId = "watcher-1",
  ticket = "CTL-100",
  phaseNames = ["research", "plan"],
  orchestrator = "orch-1",
  sessionId = "watcher-1",
  persistent = true,
} = {}) {
  handleRegister({
    event: "filter.register",
    orchestrator,
    detail: {
      interest_id: interestId,
      notify_event: `filter.wake.${interestId}`,
      interest_type: "phase_lifecycle",
      ticket,
      phase_names: phaseNames,
      session_id: sessionId,
      persistent,
    },
  });
}

describe("phase_lifecycle interest type", () => {
  // Test 1
  test("register + matching phase.<name>.complete.<ticket> event produces a wake match", () => {
    registerPhaseInterest();
    const matches = tryPhaseLifecycleRoute(
      {
        ts: "2026-05-17T05:00:00Z",
        attributes: { "event.name": "phase.research.complete.CTL-100" },
        body: { payload: { ticket: "CTL-100", phase: "research" } },
      },
      getInterests()
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("watcher-1");
    expect(matches[0].reason).toMatch(/phase research complete/i);
    expect(matches[0].reason).toContain("CTL-100");
  });

  // Test 2
  test("ignores events for other tickets", () => {
    registerPhaseInterest({ ticket: "CTL-100" });
    const matches = tryPhaseLifecycleRoute(
      {
        ts: "2026-05-17T05:00:00Z",
        attributes: { "event.name": "phase.research.complete.CTL-999" },
        body: { payload: { ticket: "CTL-999", phase: "research" } },
      },
      getInterests()
    );
    expect(matches).toHaveLength(0);
  });

  // Test 3
  test("ignores events for phases not in phase_names", () => {
    registerPhaseInterest({ phaseNames: ["research", "plan"] });
    const matches = tryPhaseLifecycleRoute(
      {
        ts: "2026-05-17T05:00:00Z",
        attributes: { "event.name": "phase.implement.complete.CTL-100" },
        body: { payload: { ticket: "CTL-100", phase: "implement" } },
      },
      getInterests()
    );
    expect(matches).toHaveLength(0);
  });

  // Test 4
  test("phase.<name>.failed.<ticket> events fire a wake with failure reason", () => {
    registerPhaseInterest();
    const matches = tryPhaseLifecycleRoute(
      {
        ts: "2026-05-17T05:00:00Z",
        attributes: { "event.name": "phase.research.failed.CTL-100" },
        body: { payload: { ticket: "CTL-100", phase: "research", reason: "timeout" } },
      },
      getInterests()
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("watcher-1");
    expect(matches[0].reason).toMatch(/phase research failed/i);
    expect(matches[0].reason).toContain("CTL-100");
  });

  // Test 5
  test("agent.checkout removes a phase_lifecycle interest registered with that session_id", () => {
    registerPhaseInterest({ interestId: "sess-A", sessionId: "sess-A" });
    expect(getInterests().has("sess-A")).toBe(true);
    handleAgentCheckout({
      event: "agent.checkout",
      detail: { session_id: "sess-A", status: "done" },
    });
    expect(getInterests().has("sess-A")).toBe(false);
  });

  // Test 6
  test("phase_lifecycle entries round-trip through saveInterests + loadPersistedInterests", () => {
    registerPhaseInterest({
      interestId: "watcher-rt",
      ticket: "CTL-200",
      phaseNames: ["triage", "research"],
      sessionId: "watcher-rt",
    });
    saveInterests();

    // Simulate restart by clearing and reloading from disk.
    clearInterests();
    expect(getInterests().size).toBe(0);
    loadPersistedInterests();

    const reg = getInterests().get("watcher-rt");
    expect(reg).toBeDefined();
    expect(reg.interest_type).toBe("phase_lifecycle");
    expect(reg.ticket).toBe("CTL-200");
    expect(reg.phase_names).toEqual(["triage", "research"]);

    // Persistence preserves enough state to keep matching after reload.
    const matches = tryPhaseLifecycleRoute(
      {
        ts: "2026-05-17T05:00:00Z",
        attributes: { "event.name": "phase.research.complete.CTL-200" },
        body: { payload: { ticket: "CTL-200" } },
      },
      getInterests()
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("watcher-rt");
  });
});

describe("phase_lifecycle integration", () => {
  test("phase_lifecycle interests are excluded from the Groq prose prompt", () => {
    registerPhaseInterest();
    const prompt = buildGroqPrompt([
      { attributes: { "event.name": "phase.research.complete.CTL-100" } },
    ]);
    expect(prompt).toBeNull();
  });

  test("buildBrokerState exposes phase_lifecycle in supportedInterestTypes", () => {
    const state = buildBrokerState();
    expect(state.supportedInterestTypes).toContain("phase_lifecycle");
    expect(state.supportedInterestTypes).toContain("pr_lifecycle");
    expect(state.supportedInterestTypes).toContain("ticket_lifecycle");
    expect(state.supportedInterestTypes).toContain("comms_lifecycle");
  });
});
