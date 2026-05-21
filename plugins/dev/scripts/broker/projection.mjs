// projection.mjs — durable projections of broker state: interest persistence
// (broker-interests.json), the broker.state.json liveness file, and the
// worker-state shadow file (*.json.projected).
//
// CTL-529: third step of the execution-core module split. projection.mjs reads
// shared state through state.mjs getters and persists it to disk; it imports
// config + state + broker-state.mjs and never imports router.mjs or tailer.mjs,
// so it sits cleanly below the router in the dependency DAG.

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import {
  log,
  GROQ_KEY_SOURCE,
  GROQ_KEY_PREFIX,
  GROQ_GATEWAY_ENABLED,
  GROQ_GATEWAY_BASE_URL,
  DETERMINISTIC_INTEREST_TYPES,
} from "./config.mjs";
import {
  getInterests,
  getWaitingSessionsMap,
  getOrchestratorStatusMap,
  getBrokerStartedAt,
  getLastWakeAt,
  getLastRegisterAt,
} from "./state.mjs";
import { getRecentAgents } from "./broker-state.mjs";

// Identity-stable aliases for the shared maps — disk I/O lives here, the data
// lives in state.mjs (research Open Question #1).
const interests = getInterests();
const waitingSessions = getWaitingSessionsMap();
const orchestratorStatusMap = getOrchestratorStatusMap();

// --- Interest persistence ---
// CTL-350: resolve paths per-call so tests can redirect by setting CATALYST_DIR.
// Production daemons still pin a stable value at launch.
function getInterestsFile() {
  const catalystDir = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
  return resolve(catalystDir, "broker-interests.json");
}

function getLegacyInterestsFile() {
  const catalystDir = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
  return resolve(catalystDir, "filter-interests.json");
}

// CTL-350: load-time guard. Test-only session_ids matching this pattern are
// skipped so historical residue (sess-prose-7 etc.) does not get loaded into
// production state and included in every Groq classification batch.
const PROSE_TEST_SESSION = /^sess-prose-\d+$/;

// One-time rename: legacy filter-interests.json → broker-interests.json on startup.
export function migrateLegacyInterestsFile() {
  const interestsFile = getInterestsFile();
  const legacyFile = getLegacyInterestsFile();
  try {
    if (existsSync(legacyFile) && !existsSync(interestsFile)) {
      renameSync(legacyFile, interestsFile);
      log.info({ from: legacyFile, to: interestsFile }, "migrated legacy interests file");
    }
  } catch (err) {
    log.error({ err: err.message }, "failed to migrate legacy interests file");
  }
}

