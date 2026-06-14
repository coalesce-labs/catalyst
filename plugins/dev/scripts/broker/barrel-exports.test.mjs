// Regression-gate contract for the CTL-529 module split.
// Asserts the public import surface of ./index.mjs is preserved and that
// singleton getters return identity-stable references. Goes RED if any
// extraction phase drops a re-export or breaks getter identity.
//
// Note: the barrel re-exports 83 public symbols (CTL-529 established 55; CTL-532
// added 12 worker-state-projection symbols — 9 store helpers, the reducer, and
// the two projection drivers; CTL-993 added 7 plugin-refresh symbols; CTL-1077
// added 6 stack-reload symbols — 4 stack-reload module re-exports,
// resolveBootByteOffset direct export, and getLastByteOffset from tailer;
// CTL-1077 remediate added 2 more — BROKER_HANDOFF_MAX_AGE_MS and the extracted
// parseBootHandoff boot seam).
// The count is the length of the enumerated REQUIRED_EXPORTS list below —
// `grep -cE '^export '` undercounts because most re-exports are multi-name
// `export { … } from` blocks.
import { describe, test, expect } from "bun:test";
import * as barrel from "./index.mjs";

const REQUIRED_EXPORTS = [
  // emission / router
  "pluginVersion",
  "summarizeEvent",
  "buildCanonicalEnvelope",
  "appendEvent",
  "__clearEmittedWakeCacheForTest",
  "maybeEmitProseDisabled",
  "__resetProseDisabledForTest",
  "handleRegister",
  "handleDeregister",
  "handleOrchestratorTerminated",
  "handleAgentCheckin",
  "handleAgentCheckout",
  "handleAgentHeartbeat",
  "handleWorkerWaiting",
  "handleWorkerResumed",
  "handleOrchestratorStatus",
  "isOrchestratorStatusFresh",
  "tryDeterministicRoute",
  "tryTicketLifecycleRoute",
  "tryPhaseLifecycleRoute",
  "tryWorkflowSubstepRoute",
  "shouldSkipEvent",
  "buildGroqPrompt",
  "classifyBatch",
  "classifyMatches",
  "__getPendingBatchForTest",
  "__clearPendingBatchForTest",
  "runWatchdogTick",
  "processEvent",
  // state
  "getInterests",
  "clearInterests",
  "getLastHeartbeat",
  "clearLastHeartbeat",
  "getWorkerToOrchestrator",
  "getWaitingSessionsMap",
  "clearWaitingSessionsMap",
  "getOrchestratorStatusMap",
  "clearOrchestratorStatusMap",
  "__setBrokerStartedAtForTest",
  "__resetBrokerStartedAtForTest",
  "__resetDegradedEmittedForTest",
  "__setHeartbeatForTest",
  "__resetBrokerLivenessForTest",
  // projection
  "saveInterests",
  "loadPersistedInterests",
  "getBrokerStateFilePath",
  "buildBrokerState",
  "writeBrokerStateFile",
  "getProjectedWorkerStatePath",
  "writeProjectedWorkerState",
  "handleWorkerStateChanged",
  // tailer
  "loadExistingRegistrations",
  // config
  "readGroqConfig",
  "readGroqApiKeyFromConfig",
  // thin main
  "logKeyHealthAtStartup",
  "runStartupProbe",
  // CTL-532: worker-state projection — store helpers (broker-state.mjs)
  "upsertWorkerState",
  "getWorkerState",
  "getWorkerStatesByOrchestrator",
  "getAllWorkerStates",
  "recordReviveEvent",
  "getReviveCount",
  "getProjectionMeta",
  "setProjectionMeta",
  "getStaleWorkers",
  // CTL-532: worker-state projection — reducer + drivers (projection.mjs)
  "reduceWorkerStateEvent",
  "projectWorkerStateEvent",
  "replayWorkerStateProjection",
  // CTL-993: merge-to-main plugin-checkout refresh (plugin-refresh.mjs)
  "resolvePluginCheckoutRoots",
  "resolveRepoFullName",
  "isThisRepoMergeEvent",
  "refreshPluginCheckout",
  "handlePluginRefreshEvent",
  "PLUGIN_REFRESH_THROTTLE_MS",
  "__clearThrottleForTest",
  // CTL-1106: checkout-lag alarm (plugin-refresh.mjs)
  "CHECKOUT_LAG_FAILURE_THRESHOLD",
  "__clearLagStateForTest",
  // CTL-1077: automatic hot-reload of the running stack (stack-reload.mjs + index.mjs)
  "decideStackReload",
  "handleStackReloadEvent",
  "STACK_RELOAD_DEBOUNCE_MS",
  "__clearReloadStateForTest",
  "resolveBootByteOffset",
  "getLastByteOffset",
  // CTL-1077 remediate: handoff freshness budget + extracted boot-parse seam (index.mjs)
  "BROKER_HANDOFF_MAX_AGE_MS",
  "parseBootHandoff",
];

describe("CTL-529 barrel contract", () => {
  test("all 85 public symbols re-export from ./index.mjs", () => {
    for (const name of REQUIRED_EXPORTS) {
      expect(typeof barrel[name], `missing export: ${name}`).not.toBe("undefined");
    }
    expect(REQUIRED_EXPORTS.length).toBe(85);
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
