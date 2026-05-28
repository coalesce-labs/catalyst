// state.mjs — shared in-memory broker state. Exactly one instance of each map
// and liveness counter, mutated by the router and read by the projection.
//
// CTL-529: extracted from index.mjs as the second step of the execution-core
// module split. The maps are exposed through identity-stable getters (the
// regression-gate contract — see barrel-exports.test.mjs); the liveness
// counters are primitives, so they get get/set accessor pairs because an ESM
// importer cannot reassign an imported binding. This module is a pure leaf —
// it imports nothing.

// --- Interest table ---
const interests = new Map();

export function getInterests() {
  return interests;
}

export function clearInterests() {
  interests.clear();
}

// --- Heartbeat / identity maps ---
// sourceId → { ts: number (Date.now()), notified: boolean }
const lastHeartbeat = new Map();
// worker/session id → orchestrator id (inferred from heartbeat event fields)
const workerToOrchestrator = new Map();
// CTL-403: session_id → { timeoutAt: number, waitFor, ticket, orchestrator, reason }
const waitingSessions = new Map();
// CTL-405: orchestrator_id → { phase, wave, activeWorkers, totalWorkers, summary, ts, sessionId }
const orchestratorStatusMap = new Map();

export function getLastHeartbeat() {
  return lastHeartbeat;
}

export function clearLastHeartbeat() {
  lastHeartbeat.clear();
  workerToOrchestrator.clear();
  orchestratorStatusMap.clear();
}

export function getWorkerToOrchestrator() {
  return workerToOrchestrator;
}

export function getWaitingSessionsMap() {
  return waitingSessions;
}

export function clearWaitingSessionsMap() {
  waitingSessions.clear();
}

export function getOrchestratorStatusMap() {
  return orchestratorStatusMap;
}

export function clearOrchestratorStatusMap() {
  orchestratorStatusMap.clear();
}

// --- Broker liveness counters (CTL-352) -----------------------------------------
// buildBrokerState() surfaces these in broker.state.json so operators (and the
// HUD pill) can tell at a glance whether the broker has any registered interests
// and when it last did real work. Reassigned by the router and main(), read by
// the projection — hence the get/set accessor pairs.
let brokerStartedAt = null;
let lastWakeAt = null;
let lastRegisterAt = null;
// One-shot guard for broker.daemon.degraded — set on emission, cleared whenever
// interests.size > 0 so a future empty window re-arms.
let degradedEmittedAt = null;
// CTL-643: boot-time GC pass result, surfaced in broker.state.json so operators
// can see "the broker pruned N stale interests on its last start."
let gcLastRunAt = null;
let gcLastPrunedCount = null;

export function getBrokerStartedAt() {
  return brokerStartedAt;
}
export function setBrokerStartedAt(value) {
  brokerStartedAt = value;
}
export function getLastWakeAt() {
  return lastWakeAt;
}
export function setLastWakeAt(value) {
  lastWakeAt = value;
}
export function getLastRegisterAt() {
  return lastRegisterAt;
}
export function setLastRegisterAt(value) {
  lastRegisterAt = value;
}
export function getDegradedEmittedAt() {
  return degradedEmittedAt;
}
export function setDegradedEmittedAt(value) {
  degradedEmittedAt = value;
}
export function getGcLastRunAt() {
  return gcLastRunAt;
}
export function setGcLastRunAt(value) {
  gcLastRunAt = value;
}
export function getGcLastPrunedCount() {
  return gcLastPrunedCount;
}
export function setGcLastPrunedCount(value) {
  gcLastPrunedCount = value;
}

// Test-only setters. Production paths only ever set these via main() and the
// router hook points; tests use these to time-travel without touching Date.now().
export function __setBrokerStartedAtForTest(iso) {
  brokerStartedAt = iso;
}
export function __resetBrokerStartedAtForTest() {
  brokerStartedAt = null;
}
export function __resetDegradedEmittedForTest() {
  degradedEmittedAt = null;
}
// CTL-419: backdate a session's heartbeat timestamp so tests can simulate staleness.
export function __setHeartbeatForTest(sessionId, tsMs) {
  const existing = lastHeartbeat.get(sessionId);
  lastHeartbeat.set(sessionId, { ts: tsMs, notified: existing?.notified ?? false });
}
export function __resetBrokerLivenessForTest() {
  brokerStartedAt = null;
  lastWakeAt = null;
  lastRegisterAt = null;
  degradedEmittedAt = null;
  gcLastRunAt = null;
  gcLastPrunedCount = null;
}
