// Unit tests for workflow_substep_lifecycle broker route (CTL-753).
// Run: bun test plugins/dev/scripts/broker/workflow-substep.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleRegister,
  handleAgentCheckout,
  tryWorkflowSubstepRoute,
  shouldSkipEvent,
  getInterests,
  clearInterests,
  __clearEmittedWakeCacheForTest,
} from "./index.mjs";
import { openBrokerStateDb, closeBrokerStateDb } from "./broker-state.mjs";

let tmpDir;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "broker-substep-test-"));
  process.env.CATALYST_DIR = tmpDir;
  openBrokerStateDb(join(tmpDir, "test.db"));
  clearInterests();
  __clearEmittedWakeCacheForTest();
});
afterEach(() => {
  closeBrokerStateDb();
  rmSync(tmpDir, { recursive: true, force: true });
  // CTL-1086: restore to hermetic preload value rather than deleting.
  const hermetic = process.env.CATALYST_HERMETIC_DIR;
  if (hermetic) {
    process.env.CATALYST_DIR = hermetic;
  } else {
    delete process.env.CATALYST_DIR;
  }
});

function registerSubstepInterest({ interestId = "watcher-1", ticket = "CTL-100" } = {}) {
  handleRegister({
    event: "filter.register",
    orchestrator: "orch-1",
    detail: {
      interest_id: interestId,
      notify_event: `filter.wake.${interestId}`,
      interest_type: "workflow_substep_lifecycle",
      ticket,
      session_id: interestId,
      persistent: true,
    },
  });
}

describe("workflow_substep_lifecycle interest type", () => {
  test("route matches workflow.substep.started.<TICKET> for matching interest", () => {
    registerSubstepInterest();
    const matches = tryWorkflowSubstepRoute(
      { ts: "2026-06-02T00:00:00Z",
        attributes: { "event.name": "workflow.substep.started.CTL-100" },
        body: { payload: { workflowName: "research", stepLabel: "Phase 1", stepIndex: 0 } } },
      getInterests()
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].interestId).toBe("watcher-1");
    expect(matches[0].ticket).toBe("CTL-100");
  });

  test("route matches workflow.substep.complete.<TICKET>", () => {
    registerSubstepInterest();
    const matches = tryWorkflowSubstepRoute(
      { ts: "2026-06-02T00:00:00Z",
        attributes: { "event.name": "workflow.substep.complete.CTL-100" },
        body: {} },
      getInterests()
    );
    expect(matches).toHaveLength(1);
  });

  test("route does NOT match wrong ticket", () => {
    registerSubstepInterest({ ticket: "CTL-100" });
    const matches = tryWorkflowSubstepRoute(
      { ts: "2026-06-02T00:00:00Z",
        attributes: { "event.name": "workflow.substep.started.CTL-999" },
        body: {} },
      getInterests()
    );
    expect(matches).toHaveLength(0);
  });

  test("route does NOT match phase_lifecycle interest type", () => {
    handleRegister({
      event: "filter.register",
      orchestrator: "orch-1",
      detail: {
        interest_id: "phase-watcher",
        notify_event: "filter.wake.phase-watcher",
        interest_type: "phase_lifecycle",
        ticket: "CTL-100",
        phase_names: ["research"],
        session_id: "phase-watcher",
        persistent: true,
      },
    });
    const matches = tryWorkflowSubstepRoute(
      { ts: "2026-06-02T00:00:00Z",
        attributes: { "event.name": "workflow.substep.started.CTL-100" },
        body: {} },
      getInterests()
    );
    expect(matches).toHaveLength(0);
  });

  test("shouldSkipEvent returns false for catalyst.workflow service events", () => {
    const event = {
      ts: "2026-06-02T00:00:00Z",
      resource: { "service.name": "catalyst.workflow" },
      attributes: { "event.name": "workflow.substep.started.CTL-100" },
      body: {},
    };
    expect(shouldSkipEvent(event)).toBe(false);
  });

  test("route does not match non-substep event names", () => {
    registerSubstepInterest();
    const matches = tryWorkflowSubstepRoute(
      { ts: "2026-06-02T00:00:00Z",
        attributes: { "event.name": "phase.research.complete.CTL-100" },
        body: {} },
      getInterests()
    );
    expect(matches).toHaveLength(0);
  });
});
