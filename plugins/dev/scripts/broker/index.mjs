#!/usr/bin/env node
// broker/index.mjs — Catalyst event broker (CTL-303).
//
// Evolved from filter-daemon (CTL-284): adds structured agent identity
// (agent.checkin/checkout), auto-correlation of ticket↔PR interests, and
// deterministic ticket_lifecycle routing for Linear webhook events. Groq-based
// prose classification remains for everything ambiguous.

import {
  readFileSync,
  appendFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  watch,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  // filter_state (CTL-284 — PR↔deploy correlation)
  upsertFilterStateOpen,
  setFilterStateMerged,
  setFilterStateDeploying,
  setFilterStateDeployed,
  setFilterStateFailed,
  deleteFilterState,
  // agents (CTL-303 — structured identity)
  upsertAgent,
  markAgentDone,
  getAgentsByTicket,
  // ticket_state (CTL-303 — ticket routing)
  upsertTicketState,
  // waiting_sessions (CTL-403 — wait-loop visibility)
  upsertWaitingSession,
  clearWaitingSession,
  getActiveWaitingSessions,
} from "./broker-state.mjs";
import {
  formatMissingKeyWarning,
  formatLoadedKeyInfo,
  probeGroq,
} from "../lib/api-key-health.mjs";
// Canonical-event primitives shared with orch-monitor (CTL-344). Bun
// transpiles the .ts import on the fly; the file uses only node: builtins so
// the broker's minimal dep surface stays intact.
import {
  severityNumber,
  deriveTraceId,
  deriveSpanId,
  generateEventId,
  synthesizeEventId,
} from "../orch-monitor/lib/canonical-event-shared.ts";

// CTL-529: the logger, env-var constants, getEventLogPath(), the Groq config
// readers, and DETERMINISTIC_INTEREST_TYPES were extracted to ./config.mjs as
// the leaf module of the execution-core split. readGroqConfig /
// readGroqApiKeyFromConfig were `export function`s in this file, so they are
// re-exported below to keep the public import surface unchanged.
import {
  log,
  CATALYST_DIR,
  GLOBAL_CONFIG_PATH,
  GROQ_API_KEY,
  GROQ_KEY_SOURCE,
  GROQ_KEY_PREFIX,
  GROQ_ENDPOINT,
  GROQ_EXTRA_HEADERS,
  GROQ_GATEWAY_ENABLED,
  GROQ_GATEWAY_BASE_URL,
  GROQ_MODEL,
  DEBOUNCE_MS,
  HARD_CAP_MS,
  MAX_BATCH_SIZE,
  LOOKBACK_LINES,
  WATCHDOG_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  ORCH_STATUS_REPLAY_STALE_MS,
  DETERMINISTIC_INTEREST_TYPES,
  getEventLogPath,
} from "./config.mjs";

export { readGroqConfig, readGroqApiKeyFromConfig } from "./config.mjs";

// --- Router (CTL-529) ---
// Wake emission, the canonical-aware event readers, the registration + agent
// handlers, the three deterministic matchers, the Groq prose path, debounce
// batching, the watchdog, and the processEvent dispatch were extracted to
// ./router.mjs. They are imported here for main()/shutdown() and the tailer;
// the public symbols are re-exported so the import surface is unchanged.
import {
  appendEvent,
  maybeEmitProseDisabled,
  getEventName,
  startWatchdog,
  clearDebounceTimers,
  processEvent,
  handleRegister,
  handleDeregister,
  handleAgentCheckin,
  handleAgentCheckout,
  handleOrchestratorStatus,
  handleOrchestratorTerminated,
  isOrchestratorStatusFresh,
} from "./router.mjs";

export {
  pluginVersion,
  summarizeEvent,
  buildCanonicalEnvelope,
  appendEvent,
  __clearEmittedWakeCacheForTest,
  maybeEmitProseDisabled,
  __resetProseDisabledForTest,
  handleRegister,
  handleDeregister,
  handleOrchestratorTerminated,
  handleAgentCheckin,
  handleAgentCheckout,
  handleAgentHeartbeat,
  handleWorkerWaiting,
  handleWorkerResumed,
  handleOrchestratorStatus,
  isOrchestratorStatusFresh,
  tryDeterministicRoute,
  tryTicketLifecycleRoute,
  tryPhaseLifecycleRoute,
  shouldSkipEvent,
  buildGroqPrompt,
  classifyBatch,
  classifyMatches,
  __getPendingBatchForTest,
  __clearPendingBatchForTest,
  runWatchdogTick,
  processEvent,
  handleWorkerStateChanged,
} from "./router.mjs";

