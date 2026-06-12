#!/usr/bin/env node
// broker/index.mjs — Catalyst event broker (CTL-303).
//
// Evolved from filter-daemon (CTL-284): adds structured agent identity
// (agent.checkin/checkout), auto-correlation of ticket↔PR interests, and
// deterministic ticket_lifecycle routing for Linear webhook events. Groq-based
// prose classification remains for everything ambiguous.
//
// CTL-529: restructured into the execution-core process skeleton. The broker
// logic now lives in named modules with explicit boundaries —
//   config.mjs     — logger, env constants, log-path, Groq config (leaf)
//   state.mjs      — shared in-memory singletons (leaf)
//   projection.mjs — interest persistence, broker.state.json, worker shadow
//   router.mjs     — emission, handlers, matchers, Groq, debounce, watchdog
//   tailer.mjs     — reactive event-log follow + startup replay
// index.mjs is the thin daemon entrypoint (main/shutdown, PID + key-health)
// plus the re-export barrel that preserves the public import surface.

import { writeFileSync, unlinkSync, mkdirSync, openSync, fstatSync, closeSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  openBrokerStateDb,
  closeBrokerStateDb,
  getActiveWaitingSessions,
} from "./broker-state.mjs";
// CTL-532: re-export the worker-state store helpers through the barrel.
export {
  upsertWorkerState,
  getWorkerState,
  getWorkerStatesByOrchestrator,
  getAllWorkerStates,
  recordReviveEvent,
  getReviveCount,
  getProjectionMeta,
  setProjectionMeta,
  getStaleWorkers,
} from "./broker-state.mjs";
import { formatMissingKeyWarning, formatLoadedKeyInfo, probeGroq } from "../lib/api-key-health.mjs";
import {
  log,
  GLOBAL_CONFIG_PATH,
  GROQ_API_KEY,
  GROQ_KEY_SOURCE,
  GROQ_KEY_PREFIX,
  GROQ_ENDPOINT,
  GROQ_EXTRA_HEADERS,
  GROQ_GATEWAY_ENABLED,
  GROQ_GATEWAY_BASE_URL,
  GROQ_MODEL,
  WATCHDOG_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  getEventLogPath,
} from "./config.mjs";
import {
  getInterests,
  getWaitingSessionsMap,
  setBrokerStartedAt,
  setGcLastRunAt,
  setGcLastPrunedCount,
} from "./state.mjs";
import {
  migrateLegacyInterestsFile,
  loadPersistedInterests,
  saveInterests,
  persistBrokerState,
  buildBrokerState,
  writeBrokerStateFile,
  replayWorkerStateProjection,
} from "./projection.mjs";
import {
  appendEvent,
  maybeEmitProseDisabled,
  startWatchdog,
  clearDebounceTimers,
} from "./router.mjs";
import { seedTailer, startTailing, stopTailing, loadExistingRegistrations } from "./tailer.mjs";
import { deleteFilterState } from "./broker-state.mjs";
import { gcStaleInterests } from "./gc-startup.mjs";
import { getExecutionCoreDir, getRunsRoot } from "../execution-core/config.mjs";
import { defaultStatJob } from "../execution-core/recovery.mjs";

// --- Public re-export barrel (CTL-529) ---
// The execution-core split moved every public symbol into a named module.
// index.mjs re-exports all 75 of them so the import surface — depended on by
// the broker test suite — is byte-for-byte preserved. See barrel-exports.test.mjs.
// CTL-532 added 12 worker-state-projection symbols: 9 store helpers (Phase 1),
// the pure reduceWorkerStateEvent reducer (Phase 2), and the
// projectWorkerStateEvent + replayWorkerStateProjection drivers (Phase 3).
// CTL-993 added 7 plugin-refresh symbols (merge-to-main checkout refresh).
export { readGroqConfig, readGroqApiKeyFromConfig } from "./config.mjs";
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
export {
  saveInterests,
  loadPersistedInterests,
  getBrokerStateFilePath,
  buildBrokerState,
  writeBrokerStateFile,
  getProjectedWorkerStatePath,
  writeProjectedWorkerState,
  reduceWorkerStateEvent,
  projectWorkerStateEvent,
  replayWorkerStateProjection,
} from "./projection.mjs";
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
  tryWorkflowSubstepRoute,
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
export { loadExistingRegistrations, getLastByteOffset } from "./tailer.mjs";
// CTL-993: merge-to-main plugin-checkout refresh. router.mjs calls
// handlePluginRefreshEvent in processEvent; the rest are pure units re-exported
// through the barrel so the public import surface stays complete.
export {
  resolvePluginCheckoutRoots,
  resolveRepoFullName,
  isThisRepoMergeEvent,
  refreshPluginCheckout,
  handlePluginRefreshEvent,
  PLUGIN_REFRESH_THROTTLE_MS,
  __clearThrottleForTest,
} from "./plugin-refresh.mjs";
// CTL-1077: automatic hot-reload of the running stack on checkout advance.
// router.mjs calls handleStackReloadEvent after handlePluginRefreshEvent;
// the rest are pure units re-exported for testability.
export {
  decideStackReload,
  handleStackReloadEvent,
  STACK_RELOAD_DEBOUNCE_MS,
  __clearReloadStateForTest,
} from "./stack-reload.mjs";

