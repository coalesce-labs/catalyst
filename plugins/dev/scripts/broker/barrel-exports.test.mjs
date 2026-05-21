// Regression-gate contract for the CTL-529 module split.
// Asserts the public import surface of ./index.mjs is preserved and that
// singleton getters return identity-stable references. Goes RED if any
// extraction phase drops a re-export or breaks getter identity.
//
// Note: the barrel re-exports 65 public symbols (CTL-529 established 55; CTL-532
// Phase 1 added the 9 worker-state store helpers, Phase 2 the reducer). The
// count is the length of the enumerated REQUIRED_EXPORTS list below —
// `grep -cE '^export '` undercounts because most re-exports are multi-name
// `export { … } from` blocks.
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
  // CTL-532: worker-state projection — store helpers (broker-state.mjs)
  "upsertWorkerState", "getWorkerState", "getWorkerStatesByOrchestrator",
  "getAllWorkerStates", "recordReviveEvent", "getReviveCount",
  "getProjectionMeta", "setProjectionMeta", "getStaleWorkers",
  // CTL-532: worker-state projection — pure reducer (projection.mjs)
  "reduceWorkerStateEvent",
];

describe("CTL-529 barrel contract", () => {
  test("all 65 public symbols re-export from ./index.mjs", () => {
    for (const name of REQUIRED_EXPORTS) {
      expect(typeof barrel[name], `missing export: ${name}`).not.toBe("undefined");
    }
    expect(REQUIRED_EXPORTS.length).toBe(65);
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