// --- Shared in-memory state (CTL-529) ---
// The interest table, heartbeat/identity maps, and liveness counters were
// extracted to ./state.mjs so the router and projection share exactly one
// instance of each. The maps are aliased to module-local consts below —
// getInterests() etc. return identity-stable references, so the resident
// router/projection call sites keep mutating the canonical instances
// unchanged. Liveness counters are primitives, reached via state.mjs get/set
// pairs (an ESM importer cannot reassign an imported binding).
import {
  getInterests,
  getLastHeartbeat,
  getWorkerToOrchestrator,
  getWaitingSessionsMap,
  getOrchestratorStatusMap,
  getBrokerStartedAt,
  setBrokerStartedAt,
  setLastWakeAt,
  setLastRegisterAt,
  getDegradedEmittedAt,
  setDegradedEmittedAt,
} from "./state.mjs";

export {
  getInterests,
  clearInterests,
  getLastHeartbeat,
  clearLastHeartbeat,
  getWorkerToOrchestrator,
  getWaitingSessionsMap,
  clearWaitingSessionsMap,
  getOrchestratorStatusMap,
  clearOrchestratorStatusMap,
  __setBrokerStartedAtForTest,
  __resetBrokerStartedAtForTest,
  __resetDegradedEmittedForTest,
  __setHeartbeatForTest,
  __resetBrokerLivenessForTest,
} from "./state.mjs";

const interests = getInterests();
const lastHeartbeat = getLastHeartbeat();
const workerToOrchestrator = getWorkerToOrchestrator();
const waitingSessions = getWaitingSessionsMap();
const orchestratorStatusMap = getOrchestratorStatusMap();

// --- Interest persistence + projections (CTL-529) ---
// Interest persistence, the broker.state.json builder/writer, and the
// worker-state shadow writers were extracted to ./projection.mjs. They are
// imported here for main() and the resident router code; the public symbols
// are re-exported so the import surface is unchanged.
import {
  migrateLegacyInterestsFile,
  saveInterests,
  loadPersistedInterests,
  buildBrokerState,
  writeBrokerStateFile,
  persistBrokerState,
  getProjectedWorkerStatePath,
  writeProjectedWorkerState,
} from "./projection.mjs";

export {
  saveInterests,
  loadPersistedInterests,
  getBrokerStateFilePath,
  buildBrokerState,
  writeBrokerStateFile,
  getProjectedWorkerStatePath,
  writeProjectedWorkerState,
} from "./projection.mjs";

// --- Reactive event log tailing ---
let lastByteOffset = 0;
let lastLogPath = "";
let leftoverBuf = "";
let eventsWatcher = null;

function readNewEvents() {
  const logPath = getEventLogPath();

  if (logPath !== lastLogPath) {
    lastLogPath = logPath;
    leftoverBuf = "";
    try {
      const fd = openSync(logPath, "r");
      const stat = fstatSync(fd);
      lastByteOffset = stat.size;
      closeSync(fd);
    } catch {
      lastByteOffset = 0;
    }
    return;
  }

  try {
    const fd = openSync(logPath, "r");
    const stat = fstatSync(fd);
    if (stat.size <= lastByteOffset) {
      closeSync(fd);
      return;
    }
    const newByteCount = stat.size - lastByteOffset;
    const buf = Buffer.alloc(newByteCount);
    readSync(fd, buf, 0, newByteCount, lastByteOffset);
    closeSync(fd);
    lastByteOffset = stat.size;

    const text = leftoverBuf + buf.toString("utf8");
    const lines = text.split("\n");
    leftoverBuf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      processEvent(event);
    }
  } catch {
    // Log file not yet created or transient read error
  }
}