/**
 * resolveBootByteOffset — pick the tailer start offset on broker boot.
 *
 * When the broker self-reloads (CTL-1077), it writes a handoff file with the
 * last-processed byte offset so the successor can resume exactly where it left
 * off instead of reseeding to EOF and skipping events appended during the gap.
 *
 * Falls back to `eofSize` (the existing behavior) when:
 *   - no handoff file
 *   - handoff logPath ≠ current logPath (different month file)
 *   - handoff is stale (older than maxAgeMs)
 *
 * @param {{ handoff, logPath, eofSize, now?, maxAgeMs? }} opts
 * @returns {number}
 */
export function resolveBootByteOffset({ handoff, logPath, eofSize, now = Date.now(), maxAgeMs = 60_000 }) {
  if (!handoff) return eofSize;
  if (handoff.logPath !== logPath) return eofSize;
  if (now - handoff.ts > maxAgeMs) return eofSize;
  return handoff.byteOffset;
}

// Identity-stable aliases for the shared maps main()/shutdown() read.
const interests = getInterests();
const waitingSessions = getWaitingSessionsMap();

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

  // CTL-529: seed the tailer's log path before loadExistingRegistrations(),
  // which defaults its logPath arg to the tailer's lastLogPath.
  seedTailer({ logPath: getEventLogPath() });
  loadPersistedInterests();
  loadExistingRegistrations();

  // CTL-643: GC stale interests left over from dead orchestrators / sessions
  // before the live tailer starts ingesting filter.register events. Bulk
  // pattern (mirrors handleOrchestratorTerminated) — one log line per pruned
  // entry, one saveInterests + persistBrokerState after the loop. Safe here
  // because the broker is single-threaded and fs.watch is not registered
  // until startTailing() below.
  const gcResult = gcStaleInterests({
    interests,
    log,
    saveInterests,
    persistBrokerState,
    deleteFilterState,
    appendEvent,
    execCoreOrchDir: getExecutionCoreDir(),
    runsRoot: getRunsRoot(),
    statJob: defaultStatJob,
  });
  setGcLastRunAt(new Date().toISOString());
  setGcLastPrunedCount(gcResult.pruned);

  // CTL-357: surface stale prose interests left on disk now that the Groq path
  // is off by default. Single-shot info event so the HUD/operator can see them
  // without grepping broker-interests.json.
  maybeEmitProseDisabled();

  openBrokerStateDb();

  // CTL-532: rebuild the event-sourced worker_state projection from the
  // current-month event log. Idempotent — safe to run on every (re)start.
  replayWorkerStateProjection();

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
  } catch {
    /* DB might not have the table yet on old installs */
  }

  const logPath = getEventLogPath();
  try {
    const fd = openSync(logPath, "r");
    const stat = fstatSync(fd);
    closeSync(fd);
    // CTL-1077: honor broker self-reload handoff — resume from saved offset
    // rather than reseeding to EOF, so events appended during the restart gap
    // are not silently dropped.
    const handoffPath = resolve(homedir(), "catalyst", "broker", "reload-handoff.json");
    let handoff = null;
    try {
      handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
    } catch (err) {
      // CTL-1077 remediate (silent-failure): a missing handoff (ENOENT) is the
      // normal no-reload case and stays silent, but a corrupt/partial handoff
      // means we are about to reseed from EOF and drop the restart-gap events —
      // surface that so the gap-drop is observable instead of swallowed.
      if (err && err.code !== "ENOENT") {
        log.warn(
          { err: err.message, handoffPath },
          "unreadable/corrupt broker reload handoff; reseeding from EOF"
        );
      }
    }
    const byteOffset = resolveBootByteOffset({ handoff, logPath, eofSize: stat.size, now: Date.now() });
    // CTL-1077 remediate: unlink whenever a handoff was read (not only when the
    // resolved offset differs from EOF). When a fresh handoff's byteOffset happens
    // to coincide with EOF the old guard left the file on disk, risking one extra
    // re-process on a fast subsequent restart. Consuming it once is always correct.
    if (handoff) {
      try { unlinkSync(handoffPath); } catch { /* ok */ }
    }
    seedTailer({ logPath, byteOffset });
    log.info({ byteOffset, logPath }, "starting");
  } catch {
    log.info({ logPath }, "starting (no log file yet)");
  }

  appendEvent({
    event: "broker.daemon.startup",
    orchestrator: null,
    worker: null,
    detail: {
      pid: process.pid,
      recovered_interests: interests.size,
      // CTL-643: surface boot-time GC results so the startup event captures
      // how many stale interests were pruned and why.
      gc_pruned: gcResult.pruned,
      gc_by_reason: gcResult.byReason,
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
    stopTailing();
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