// CTL-352: defense-in-depth for the on-disk interests file.
//   1. Skip prose-* test residue at save (mirror of the CTL-350 load guard).
//   2. Refuse to write an empty array unless CATALYST_BROKER_ALLOW_EMPTY_SAVE=1
//      — protects against silent flatten-to-zero events. The on-disk file is
//      preserved and a warn line records previousCount for forensics.
//   3. Atomic write via tmp + rename so a crash mid-write never leaves a
//      partial file on disk.
export function saveInterests() {
  const interestsFile = getInterestsFile();
  try {
    mkdirSync(dirname(interestsFile), { recursive: true });

    const allEntries = [...interests.entries()];
    const filtered = [];
    let skipped = 0;
    for (const [id, reg] of allEntries) {
      if (reg?.session_id && PROSE_TEST_SESSION.test(reg.session_id)) {
        skipped++;
        continue;
      }
      filtered.push([id, reg]);
    }
    if (skipped > 0) {
      log.info({ skipped }, "saveInterests: dropped prose-* test residue");
    }

    if (filtered.length === 0 && process.env.CATALYST_BROKER_ALLOW_EMPTY_SAVE !== "1") {
      let previousCount = 0;
      try {
        const existing = JSON.parse(readFileSync(interestsFile, "utf8"));
        previousCount = Array.isArray(existing) ? existing.length : 0;
      } catch {
        // no existing file or parse error — previousCount stays 0
      }
      log.warn(
        { previousCount },
        "refusing to save empty interests file — on-disk preserved (set CATALYST_BROKER_ALLOW_EMPTY_SAVE=1 to override)"
      );
      return;
    }

    const tmp = `${interestsFile}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(filtered, null, 2));
      renameSync(tmp, interestsFile);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* tmp already gone */
      }
      throw err;
    }
  } catch (err) {
    log.error({ err: err.message }, "failed to save interests");
  }
}

export function loadPersistedInterests() {
  const interestsFile = getInterestsFile();
  try {
    const entries = JSON.parse(readFileSync(interestsFile, "utf8"));
    let skipped = 0;
    for (const [id, reg] of entries) {
      if (reg?.session_id && PROSE_TEST_SESSION.test(reg.session_id)) {
        skipped++;
        log.warn({ interestId: id, sessionId: reg.session_id }, "skipping prose-* test residue");
        continue;
      }
      interests.set(id, reg);
    }
    if (interests.size || skipped) {
      log.info({ count: interests.size, skipped }, "loaded persisted interests");
    }
  } catch {
    // No file yet or parse error — fine
  }
}

// --- State file (CTL-343) ---
// ~/catalyst/broker.state.json is the single source of truth for at-a-glance
// broker liveness. Consumed by `catalyst-broker status --json`,
// `catalyst-monitor status --json`, and the HUD header chips.
// CTL-352: resolve path per-call so tests can redirect via CATALYST_DIR.
export function getBrokerStateFilePath() {
  const catalystDir = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
  return resolve(catalystDir, "broker.state.json");
}

export function buildBrokerState({ probe } = {}) {
  // CTL-403: snapshot current waiting sessions for broker.state.json so the HUD
  // can show 'waiting for X (timeout in Y)' without a separate query.
  const now = Date.now();
  const activeWaiting = [...waitingSessions.entries()]
    .filter(([, ws]) => ws.timeoutAt > now)
    .map(([sessionId, ws]) => ({
      sessionId,
      ticket: ws.ticket,
      orchestrator: ws.orchestrator,
      waitFor: ws.waitFor,
      timeoutAt: new Date(ws.timeoutAt).toISOString(),
      reason: ws.reason,
    }));

  return {
    pid: process.pid,
    startedAt: getBrokerStartedAt() ?? new Date().toISOString(),
    // CTL-447: enumerate the deterministic interest types this broker supports
    // so `catalyst-broker status --json` can advertise them to clients.
    supportedInterestTypes: [...DETERMINISTIC_INTEREST_TYPES],
    // CTL-352: liveness fields so the HUD pill and operators can detect a
    // silently-dead broker (interests.size === 0 with stale lastWakeAt).
    interestCount: interests.size,
    lastWakeAt: getLastWakeAt(),
    lastRegisterAt: getLastRegisterAt(),
    // CTL-403: active wait-loop sessions (empty array when no active waits).
    waitingSessions: activeWaiting,
    // CTL-421: expose prose enabled state so the HUD can badge inactive prose interests.
    proseEnabled: process.env.CATALYST_BROKER_PROSE_ENABLED === "1",
    keyHealth: {
      groq: {
        present: GROQ_KEY_SOURCE !== null,
        source: GROQ_KEY_SOURCE,
        prefix: GROQ_KEY_PREFIX,
        probeStatus: probe?.status ?? (GROQ_KEY_SOURCE === null ? "missing" : "pending"),
        probeError: probe?.error ?? null,
        probeAt: probe ? new Date().toISOString() : null,
        modelCount: probe?.modelCount ?? null,
      },
    },
    gateway: {
      enabled: GROQ_GATEWAY_ENABLED,
      baseUrl: GROQ_GATEWAY_BASE_URL,
    },
    // CTL-402: surface recent agent exit reasons for observability.
    recentAgents: (() => { try { return getRecentAgents(); } catch { return []; } })(),
    // CTL-405: live orchestrator phases for HUD / operator visibility.
    activeOrchestrators: [...orchestratorStatusMap.entries()].map(([orchId, s]) => ({
      orchestratorId: orchId,
      phase: s.phase,
      wave: s.wave,
      activeWorkers: s.activeWorkers,
      totalWorkers: s.totalWorkers,
      summary: s.summary,
      ts: s.ts,
      sessionId: s.sessionId,
    })),
  };
}

export function writeBrokerStateFile(state, { path } = {}) {
  const target = path ?? getBrokerStateFilePath();
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, target);
  } catch (err) {
    log.warn({ err: err.message, path: target }, "failed to write broker state file");
  }
}

// CTL-352: internal helper called at every state mutation that should bump
// liveness fields in broker.state.json. Single-line write + atomic rename, so
// per-event calls (dozens/sec at peak) are cheap.
export function persistBrokerState({ probe } = {}) {
  writeBrokerStateFile(buildBrokerState({ probe }));
}

// CTL-483: worker state projection (Phase 1 — shadow path).
//
// During the dual-write migration period, scripts that mutate
// `workers/<TICKET>.json` ALSO emit a `worker.state_changed` event carrying
// the full new state. The broker projects that state to
// `<canonical>.projected` so the direct write is never racing with the
// projection. A separate verification CLI (orchestrate-shadow-diff) compares
// canonical vs projected to confirm byte-for-byte agreement before Phase 2
// cuts over to broker-as-sole-writer at the canonical path.
//
// CTL-529: the worker.state_changed event handler (handleWorkerStateChanged)
// lives in router.mjs with the other event handlers; it calls the path +
// writer helpers below through the existing router → projection import edge.

export function getProjectedWorkerStatePath(orchestratorId, ticket) {
  const runsDir =
    process.env.CATALYST_RUNS_DIR ??
    `${process.env.CATALYST_DIR ?? `${homedir()}/catalyst`}/runs`;
  return resolve(runsDir, orchestratorId, "workers", `${ticket}.json.projected`);
}

export function writeProjectedWorkerState(target, state, meta = {}) {
  try {
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    const payload = {
      ...state,
      _projected: {
        writer: meta.writer ?? "unknown",
        ts: meta.ts ?? new Date().toISOString(),
      },
    };
    try {
      writeFileSync(tmp, JSON.stringify(payload, null, 2));
      renameSync(tmp, target);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* tmp already gone */
      }
      throw err;
    }
  } catch (err) {
    log.warn({ err: err.message, path: target }, "failed to write projected worker state");
  }
}