function startTailing() {
  const eventsDir = resolve(CATALYST_DIR, "events");
  mkdirSync(eventsDir, { recursive: true });
  eventsWatcher = watch(eventsDir, (eventType, filename) => {
    if (eventType !== "change") return;
    if (filename !== null && filename !== basename(getEventLogPath())) return;
    readNewEvents();
  });
}

export function loadExistingRegistrations(logPath = lastLogPath) {
  try {
    const content = readFileSync(logPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim());
    for (const line of lines.slice(-LOOKBACK_LINES)) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const name = getEventName(event);
      if (name === "filter.register") handleRegister(event);
      if (name === "filter.deregister") handleDeregister(event);
      // CTL-381: accept the legacy orchestrator.-prefixed alias on replay too.
      if (name === "agent.checkin" || name === "orchestrator.agent.checkin")
        handleAgentCheckin(event);
      if (name === "agent.checkout" || name === "orchestrator.agent.checkout")
        handleAgentCheckout(event);
      // CTL-507: replay orchestrator.status so activeOrchestrators survives a
      // broker restart. Chronological replay + the terminate block below mean a
      // status followed by a completed/failed resolves to set-then-delete. The
      // freshness gate skips ancient status events so a long-dead orchestrator
      // is not resurrected.
      if (name === "orchestrator.status" && isOrchestratorStatusFresh(event)) {
        handleOrchestratorStatus(event);
      }
      if (name === "orchestrator-completed" || name === "orchestrator-failed") {
        handleOrchestratorTerminated(event);
      }
    }
    if (interests.size) {
      log.info({ count: interests.size }, "recovered interests from log");
    }
  } catch {
    // No log file yet — fine
  }
}

// --- PID file ---
function parsePidFilePath() {
  const idx = process.argv.indexOf("--pid-file");
  return idx !== -1 ? process.argv[idx + 1] : null;
}

const PID_FILE_PATH = parsePidFilePath();

function writePidFile() {
  if (!PID_FILE_PATH) return;
  try {
    mkdirSync(dirname(PID_FILE_PATH), { recursive: true });
    writeFileSync(PID_FILE_PATH, `${process.pid}\n`);
  } catch (err) {
    log.error({ err: err.message }, "failed to write PID file");
  }
}

function removePidFile() {
  if (!PID_FILE_PATH) return;
  try {
    unlinkSync(PID_FILE_PATH);
  } catch {
    /* already gone */
  }
}

// Logs key health at startup. Returns the resolved state-file payload
// (pre-probe) so callers can persist it.
export function logKeyHealthAtStartup() {
  if (GROQ_KEY_SOURCE === null) {
    const warning = formatMissingKeyWarning({
      name: "GROQ_API_KEY",
      envName: "GROQ_API_KEY",
      configPath: GLOBAL_CONFIG_PATH,
      configKeyPath: "groq.apiKey",
      getUrl: "https://console.groq.com/keys",
    });
    // pino flattens multi-line strings — emit each line so operators see it cleanly.
    for (const line of warning.split("\n")) log.warn(line);
  } else {
    log.info(
      {
        source: GROQ_KEY_SOURCE,
        prefix: GROQ_KEY_PREFIX,
        model: GROQ_MODEL,
        endpoint: GROQ_ENDPOINT,
      },
      formatLoadedKeyInfo({
        name: "GROQ_API_KEY",
        source: GROQ_KEY_SOURCE,
        prefix: GROQ_KEY_PREFIX,
      })
    );
    if (GROQ_GATEWAY_ENABLED) {
      log.info(
        { baseUrl: GROQ_GATEWAY_BASE_URL },
        "GROQ gateway enabled — routing chat completions through configured baseUrl"
      );
    }
  }
}

export async function runStartupProbe() {
  if (GROQ_KEY_SOURCE === null) {
    return { status: "missing" };
  }
  const probe = await probeGroq({
    apiKey: GROQ_API_KEY,
    endpoint: GROQ_ENDPOINT,
    extraHeaders: GROQ_EXTRA_HEADERS,
  });
  switch (probe.status) {
    case "ok":
      log.info({ modelCount: probe.modelCount }, "Groq probe OK");
      break;
    case "unauthorized":
      log.error({ err: probe.error }, "Groq probe FAILED — semantic routing disabled");
      break;
    case "error":
      log.warn(
        { err: probe.error },
        "Groq probe could not complete — semantic routing may be impaired"
      );
      break;
    case "missing":
      // already warned at startup
      break;
  }
  return probe;
}

