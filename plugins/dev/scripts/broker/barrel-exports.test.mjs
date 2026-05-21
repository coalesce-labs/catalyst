// Regression-gate contract for the CTL-529 module split.
// Asserts the public import surface of ./index.mjs is preserved and that
// singleton getters return identity-stable references. Goes RED if any
// extraction phase drops a re-export or breaks getter identity.
//
// Note: index.mjs has 55 `export` declarations (verified via
// `grep -cE '^export ' index.mjs`). The CTL-529 plan prose says "56" but its
// own enumerated list — and the file — is 55; this test pins the real count.
import { describe, test, expect } from "bun:test";
import * as barrel from "./index.mjs";

const REQUIRED_EXPORTS = [
  // emission / router
  "pluginVersion", "summarizeEvent", "buildCanonicalEnvelope", "appendEvent",
  "__clearEmittedWakeCacheForTest", "maybeEmitProseDisabled", "__resetProseDisabledForTest",
  "handleRegister", "handleDeregister", "handleOrchestratorTerminated",
  "handleAgentCheckin", "handleAgentCheckout", "handleAgentHeartbeat",
  "handleWorkerWaiting", "handleWorkerResumed", "handleOrchestratorStatus",
  "isOrchestratorStatusFresh", "tryDeterministicRoute", "tryTicketLifecycleRoute",
  "tryPhaseLifecycleRoute", "shouldSkipEvent", "buildGroqPrompt", "classifyBatch",
  "classifyMatches", "__getPendingBatchForTest", "__clearPendingBatchForTest",
  "runWatchdogTick", "processEvent",
  // state
  "getInterests", "clearInterests", "getLastHeartbeat", "clearLastHeartbeat",
  "getWorkerToOrchestrator", "getWaitingSessionsMap", "clearWaitingSessionsMap",
  "getOrchestratorStatusMap", "clearOrchestratorStatusMap",
  "__setBrokerStartedAtForTest", "__resetBrokerStartedAtForTest",
  "__resetDegradedEmittedForTest", "__setHeartbeatForTest", "__resetBrokerLivenessForTest",
  // projection
  "saveInterests", "loadPersistedInterests", "getBrokerStateFilePath", "buildBrokerState",
  "writeBrokerStateFile", "getProjectedWorkerStatePath", "writeProjectedWorkerState",
  "handleWorkerStateChanged",
  // tailer
  "loadExistingRegistrations",
  // config
  "readGroqConfig", "readGroqApiKeyFromConfig",
  // thin main
  "logKeyHealthAtStartup", "runStartupProbe",
];

describe("CTL-529 barrel contract", () => {
  test("all 55 public symbols re-export from ./index.mjs", () => {
    for (const name of REQUIRED_EXPORTS) {
      expect(typeof barrel[name], `missing export: ${name}`).not.toBe("undefined");
    }
    expect(REQUIRED_EXPORTS.length).toBe(55);
  });

  test("singleton getters return identity-stable live references", () => {
    expect(barrel.getInterests()).toBe(barrel.getInterests());
    expect(barrel.getLastHeartbeat()).toBe(barrel.getLastHeartbeat());
    expect(barrel.getWaitingSessionsMap()).toBe(barrel.getWaitingSessionsMap());
    expect(barrel.getWorkerToOrchestrator()).toBe(barrel.getWorkerToOrchestrator());
    expect(barrel.getOrchestratorStatusMap()).toBe(barrel.getOrchestratorStatusMap());
  });

  test("a getter mutation is visible through a fresh getter call (shared instance)", () => {
    barrel.clearInterests();
    barrel.getInterests().set("ctl-529-probe", { id: "ctl-529-probe" });
    expect(barrel.getInterests().has("ctl-529-probe")).toBe(true);
    barrel.clearInterests();
  });
});