// --- Main ---
function main() {
  // CTL-352: pin brokerStartedAt before any state mutation so subsequent
  // buildBrokerState() / runWatchdogTick() callers compute uptime against
  // a stable instant rather than now().
  setBrokerStartedAt(new Date().toISOString());

  logKeyHealthAtStartup();

  writePidFile();
  // Write initial state (probeStatus: pending or missing). Updated after probe completes.
  writeBrokerStateFile(buildBrokerState());

  migrateLegacyInterestsFile();

  lastLogPath = getEventLogPath();
  loadPersistedInterests();
  loadExistingRegistrations();

  // CTL-357: surface stale prose interests left on disk now that the Groq path
  // is off by default. Single-shot info event so the HUD/operator can see them
  // without grepping broker-interests.json.
  maybeEmitProseDisabled();

  openBrokerStateDb();

  // CTL-403: rehydrate waiting sessions from SQLite so the watchdog respects
  // active waits that survived a broker restart.
  try {
    for (const ws of getActiveWaitingSessions()) {
      waitingSessions.set(ws.sessionId, {
        timeoutAt: new Date(ws.timeoutAt).getTime(),
        waitFor: ws.waitFor,
        ticket: ws.ticket,
        orchestrator: ws.orchestrator,
        reason: ws.reason,
      });
    }
    if (waitingSessions.size > 0) {
      log.info({ count: waitingSessions.size }, "rehydrated waiting sessions from DB");
    }
  } catch { /* DB might not have the table yet on old installs */ }

  try {
    const fd = openSync(lastLogPath, "r");
    const stat = fstatSync(fd);
    lastByteOffset = stat.size;
    closeSync(fd);
    log.info({ byteOffset: lastByteOffset, logPath: lastLogPath }, "starting");
  } catch {
    log.info({ logPath: lastLogPath }, "starting (no log file yet)");
  }

  appendEvent({
    event: "broker.daemon.startup",
    orchestrator: null,
    worker: null,
    detail: {
      pid: process.pid,
      recovered_interests: interests.size,
      watchdog_interval_ms: WATCHDOG_INTERVAL_MS,
      heartbeat_stale_ms: HEARTBEAT_STALE_MS,
      broker: true,
      key_health: {
        source: GROQ_KEY_SOURCE,
        prefix: GROQ_KEY_PREFIX,
        gateway: GROQ_GATEWAY_ENABLED,
      },
    },
  });

  startTailing();
  const watchdogId = startWatchdog();
  log.info(
    {
      pid: process.pid,
      watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
      heartbeatStaleMs: HEARTBEAT_STALE_MS,
    },
    "catalyst-broker daemon started"
  );

  // Fire the Groq /v1/models probe asynchronously so it doesn't gate startup.
  runStartupProbe()
    .then((probe) => {
      writeBrokerStateFile(buildBrokerState({ probe }));
    })
    .catch((err) => {
      log.warn({ err: err.message }, "probe error suppressed");
    });

  const shutdown = (signal) => {
    eventsWatcher?.close();
    clearInterval(watchdogId);
    // CTL-529: the debounce timer handles are router module-internal.
    clearDebounceTimers();
    // CTL-351: emit a parallel shutdown event so subscribers can pair
    // broker.daemon.startup/broker.daemon.shutdown and switch their
    // catalyst-events wait-for path to REST polling while the daemon is down.
    // appendEvent is synchronous (appendFileSync) so the event is flushed
    // before process.exit, even though the rest of shutdown is best-effort.
    try {
      appendEvent({
        event: "broker.daemon.shutdown",
        orchestrator: null,
        worker: null,
        detail: {
          pid: process.pid,
          signal: typeof signal === "string" ? signal : null,
          active_interests: interests.size,
          broker: true,
        },
      });
    } catch {
      // Best-effort — never block shutdown on telemetry.
    }
    closeBrokerStateDb();
    removePidFile();
    try {
      unlinkSync(BROKER_STATE_FILE);
    } catch {
      /* already gone */
    }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
