// router.mjs — interest matching + wake emission: the broker's execution-core
// "router". Wake emission + the idempotency cache, the canonical-aware event
// readers, registration + agent handlers, the three deterministic matchers,
// the Groq prose path, debounce batching, the heartbeat watchdog, and the
// processEvent central dispatch.
//
// CTL-529: extracted from index.mjs as the fourth (and largest) step of the
// execution-core module split. router.mjs imports config + state + projection
// + broker-state.mjs; nothing imports router except tailer.mjs and the index
// barrel, so it sits one level below the daemon entrypoint in the DAG.

import { appendFileSync, mkdirSync, readFileSync, openSync, fstatSync, closeSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  log,
  getEventLogPath,
  isSentinelLeak,
  GROQ_API_KEY,
  GROQ_ENDPOINT,
  GROQ_EXTRA_HEADERS,
  GROQ_MODEL,
  DEBOUNCE_MS,
  HARD_CAP_MS,
  MAX_BATCH_SIZE,
  WATCHDOG_INTERVAL_MS,
  HEARTBEAT_STALE_MS,
  ORCH_STATUS_REPLAY_STALE_MS,
  DETERMINISTIC_INTEREST_TYPES,
  isIngestionRecencyEnabled,
  MONITOR_RECENCY_DEGRADED_MS,
  MONITOR_RECENCY_DOWN_MS,
  GITHUB_RECENCY_DEGRADED_MS,
  GITHUB_RECENCY_DOWN_MS,
  INGESTION_RECENCY_HOLDDOWN_MS,
  INGESTION_SEED_BYTES,
  getPrevMonthEventLogPath,
} from "./config.mjs";
import {
  getInterests,
  getLastHeartbeat,
  getWorkerToOrchestrator,
  getWaitingSessionsMap,
  getOrchestratorStatusMap,
  getBrokerStartedAt,
  setLastWakeAt,
  setLastRegisterAt,
  getDegradedEmittedAt,
  setDegradedEmittedAt,
} from "./state.mjs";
import {
  saveInterests,
  persistBrokerState,
  getProjectedWorkerStatePath,
  writeProjectedWorkerState,
  projectWorkerStateEvent,
} from "./projection.mjs";
import {
  upsertFilterStateOpen,
  setFilterStateMerged,
  setFilterStateDeploying,
  setFilterStateDeployed,
  setFilterStateFailed,
  deleteFilterState,
  upsertAgent,
  markAgentDone,
  getAgentsByTicket,
  upsertTicketState,
  upsertTicketDescriptor,
  markTicketRemovedByUuid,
  upsertTicketFence,
  setTicketHeldSince,
  clearTicketHeldSince,
  upsertWaitingSession,
  clearWaitingSession,
  hasActiveWorkers,
} from "./broker-state.mjs";
import { sessionLiveness } from "./session-liveness.mjs";
import {
  handlePluginRefreshEvent,
  resolveRepoFullName,
  refreshAllPluginCheckouts,
  startPluginDriftCheck,
} from "./plugin-refresh.mjs";
import { handleStackReloadEvent } from "./stack-reload.mjs";
import { getLastByteOffset } from "./tailer.mjs";
import {
  severityNumber,
  deriveTraceId,
  deriveSpanId,
  generateEventId,
  synthesizeEventId,
  hostName,
  hostId,
} from "../orch-monitor/lib/canonical-event-shared.ts";
import {
  PHASE_EVENT_PATTERN as _PHASE_EVENT_PATTERN,
  FORBIDDEN_PREFIXES,
  PROTECTED_EXACT_NAMES,
} from "./namespace-contract.mjs";
// CTL-1122: ingestion-silence detector (PR1 = monitor recency). The pure
// classifier (no I/O) + the broker-side alarm machine + the byte-bounded tail
// reader used once at boot to warm the last-seen map (a leaf module, no
// execution-core deps — reused instead of re-reading the whole multi-hundred-MB
// log per the design-review D2 blocker).
import { evaluateSource } from "../lib/ingestion-recency.mjs";
import {
  MONITOR_SERVICE_NAME,
  GITHUB_SERVICE_NAME,
  initialRecencyAlarmState,
  nextRecencyAlarmState,
  emitIngestionRecencyEvent,
} from "./ingestion-recency.mjs";
import { scanEventsChunked } from "../execution-core/event-tail.mjs";

// Identity-stable aliases for the shared maps — the router mutates these; the
// canonical instances live in state.mjs (see barrel-exports.test.mjs).
const interests = getInterests();
const lastHeartbeat = getLastHeartbeat();
const workerToOrchestrator = getWorkerToOrchestrator();
const waitingSessions = getWaitingSessionsMap();
const orchestratorStatusMap = getOrchestratorStatusMap();

// CTL-352: empty-interests degraded threshold (5-minute startup grace).
const DEGRADED_THRESHOLD_MS = 5 * 60 * 1000;

// CTL-993: merge-to-main plugin-checkout refresh wiring. The broker module lives
// at <repo>/plugins/dev/scripts/broker/router.mjs, so the repo .catalyst config
// (which carries feedback.githubRepo) is four levels up. The machine config path
// matches lib/plugin-dirs.sh's resolution (CATALYST_MACHINE_CONFIG override).
const __REPO_CONFIG_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  ".catalyst",
  "config.json"
);
function __machineConfigPath() {
  const xdg = process.env.XDG_CONFIG_HOME || `${process.env.HOME ?? ""}/.config`;
  return resolve(process.env.CATALYST_MACHINE_CONFIG || `${xdg}/catalyst/config.json`);
}
// Resolved once per daemon lifetime — the repo identity does not change while
// the broker runs, and the file walk should not repeat on every event.
let __repoFullNameCached;
function __repoFullName() {
  if (__repoFullNameCached === undefined) {
    try {
      __repoFullNameCached = resolveRepoFullName({
        machineConfigPath: __machineConfigPath(),
        repoConfigPath: __REPO_CONFIG_PATH,
      });
    } catch {
      __repoFullNameCached = null;
    }
  }
  return __repoFullNameCached;
}
// The broker's own HEAD at boot (the code it is actually running). Lets the
// refresh emit restart_needed when the checkout advances past it. Best-effort —
// null when not in a checkout (skew simply not flagged). CTL-669 model.
// __loadedCommitRoot pairs it with the broker's own checkout toplevel so
// restart_needed only fires for THAT checkout — not for an unrelated
// pluginDirs checkout that happens to advance.
let __loadedCommitCached;
let __loadedCommitRootCached;
function __loadedCommit() {
  if (__loadedCommitCached === undefined) {
    try {
      __loadedCommitCached = execFileSync(
        "git",
        ["-C", dirname(fileURLToPath(import.meta.url)), "rev-parse", "HEAD"],
        { encoding: "utf8" }
      ).trim();
    } catch {
      __loadedCommitCached = null;
    }
  }
  return __loadedCommitCached;
}
function __loadedCommitRoot() {
  if (__loadedCommitRootCached === undefined) {
    try {
      __loadedCommitRootCached = execFileSync(
        "git",
        ["-C", dirname(fileURLToPath(import.meta.url)), "rev-parse", "--show-toplevel"],
        { encoding: "utf8" }
      ).trim();
    } catch {
      __loadedCommitRootCached = null;
    }
  }
  return __loadedCommitRootCached;
}

// === Emission ===
// Canonical envelope helpers. Primitives (sha256Hex, severityNumber,
// deriveTraceId, deriveSpanId, generateEventId, synthesizeEventId) live in
// orch-monitor/lib/canonical-event-shared.ts and are imported above (CTL-344).
// pluginVersion is broker-local because the broker resolves plugin.json
// relative to its own location and shouldn't share orch-monitor's resolver.

const __PLUGIN_JSON_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".claude-plugin",
  "plugin.json"
);
let __pluginVersionCached = null;

export function pluginVersion() {
  if (__pluginVersionCached !== null) return __pluginVersionCached;
  try {
    const parsed = JSON.parse(readFileSync(__PLUGIN_JSON_PATH, "utf8"));
    __pluginVersionCached = typeof parsed?.version === "string" ? parsed.version : "0.0.0";
  } catch {
    __pluginVersionCached = "0.0.0";
  }
  return __pluginVersionCached;
}

// CTL-350: compact summary of a triggering event, inlined into wake payloads
// so receiving agents have enough context to act without re-fetching state
// from GitHub/Linear/git. `lookup_jq` is a ready-to-run query against the
// monthly-rotated event log for callers who do need full event details.
const PAYLOAD_EXCERPT_KEYS = ["state", "stateType", "conclusion", "title", "merged", "action"];

export function summarizeEvent(event) {
  const id = event.id ?? synthesizeEventId(event);
  const attrs = event.attributes ?? {};
  const ts = event.ts ?? new Date().toISOString();
  const name = event.event ?? attrs["event.name"] ?? "";
  const payload =
    event.body && typeof event.body === "object" && "payload" in event.body
      ? event.body.payload
      : (event.detail ?? null);
  const scope = event.scope ?? {};
  const month = typeof ts === "string" ? ts.slice(0, 7) : "";
  const excerpt = {};
  if (payload && typeof payload === "object") {
    for (const k of PAYLOAD_EXCERPT_KEYS) {
      if (payload[k] !== undefined) excerpt[k] = payload[k];
    }
  }
  const message = typeof event.body?.message === "string" ? event.body.message.slice(0, 200) : "";
  const pr = attrs["vcs.pr.number"] ?? scope.pr ?? null;
  const repo = attrs["vcs.repository.name"] ?? scope.repo ?? null;
  return {
    id,
    name,
    ts,
    ticket: attrs["linear.issue.identifier"] ?? payload?.ticket ?? null,
    pr,
    repo,
    message,
    payload_excerpt: excerpt,
    lookup_jq: `jq 'select(.id == "${id}")' ~/catalyst/events/${month}.jsonl`,
  };
}

// Translate the broker's internal {event, orchestrator, worker, detail} shape
// into a canonical OTel-style envelope. Severity defaults to INFO — broker
// emissions today (filter.wake.*, broker.daemon.startup) are all info-level.
//
// CTL-362: `legacy.repo` (or the `legacy.vcsRepo` alias) populates
// `attributes["vcs.repository.name"]` so the HUD's REPO column resolves for
// `filter.wake.*` events. Pass it through from the interest record's `repo`
// field at every wake-emission call site that has one.
export function buildCanonicalEnvelope(legacy) {
  const eventName = legacy.event ?? "";
  const orch = legacy.orchestrator ?? null;
  const worker = legacy.worker ?? null;
  const severity = legacy.severity ?? "INFO";
  const ts = legacy.ts ?? new Date().toISOString();
  const repo = legacy.repo ?? legacy.vcsRepo ?? null;

  const attributes = { "event.name": eventName };
  if (orch) attributes["catalyst.orchestrator.id"] = orch;
  if (worker) attributes["catalyst.worker.ticket"] = worker;
  if (typeof repo === "string" && repo.length > 0) {
    attributes["vcs.repository.name"] = repo;
  }

  return {
    ts,
    id: generateEventId(),
    observedTs: ts,
    severityText: severity,
    severityNumber: severityNumber(severity),
    traceId: deriveTraceId(orch),
    spanId: deriveSpanId(worker),
    // CTL-1135: caused_by — the id of the triggering event (additive; null when
    // absent). For filter.wake.* events the cause is the source event that matched;
    // derive it from the already-present detail.source_event_ids[0] (the deterministic
    // pr-lifecycle path is single-valued; the prose fan-in path uses first-matched =
    // best-effort). An explicit legacy.causedBy overrides.
    caused_by:
      legacy.causedBy ??
      legacy.caused_by ??
      (Array.isArray(legacy.detail?.source_event_ids)
        ? legacy.detail.source_event_ids[0] ?? null
        : null),
    resource: {
      "service.name": "catalyst.broker",
      "service.namespace": "catalyst",
      "service.version": pluginVersion(),
      "host.name": hostName(),
      "host.id": hostId(),
    },
    attributes,
    body: { payload: legacy.detail ?? null },
  };
}

export function appendEvent(event) {
  const logPath = getEventLogPath();
  if (isSentinelLeak(event, logPath)) {
    process.stderr.write(
      `[catalyst] dropped sentinel(orch-test) event from default prod log: ${getEventName(event)}\n`
    );
    return;
  }
  mkdirSync(dirname(logPath), { recursive: true });
  const canonical = buildCanonicalEnvelope(event);
  appendFileSync(logPath, JSON.stringify(canonical) + "\n");
}

// CTL-406: idempotency cache for filter.wake emissions. Prevents the same
// (source_event_id, interest_id) pair from producing more than one wake within
// the TTL window — guards against double-ingest of the same log line and
// intra-call duplicate matches across routing functions.
const _emittedWakeCache = new Map(); // key -> expiry timestamp (ms)
const WAKE_CACHE_TTL_MS = 60_000;

function shouldSkipWake(sourceEventId, interestId) {
  if (!sourceEventId) return false;
  const key = `${sourceEventId}:${interestId}`;
  const expiry = _emittedWakeCache.get(key);
  if (expiry !== undefined && Date.now() < expiry) return true;
  _emittedWakeCache.set(key, Date.now() + WAKE_CACHE_TTL_MS);
  return false;
}

export function __clearEmittedWakeCacheForTest() {
  _emittedWakeCache.clear();
}

// === CTL-1122: ingestion-silence detection (the surviving-process observer) ===
// The broker tails every event, so it records the last-seen timestamp + event id
// per service.name inline (zero extra I/O on the live path) and, each watchdog
// tick, judges the orch-monitor's liveness from its catalyst.monitor heartbeat
// recency. This is the out-of-process inversion the 11h outage proved we need:
// the monitor's own kind:"self" probe reports `up` iff the monitor answers, so
// it can never observe its own death.
const _lastSeenByService = new Map(); // service.name -> { ts: epochMs, id: string|null }

// CTL-1122 PR2: per-source alarm state. PR1 keyed a single _monitorRecencyAlarm;
// the watchdog now judges several sources (monitor + the activity-gated
// github/linear webhook ingestion), each with its own edge-trigger/holddown
// state. service.name -> alarmState (initialRecencyAlarmState shape).
const _recencyAlarmByService = new Map();

// RECENCY_SOURCES — one descriptor per ingestion source the watchdog evaluates
// each tick. `gated:true` sources are activity-gated: their silence only alarms
// while the fleet is actually working (hasActiveWorkers), because they idle
// organically. The monitor heartbeat is a fixed ~30s cadence → ungated, with
// PR1's tight 3m/10m thresholds unchanged.
const RECENCY_SOURCES = [
  {
    serviceName: MONITOR_SERVICE_NAME,
    degradedAfterMs: MONITOR_RECENCY_DEGRADED_MS,
    downAfterMs: MONITOR_RECENCY_DOWN_MS,
    gated: false,
  },
  {
    serviceName: GITHUB_SERVICE_NAME,
    degradedAfterMs: GITHUB_RECENCY_DEGRADED_MS,
    downAfterMs: GITHUB_RECENCY_DOWN_MS,
    gated: true,
  },
  // linear (catalyst.linear) is DEFERRED in PR2 (fork a): the linear-webhook
  // bot-skip guard suppresses bot-authored issue events before they reach the
  // log, so catalyst.linear goes quiet even while a worker is in-flight — an
  // irreducible false-alarm risk. When a non-flaky threshold is found, it is a
  // one-line add here ({ serviceName: LINEAR_SERVICE_NAME, ..., gated: true }).
];

// recencyAlarmFor — lazily materialize (and store) a source's alarm state so a
// never-ticked source still reads as the initial fail-open state via the test
// seams. The stored object is what subsequent ticks advance.
function recencyAlarmFor(serviceName) {
  let state = _recencyAlarmByService.get(serviceName);
  if (!state) {
    state = initialRecencyAlarmState();
    _recencyAlarmByService.set(serviceName, state);
  }
  return state;
}

// recordLastSeen — fold one ingested event into the per-service last-seen map.
// Keyed on the canonical resource["service.name"]; legacy flat events (no
// resource block) are skipped. The >= guard stops an out-of-order replay from
// regressing a newer observation.
function recordLastSeen(event) {
  const svc = event?.resource?.["service.name"];
  if (!svc) return;
  const tsMs = Date.parse(event?.ts ?? "");
  if (Number.isNaN(tsMs)) return;
  const prev = _lastSeenByService.get(svc);
  if (!prev || tsMs >= prev.ts) {
    _lastSeenByService.set(svc, { ts: tsMs, id: event.id ?? null });
  }
}

// seedLastSeenByService — warm the map ONCE at broker start from the log tail,
// BEFORE live tailing begins. Without it, a broker that (re)starts while the
// monitor is ALREADY dead has no catalyst.monitor entry → classifyRecency
// returns "unknown" → fail-open → the dead monitor is never detected across the
// restart (precisely the all-restart, monitor-stays-dead 11h-outage class).
// Bounded byte read (INGESTION_SEED_BYTES) via the shared byte-correct
// scanEventsChunked; synchronous (readSync) so it finishes before startTailing
// with no race. Best-effort — a missing/unreadable log just leaves the map cold
// (still fail-open, never a false alarm).
// scanLogTailInto — bounded byte read of one log file's tail, folding each event
// into the map. Returns the number of events folded (0 for a missing/unreadable
// file). A present-but-unreadable log (EACCES/locked) is warned — louder than a
// simply-absent one — so a detector that boots blind is not silent. Best-effort:
// never throws.
function scanLogTailInto(logPath, seedBytes) {
  let size;
  try {
    const fd = openSync(logPath, "r");
    try {
      size = fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.warn({ err: err?.message, logPath }, "ingestion-recency: seed log unreadable");
    }
    return 0;
  }
  const fromOffset = Math.max(0, size - seedBytes);
  let folded = 0;
  try {
    scanEventsChunked({
      path: logPath,
      fromOffset,
      onEvent: (e) => {
        folded += 1;
        recordLastSeen(e);
      },
    });
  } catch (err) {
    log.warn({ err: err?.message, logPath }, "ingestion-recency: seed scan failed");
  }
  return folded;
}

export function seedLastSeenByService({
  logPath = getEventLogPath(),
  seedBytes = INGESTION_SEED_BYTES,
} = {}) {
  let folded = scanLogTailInto(logPath, seedBytes);
  // Month-boundary fallback: if the current-month tail held no monitor heartbeat
  // (a restart just after a UTC rollover while the monitor is already dead — no
  // fresh beat has landed in the new file yet), the last beat lives in the PRIOR
  // month. Scan it too; otherwise the seed silently fails for exactly the
  // all-restart, monitor-stays-dead outage class it exists to close.
  if (!_lastSeenByService.has(MONITOR_SERVICE_NAME)) {
    folded += scanLogTailInto(getPrevMonthEventLogPath(), seedBytes);
  }
  // Loud-on-blind: a non-empty log that yields no monitor baseline means the
  // detector booted cold for the monitor (corrupt tail / out-of-window / never
  // emitted). Fail-open is intentional, but the operator should see it.
  const monitorSeen = _lastSeenByService.has(MONITOR_SERVICE_NAME);
  if (folded > 0 && !monitorSeen) {
    log.warn(
      { services: _lastSeenByService.size, folded },
      "ingestion-recency: seeded but no monitor heartbeat in tail window (detector cold for monitor)",
    );
  } else {
    log.info(
      { services: _lastSeenByService.size, monitorSeen },
      "ingestion-recency: seeded last-seen map",
    );
  }
}

// checkSourceRecency — one watchdog-tick evaluation of ONE source's ingestion
// freshness → edge-triggered catalyst.ingestion.{stale,recovered}. Fail-open: a
// never-seen source classifies "unknown" and never alarms. The emit is
// best-effort (emitIngestionRecencyEvent never throws). Returns the emit
// decision so the wiring test can assert it without parsing the log.
//
// CTL-1122 PR2: generalizes PR1's monitor-only checkMonitorRecency. A `gated`
// source's silence only matters when the fleet is in-flight — with no active
// worker, severity is forced to "up" BEFORE the edge-trigger machine, so the
// source never fires stale and any latched outage clears as a paired recovered
// (fork c — keeps the stale/recovered ledger balanced for CTL-1123). The gate
// is a pre-classify override; the alarm machine itself is untouched.
function checkSourceRecency(source, now) {
  if (!isIngestionRecencyEnabled()) return null;
  const seen = _lastSeenByService.get(source.serviceName);
  const prevAlarm = recencyAlarmFor(source.serviceName);
  let { severity } = evaluateSource({
    lastSeenTs: seen?.ts ?? null,
    nowMs: now,
    degradedAfterMs: source.degradedAfterMs,
    downAfterMs: source.downAfterMs,
  });
  if (source.gated && !fleetIsActive(now)) {
    // Gate closed: the fleet isn't working, so webhook silence is expected, not
    // a fault. Force "up" → no stale, and a clean clear of any open outage.
    severity = "up";
  }
  const { state, emit } = nextRecencyAlarmState(prevAlarm, {
    severity,
    nowMs: now,
    holddownMs: INGESTION_RECENCY_HOLDDOWN_MS,
  });
  if (emit) {
    const recovered = emit === "recovered";
    // stale describes the silence (age since the last beat, vs the down
    // threshold); recovered describes the outage it CLEARED (its duration, no
    // threshold). ageMs is clamped so clock skew (a future beat) can never emit
    // a negative age.
    const ageMs = recovered
      ? prevAlarm.downEmittedAt != null
        ? Math.max(0, now - prevAlarm.downEmittedAt)
        : null
      : seen
        ? Math.max(0, now - seen.ts)
        : null;
    const ok = emitIngestionRecencyEvent({
      action: emit,
      sourceName: source.serviceName,
      ageMs,
      thresholdMs: recovered ? null : source.downAfterMs,
      lastSeenAt: seen ? new Date(seen.ts).toISOString() : null,
      // the forensic link: the last beat before silence (stale) / the fresh
      // beat that cleared it (recovered).
      causedBy: seen?.id ?? null,
    });
    if (!ok) {
      // The append FAILED (e.g. transient ENOSPC/EACCES — conditions correlated
      // with the very outage we detect). Do NOT advance the alarm state: leaving
      // it un-latched means the next tick re-attempts the emit, so a real death
      // is never reduced to a single lost broker.log line. (Also stops a later
      // recovered from pairing against a stale that was never appended.)
      return null;
    }
  }
  _recencyAlarmByService.set(source.serviceName, state);
  return emit;
}

// fleetIsActive — the activity-gate input for gated recency sources. Defensive
// wrapper around hasActiveWorkers: a watchdog tick must NEVER throw, and the
// broker-state DB read could fail (e.g. closed handle in an isolated unit test,
// or a transient error). On failure, fail the gate CLOSED (treat as no active
// work) — the no-false-alarm safe default, consistent with the detector's
// fail-open-to-"up" philosophy.
function fleetIsActive(now) {
  try {
    return hasActiveWorkers(new Date(now).toISOString());
  } catch {
    return false;
  }
}

// Test seams (CTL-1122) — mirror the _emittedWakeCache __…ForTest pattern.
export function __clearIngestionRecencyForTest() {
  _lastSeenByService.clear();
  _recencyAlarmByService.clear();
}
export function __setLastSeenForTest(serviceName, entry) {
  _lastSeenByService.set(serviceName, entry);
}
export function __getLastSeenByServiceForTest() {
  return _lastSeenByService;
}
// PR1's monitor-scoped accessor, preserved verbatim for the existing wiring
// tests; reads the monitor entry out of the per-source map.
export function __getMonitorRecencyAlarmForTest() {
  return recencyAlarmFor(MONITOR_SERVICE_NAME);
}
// PR2: per-source accessor for the github/linear isolation tests.
export function __getRecencyAlarmForTest(serviceName) {
  return recencyAlarmFor(serviceName);
}

// CTL-357: one-shot startup event. If the Groq prose path is gated off (the
// default) and any non-deterministic interests are sitting in the interests
// table (loaded from disk for backward compat), emit a single
// broker.daemon.prose_disabled event so the operator can see at a glance that
// those entries exist but will never fire. Idempotent across the process
// lifetime — once emitted, subsequent calls are no-ops.
let _proseDisabledEmitted = false;

export function __resetProseDisabledForTest() {
  _proseDisabledEmitted = false;
}

export function maybeEmitProseDisabled() {
  if (process.env.CATALYST_BROKER_PROSE_ENABLED === "1") return;
  if (_proseDisabledEmitted) return;
  const proseEntries = [...interests.entries()].filter(
    ([, reg]) => !DETERMINISTIC_INTEREST_TYPES.has(reg?.interest_type ?? null)
  );
  if (proseEntries.length === 0) return;
  appendEvent({
    event: "broker.daemon.prose_disabled",
    orchestrator: null,
    worker: null,
    detail: {
      count: proseEntries.length,
      sample: proseEntries.slice(0, 3).map(([id]) => id),
    },
  });
  _proseDisabledEmitted = true;
}

// CTL-336: read name/payload/orchestrator from canonical OTel-format events
// (data in `attributes` + `body.payload`) as well as legacy flat events
// (data in `event` + `detail` + `orchestrator`). Resolved here so the
// rest of the broker can stay shape-agnostic.
export function getEventName(event) {
  return event.event ?? event.attributes?.["event.name"] ?? "";
}
function getEventPayload(event) {
  return event.detail ?? event.body?.payload ?? {};
}
function getEventOrchestrator(event) {
  return event.orchestrator ?? event.attributes?.["catalyst.orchestrator.id"] ?? null;
}

// CTL-381: canonical OTel webhook envelopes carry no top-level `scope`.
// Resolve PR/ref/sha/environment from `event.scope` (legacy) OR `attributes`
// (canonical), mirroring how getEventPayload bridges detail / body.payload.
function getEventScope(event) {
  const scope = event.scope ?? {};
  const attrs = event.attributes ?? {};
  return {
    pr: scope.pr ?? attrs["vcs.pr.number"] ?? undefined,
    ref: scope.ref ?? attrs["vcs.ref.name"] ?? undefined,
    sha: scope.sha ?? attrs["vcs.revision"] ?? undefined,
    environment: scope.environment ?? attrs["deployment.environment"] ?? undefined,
  };
}

export function handleRegister(event) {
  const d = getEventPayload(event);
  const orchestrator = getEventOrchestrator(event);
  const id = d.interest_id ?? orchestrator ?? d.notify_event;
  if (!id) return;
  const isPrLifecycle = d.interest_type === "pr_lifecycle";
  const isTicketLifecycle = d.interest_type === "ticket_lifecycle";
  const isCommsLifecycle = d.interest_type === "comms_lifecycle";
  const isPhaseLifecycle = d.interest_type === "phase_lifecycle";
  const isWorkflowSubstep = d.interest_type === "workflow_substep_lifecycle";
  interests.set(id, {
    notify_event: d.notify_event ?? `filter.wake.${id}`,
    prompt: d.prompt ?? "",
    context: d.context ?? null,
    orchestrator: orchestrator,
    session_id: d.session_id ?? null,
    persistent: d.persistent === true,
    interest_type: d.interest_type ?? null,
    // pr_lifecycle fields (CTL-284)
    pr_numbers: isPrLifecycle ? (Array.isArray(d.pr_numbers) ? d.pr_numbers : []) : null,
    repo: isPrLifecycle ? (d.repo ?? null) : null,
    base_branches: isPrLifecycle ? (Array.isArray(d.base_branches) ? d.base_branches : []) : null,
    // ticket_lifecycle fields (CTL-303)
    tickets: isTicketLifecycle ? (Array.isArray(d.tickets) ? d.tickets : []) : null,
    wake_on: isTicketLifecycle ? (Array.isArray(d.wake_on) ? d.wake_on : null) : null,
    // comms_lifecycle fields (CTL-357)
    channel: isCommsLifecycle ? (d.channel ?? null) : null,
    subscriber_kind: isCommsLifecycle ? (d.subscriber_kind ?? null) : null,
    owned_workers: isCommsLifecycle
      ? Array.isArray(d.owned_workers)
        ? d.owned_workers
        : null
      : null,
    subscriber_ticket: isCommsLifecycle ? (d.subscriber_ticket ?? null) : null,
    types_of_interest: isCommsLifecycle
      ? Array.isArray(d.types_of_interest)
        ? d.types_of_interest
        : null
      : null,
    // phase_lifecycle fields (CTL-447) + workflow_substep_lifecycle (CTL-753)
    ticket: (isPhaseLifecycle || isWorkflowSubstep) ? (d.ticket ?? null) : null,
    phase_names: isPhaseLifecycle ? (Array.isArray(d.phase_names) ? d.phase_names : []) : null,
    // CTL-407: suppress redundant wakes when downstream state unchanged.
    // Defaults true for pr_lifecycle (opt-out via suppress_identical_wakes: false).
    // False for comms_lifecycle/ticket_lifecycle (HUD and orchestrator watchers want every event).
    suppress_identical_wakes: d.suppress_identical_wakes !== false && isPrLifecycle,
    last_wake_state: {},
  });

  if (isPrLifecycle) {
    try {
      for (const prNumber of d.pr_numbers ?? []) {
        upsertFilterStateOpen({ interestId: id, prNumber, repo: d.repo ?? "" });
      }
    } catch {
      // filter_state DB not opened — okay for tests
    }
  }

  const persistent = d.persistent === true;
  if (isPrLifecycle) {
    log.info(
      { interestId: id, type: "pr_lifecycle", prs: d.pr_numbers ?? [], persistent },
      "registered"
    );
  } else if (isTicketLifecycle) {
    log.info(
      { interestId: id, type: "ticket_lifecycle", tickets: d.tickets ?? [], persistent },
      "registered"
    );
  } else if (isCommsLifecycle) {
    log.info(
      {
        interestId: id,
        type: "comms_lifecycle",
        channel: d.channel,
        subscriberKind: d.subscriber_kind,
        persistent,
      },
      "registered"
    );
  } else if (isPhaseLifecycle) {
    log.info(
      {
        interestId: id,
        type: "phase_lifecycle",
        ticket: d.ticket,
        phaseNames: d.phase_names ?? [],
        persistent,
      },
      "registered"
    );
  } else {
    log.info({ interestId: id, prompt: d.prompt, persistent }, "registered");
  }
  saveInterests();
  setLastRegisterAt(new Date().toISOString());
  // CTL-352: a fresh registration arms a future degraded event.
  setDegradedEmittedAt(null);
  persistBrokerState();
}

export function handleDeregister(event) {
  const d = getEventPayload(event);
  const id = d.interest_id ?? getEventOrchestrator(event);
  if (!id) return;
  const reg = interests.get(id);
  if (interests.delete(id)) {
    if (reg && reg.interest_type === "pr_lifecycle") {
      try {
        deleteFilterState(id);
      } catch {
        /* DB not opened */
      }
    }
    log.info({ interestId: id }, "deregistered");
    saveInterests();
    persistBrokerState();
  }
}

export function handleOrchestratorTerminated(event) {
  const orchId = event.orchestrator;
  if (!orchId) return;
  let changed = false;
  for (const [id, reg] of interests) {
    if (reg.orchestrator === orchId) {
      if (reg.interest_type === "pr_lifecycle") {
        try {
          deleteFilterState(id);
        } catch {
          /* DB not opened */
        }
      }
      interests.delete(id);
      log.info(
        { interestId: id, orchestrator: orchId },
        "auto-deregistered (orchestrator terminated)"
      );
      changed = true;
    }
  }
  if (changed) {
    saveInterests();
    persistBrokerState();
  }
  // CTL-405: clean up orchestrator status entry on termination.
  orchestratorStatusMap.delete(orchId);
}

// --- Agent identity (CTL-303) ------------------------------------------------

// Handle agent.checkin: store identity and auto-derive pr_lifecycle if claimed_pr is set.
export function handleAgentCheckin(event) {
  // CTL-360: read the payload shape-agnostically — getEventPayload accepts both
  // the legacy flat { detail } shape and the canonical { body.payload } envelope.
  const d = getEventPayload(event);
  const sessionId = d.session_id;
  if (!sessionId) return;

  const agentName = d.agent_name ?? sessionId;
  const ticket = d.ticket ?? null;
  const claimedPr = d.claimed_pr ?? null;
  const orchestrator = d.orchestrator ?? event.orchestrator ?? null;
  const cwd = d.cwd ?? null;
  const repo = d.repo ?? null;

  try {
    upsertAgent({ agentId: sessionId, agentName, sessionId, orchestrator, ticket, claimedPr, cwd });
  } catch {
    // DB not opened — fine for tests
  }

  // Update heartbeat map so the watchdog tracks this agent.
  const existing = lastHeartbeat.get(sessionId);
  lastHeartbeat.set(sessionId, { ts: Date.now(), notified: existing?.notified ?? false });
  if (orchestrator && sessionId !== orchestrator) {
    workerToOrchestrator.set(sessionId, orchestrator);
  }

  // Auto-correlate: if the agent has already claimed a PR, register a
  // pr_lifecycle interest on its behalf — no explicit filter.register needed.
  // CTL-381: thread d.base_branches through so github.push rebase detection
  // works for the auto-registered interest.
  if (claimedPr) {
    _autoRegisterPrLifecycle(sessionId, claimedPr, orchestrator, ticket, repo, d.base_branches);
  }

  log.info({ agentName, sessionId, ticket, claimedPr }, "agent checked in");
}

// Auto-register a pr_lifecycle interest when we learn agent ↔ PR mapping.
// CTL-381: baseBranches is the base_branches array broker_claim_pr sends —
// preserve it so the github.push rebase-detection branch can match.
function _autoRegisterPrLifecycle(sessionId, prNumber, orchestrator, ticket, repo, baseBranches) {
  if (interests.has(sessionId)) return; // don't overwrite explicit registration

  interests.set(sessionId, {
    notify_event: `filter.wake.${sessionId}`,
    prompt: "",
    context: { pr_numbers: [prNumber], tickets: ticket ? [ticket] : [], workers: [sessionId] },
    orchestrator: orchestrator ?? null,
    session_id: sessionId,
    persistent: true,
    interest_type: "pr_lifecycle",
    pr_numbers: [prNumber],
    repo: repo ?? null,
    base_branches: Array.isArray(baseBranches) ? baseBranches : [],
    tickets: null,
    wake_on: null,
  });

  try {
    upsertFilterStateOpen({ interestId: sessionId, prNumber, repo: repo ?? "" });
  } catch {
    /* DB not opened */
  }

  log.info({ sessionId, prNumber }, "auto-correlated pr_lifecycle for session");
  saveInterests();
  setLastRegisterAt(new Date().toISOString());
  setDegradedEmittedAt(null);
  persistBrokerState();
}

export function handleAgentCheckout(event) {
  // CTL-360: read the payload shape-agnostically (see handleAgentCheckin).
  const d = getEventPayload(event);
  const sessionId = d.session_id;
  if (!sessionId) return;

  const finalStatus = d.status ?? "done";
  const reason = d.reason ?? null;

  try {
    markAgentDone(sessionId, finalStatus, reason);
  } catch {
    /* DB not opened */
  }

  // Deregister auto-derived pr_lifecycle interest so the watchdog doesn't
  // fire stale wakes after the agent exits. CTL-447: also clean up
  // phase_lifecycle interests registered with this session_id — orchestrators
  // subscribe per phase under their own session and must not leak after exit.
  const reg = interests.get(sessionId);
  if (reg && (reg.interest_type === "pr_lifecycle" || reg.interest_type === "phase_lifecycle")) {
    interests.delete(sessionId);
    if (reg.interest_type === "pr_lifecycle") {
      try {
        deleteFilterState(sessionId);
      } catch {
        /* DB not opened */
      }
    }
    saveInterests();
    persistBrokerState();
  }

  log.info({ sessionId, status: finalStatus, reason }, "agent checked out");
}

export function handleAgentHeartbeat(event) {
  const sessionId =
    event.session ??
    event.worker ??
    event.orchestrator ??
    event.attributes?.["catalyst.session.id"];
  if (!sessionId) return;
  const existing = lastHeartbeat.get(sessionId);
  lastHeartbeat.set(sessionId, { ts: Date.now(), notified: existing?.notified ?? false });
  const orchId = event.orchestrator ?? event.attributes?.["catalyst.orchestrator.id"];
  if (orchId && sessionId !== orchId) {
    workerToOrchestrator.set(sessionId, orchId);
  }
}

// CTL-403: handle worker.waiting — record that a session is blocking in a wait
// loop. Resets the watchdog timer and stores full detail so the watchdog can
// skip stale-heartbeat wakes while the session is legitimately waiting.
export function handleWorkerWaiting(event) {
  const d = event.detail ?? {};
  const sessionId = d.session_id;
  if (!sessionId) return;

  const timeoutMs = typeof d.timeout_ms === "number" ? d.timeout_ms : 0;
  const since = d.since ?? new Date().toISOString();
  const timeoutAt = new Date(new Date(since).getTime() + timeoutMs).getTime();

  waitingSessions.set(sessionId, {
    timeoutAt,
    waitFor: d.wait_for ?? null,
    ticket: d.ticket ?? null,
    orchestrator: d.orchestrator ?? event.orchestrator ?? null,
    reason: d.reason ?? null,
  });

  // Reset watchdog so the session doesn't immediately appear stale.
  const existing = lastHeartbeat.get(sessionId);
  lastHeartbeat.set(sessionId, { ts: Date.now(), notified: existing?.notified ?? false });

  try {
    upsertWaitingSession({
      sessionId,
      orchestrator: d.orchestrator ?? event.orchestrator ?? null,
      ticket: d.ticket ?? null,
      waitFor: d.wait_for ?? null,
      timeoutMs,
      since,
      reason: d.reason ?? null,
    });
  } catch {
    /* DB not opened */
  }

  log.info({ sessionId, waitFor: d.wait_for, timeoutMs }, "worker waiting");
  persistBrokerState();
}

// CTL-403: handle worker.resumed — clear the waiting record so the watchdog
// resumes normal heartbeat-staleness tracking for this session.
export function handleWorkerResumed(event) {
  const d = event.detail ?? {};
  const sessionId = d.session_id;
  if (!sessionId) return;

  waitingSessions.delete(sessionId);

  try {
    clearWaitingSession(sessionId);
  } catch {
    /* DB not opened */
  }

  log.info({ sessionId, outcome: d.outcome ?? "unknown" }, "worker resumed");
  persistBrokerState();
}

// CTL-405: handle orchestrator.status — record the orchestrator's self-reported
// phase so the HUD / operator can see what it's doing between waves, and treat
// the event as a liveness heartbeat so the watchdog does not fire stale wakes
// for an orchestrator that is actively monitoring but not emitting heartbeats.
export function handleOrchestratorStatus(event) {
  const d = getEventPayload(event);
  const orchId = d.orchestrator ?? getEventOrchestrator(event);
  if (!orchId) return;

  const entry = {
    phase: d.phase ?? null,
    wave: d.wave ?? null,
    activeWorkers: d.active_workers ?? null,
    totalWorkers: d.total_workers ?? null,
    summary: d.summary ?? null,
    ts: event.ts ?? new Date().toISOString(),
    sessionId: d.session_id ?? null,
  };

  orchestratorStatusMap.set(orchId, entry);

  // Treat status event as a heartbeat so the watchdog skips stale-session wakes
  // for the orchestrator while it is in a monitoring loop.
  const sessionId = entry.sessionId;
  if (sessionId) {
    const existing = lastHeartbeat.get(sessionId);
    lastHeartbeat.set(sessionId, { ts: Date.now(), notified: existing?.notified ?? false });
  }

  log.info(
    { orchId, phase: entry.phase, wave: entry.wave, activeWorkers: entry.activeWorkers },
    "orchestrator status"
  );
  persistBrokerState();
}

// CTL-507: replay-only freshness check. Live status events are always fresh;
// this guards only loadExistingRegistrations(). Missing/unparseable ts → stale
// (cannot verify age — conservative; matches pre-fix empty-state behavior).
export function isOrchestratorStatusFresh(event, nowMs = Date.now()) {
  const tsMs = Date.parse(event?.ts ?? "");
  if (Number.isNaN(tsMs)) return false;
  return nowMs - tsMs <= ORCH_STATUS_REPLAY_STALE_MS;
}

// --- Deterministic routing: pr_lifecycle (CTL-284) ---------------------------

function botPrefix(author, kind) {
  const isBot = author?.type === "Bot";
  if (kind === "review") return isBot ? "Automated review comment from " : "Changes requested by ";
  if (kind === "comment")
    return isBot ? "Automated review comment from " : "New review comment from ";
  return "";
}

// CTL-357: default `types_of_interest` for comms_lifecycle subscribers.
// Orchestrators only care about attention/done by default (no info-heartbeat
// firehose). Workers default to all types — orchestrator→worker traffic is
// rare and intentional, so we never want to silently drop it.
const COMMS_DEFAULT_TYPES_BY_KIND = {
  orchestrator: ["attention", "done"],
  worker: null,
};

function matchCommsLifecycle(reg, event) {
  if (getEventName(event) !== "comms.message.posted") return null;
  const payload = getEventPayload(event);
  if (!payload || typeof payload !== "object") return null;
  if (payload.channel !== reg.channel) return null;

  const allowedTypes = reg.types_of_interest ?? COMMS_DEFAULT_TYPES_BY_KIND[reg.subscriber_kind];
  if (Array.isArray(allowedTypes) && !allowedTypes.includes(payload.type)) return null;

  const sender = event.attributes?.["catalyst.worker.ticket"] ?? payload.from ?? null;

  if (reg.subscriber_kind === "orchestrator") {
    if (!Array.isArray(reg.owned_workers) || !reg.owned_workers.includes(sender)) return null;
    return `Worker ${sender} posted ${payload.type} on ${payload.channel}`;
  }

  if (reg.subscriber_kind === "worker") {
    if (sender && sender === reg.subscriber_ticket) return null; // self-loop guard
    const to = payload.to;
    if (to !== reg.subscriber_ticket && to !== "all") return null;
    return `Message to ${reg.subscriber_ticket} (${payload.type}) on ${payload.channel} from ${sender ?? "unknown"}`;
  }

  return null;
}

export function tryDeterministicRoute(event, interestsMap) {
  const matches = [];
  // CTL-359: read event name + payload via the canonical-aware helpers so
  // canonical OTel envelopes (where the name lives under
  // attributes["event.name"] and the payload under body.payload) match the
  // same routing rules as legacy flat events. Mirrors the CTL-357 fix to
  // tryTicketLifecycleRoute. CTL-354's canonical-envelope audit caught the
  // matching gap in tryTicketLifecycleRoute; this catches the PR/comms route.
  const name = getEventName(event);
  const detail = getEventPayload(event);
  // CTL-381: canonical-aware — resolves PR/ref/sha/environment from
  // `attributes` on true-canonical OTel envelopes that carry no top-level
  // `scope`, while still reading legacy `event.scope` when present.
  const scope = getEventScope(event);
  // CTL-344: real id on new envelopes, synthetic id for legacy events.
  const eventId = event.id ?? synthesizeEventId(event);

  let deployMatchedInterest = null;
  if (name === "github.deployment.created") {
    try {
      deployMatchedInterest = setFilterStateDeploying(
        scope.sha,
        detail.deploymentId,
        scope.environment
      );
    } catch {
      /* DB not opened */
    }
  } else if (name === "github.deployment_status.success") {
    try {
      deployMatchedInterest = setFilterStateDeployed(detail.deploymentId);
    } catch {
      /* DB not opened */
    }
  } else if (
    name === "github.deployment_status.failure" ||
    name === "github.deployment_status.error"
  ) {
    try {
      deployMatchedInterest = setFilterStateFailed(detail.deploymentId);
    } catch {
      /* DB not opened */
    }
  }

  for (const [interestId, reg] of interestsMap) {
    // CTL-357: comms_lifecycle is also deterministic — handled in this same
    // routing pass so a single `tryDeterministicRoute` call covers both kinds.
    if (reg.interest_type === "comms_lifecycle") {
      const reason = matchCommsLifecycle(reg, event);
      if (reason) {
        matches.push({
          interestId,
          reason,
          sourceEventId: eventId,
          sourceEvent: summarizeEvent(event),
        });
      }
      continue;
    }

    if (reg.interest_type !== "pr_lifecycle") continue;

    let reason = null;
    // CTL-407: dimension key + value for state-change suppression. null = always emit.
    let wakeStateKey = null;
    let wakeStateValue = null;
    const prList = reg.pr_numbers ?? [];

    if (name === "github.check_suite.completed") {
      const eventPrs = Array.isArray(detail.prNumbers) ? detail.prNumbers : [];
      const matchedPr = eventPrs.find((n) => prList.includes(n));
      if (matchedPr !== undefined && detail.conclusion != null) {
        const isFailing =
          detail.conclusion === "failure" ||
          detail.conclusion === "timed_out" ||
          detail.conclusion === "action_required";
        if (isFailing) {
          reason = `CI failing on PR #${matchedPr} — check_suite conclusion: ${detail.conclusion}`;
        } else {
          reason = `All CI checks passing on PR #${matchedPr} — conclusion: ${detail.conclusion}`;
        }
        wakeStateKey = `ci_conclusion:${matchedPr}`;
        wakeStateValue = detail.conclusion;
      }
    } else if (name === "github.pr.merged") {
      if (prList.includes(scope.pr)) {
        const sha = detail.mergeCommitSha ?? "unknown";
        reason = `PR #${scope.pr} merged (merge commit: ${sha}). Now waiting for deployment — do not close out until deployment succeeds.`;
        if (detail.mergeCommitSha) {
          try {
            setFilterStateMerged(interestId, detail.mergeCommitSha);
          } catch {
            /* DB not opened */
          }
        }
      }
    } else if (name === "github.pr.closed") {
      if (prList.includes(scope.pr) && detail.merged === false) {
        reason = `PR #${scope.pr} closed without merging`;
      }
    } else if (name === "github.pr_review.submitted") {
      if (prList.includes(scope.pr)) {
        const reviewer = detail.reviewer ?? "unknown";
        const isBot = detail.author?.type === "Bot";
        if (detail.state === "changes_requested") {
          if (isBot) {
            reason = `Automated review comment from ${reviewer} (bot): Changes requested on PR #${scope.pr}. PR is blocked from merging until review comments are resolved.`;
          } else {
            reason = `Changes requested by ${reviewer} on PR #${scope.pr}. PR is blocked from merging until review comments are resolved.`;
          }
        } else if (detail.state === "approved") {
          const tag = isBot ? " (bot)" : "";
          reason = `PR #${scope.pr} approved by ${reviewer}${tag}`;
        }
      }
    } else if (name === "github.pr_review_comment.created") {
      if (prList.includes(scope.pr)) {
        const author = detail.author?.login ?? "unknown";
        const isBot = detail.author?.type === "Bot";
        const prefix = botPrefix(detail.author, "comment");
        const tag = isBot ? " (bot)" : "";
        reason = `${prefix}${author}${tag} (comment ID: ${detail.commentId}): "${detail.body}". Comment must be marked resolved before merging. URL: ${detail.htmlUrl}`;
      }
    } else if (name === "github.pr_review_thread.resolved") {
      if (prList.includes(scope.pr)) {
        reason = `Review thread ${detail.threadId} resolved on PR #${scope.pr}`;
      }
    } else if (name === "github.deployment.created") {
      if (deployMatchedInterest && deployMatchedInterest.interestId === interestId) {
        reason = `Deployment started for merge commit ${scope.sha} on environment ${scope.environment}`;
      }
    } else if (name === "github.deployment_status.success") {
      if (deployMatchedInterest && deployMatchedInterest.interestId === interestId) {
        reason = `Deployment succeeded on ${scope.environment}. Work is complete.`;
      }
    } else if (
      name === "github.deployment_status.failure" ||
      name === "github.deployment_status.error"
    ) {
      if (deployMatchedInterest && deployMatchedInterest.interestId === interestId) {
        const url = detail.targetUrl ?? "(no target URL)";
        reason = `Deployment failed on ${scope.environment}. URL: ${url}`;
      }
    } else if (name === "github.push") {
      const ref = scope.ref ?? "";
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
      const matchedBase = (reg.base_branches ?? []).find((b) => b.base === branch);
      if (matchedBase) {
        reason = `Base branch ${branch} updated — PR #${matchedBase.pr} is now behind. Rebase may be needed.`;
      }
    }

    if (reason) {
      matches.push({
        interestId,
        reason,
        sourceEventId: eventId,
        sourceEvent: summarizeEvent(event),
        wakeStateKey,
        wakeStateValue,
      });
    }
  }

  return matches;
}

// --- Deterministic routing: ticket_lifecycle (CTL-303) -----------------------
//
// Handles Linear webhook events and GitHub PR events that carry ticket links.
// No Groq round-trip for known event shapes.
//
// ticket_lifecycle interest schema (registered via filter.register):
//   tickets:  string[]      — ticket identifiers to watch (e.g. ["CTL-275"])
//   wake_on:  string[]|null — event kinds to fire on; null = all
//     Values: pr_opened, pr_merged, status_done, status_in_review,
//             status_changed, comment_added

const TICKET_LIFECYCLE_ALL_WAKE_ON = [
  "pr_opened",
  "pr_merged",
  "status_done",
  "status_in_review",
  "status_changed",
  "comment_added",
];

// CTL-923 (BFF11): held-indicator labels, the same literals the scheduler
// applies (execution-core/scheduler.mjs HELD_LABEL_BLOCKED / HELD_LABEL_WAITING)
// and the board reads (orch-monitor/lib/board-data.mjs heldFor). When either
// label enters a ticket's set the broker stamps held_since so the read-model can
// render a real hold duration from the durable cache. Copied (not imported) so
// the lightweight broker fold takes no scheduler/board dependency — kept in
// lock-step by the unit test that asserts these match board-data's literals.
const HELD_LABELS = ["blocked", "waiting"];
const isHeld = (labels) =>
  Array.isArray(labels) && labels.some((l) => HELD_LABELS.includes(l));

// foldLinearIssueDescriptor — CTL-822 (Gateway L1 child b): write-through of
// every linear.issue.* event into the durable descriptor store (CTL-821).
// KEY-PRESENCE semantics deliberately: a webhook's issue data is a full
// snapshot, so toAssigneeId:null means UNASSIGNED (clear), and toLabels []
// means explicitly-empty while null means "labels absent from payload"
// (unknown → keep). Every non-remove issue event proves existence, so it also
// clears any stale removed flag (Linear unarchive arrives as `update`).
// `remove` payloads carry ONLY the entityId UUID → resolve via the CTL-821
// UUID→identifier index; an unresolvable remove with no identifier is left
// for the reconcile backstop (child e).
function foldLinearIssueDescriptor(name, detail, eventTicket) {
  if (typeof name !== "string" || !name.startsWith("linear.issue.")) return;
  try {
    const uuid = detail.issueId ?? null;
    if (name === "linear.issue.removed") {
      if (uuid) {
        const hit = markTicketRemovedByUuid(uuid);
        if (!hit && eventTicket) {
          upsertTicketDescriptor({ ticket: eventTicket, uuid, removed: true });
        }
      } else if (eventTicket) {
        upsertTicketDescriptor({ ticket: eventTicket, removed: true });
      }
      return;
    }
    if (!eventTicket) return;
    const descriptor = { ticket: eventTicket, removed: false };
    if (detail.toState != null) descriptor.state = detail.toState;
    if (detail.toPriority !== undefined && detail.toPriority !== null) {
      descriptor.priority = detail.toPriority;
    }
    // CTL-957: project Linear estimate (numeric story points) into ticket_state
    // so the read-model can serve real points without a live API call.
    // KEY-PRESENCE: absent = keep stored value; explicit null = clear.
    if ("toEstimate" in detail) {
      const v = detail.toEstimate;
      descriptor.estimate = typeof v === "number" ? v : null;
    }
    if ("toAssigneeId" in detail) {
      const v = detail.toAssigneeId ?? null;
      // Linear sends partial issue payloads (data.assignee can be omitted on
      // an ASSIGNED issue), and the emitter always includes the key. So a
      // null only CLEARS when the unassignment is evidenced: an assignee
      // change topic/updatedFrom, or a create (born unassigned). Otherwise
      // null is "unknown" → keep. Non-null always sets.
      const changeEvidenced =
        v !== null ||
        name === "linear.issue.assignee_changed" ||
        detail.action === "create" ||
        (Array.isArray(detail.updatedFromKeys) && detail.updatedFromKeys.includes("assigneeId"));
      if (changeEvidenced) descriptor.assignee = v;
    }
    if (detail.toLabels != null) descriptor.labels = detail.toLabels;
    if (uuid) descriptor.uuid = uuid;
    upsertTicketDescriptor(descriptor);

    // CTL-923 (BFF11): held_since capture. The label-set snapshot drives the
    // held-duration clock — when blocked/waiting enters the set we stamp the
    // applied-at (sticky: first hold start survives), when it leaves we clear.
    // `detail.heldSince` lets an emitter thread an exact applied-at; otherwise
    // setTicketHeldSince falls back to now (first observation). A null toLabels
    // (labels absent from the payload) is "unknown" → leave held_since alone.
    if (detail.toLabels != null) {
      if (isHeld(detail.toLabels)) {
        setTicketHeldSince(eventTicket, detail.heldSince ?? null);
      } else {
        clearTicketHeldSince(eventTicket);
      }
    }

    // CTL-923 (BFF11): fence projection. cluster-claim.mjs records the
    // catalyst://fence/<TICKET> attachment (owner_host/catalyst_generation/
    // phase/claimed_at); when an event carries that metadata under `toFence`
    // (key-presence, same convention as toLabels/toState) we project it into
    // ticket_state so the read-model groups by node from the durable cache
    // rather than a forbidden live attachment fetch. Key-presence: prefer the
    // `toFence` key when present (even an explicit null, which CLEARS), else the
    // `fence` alias; absent from both → undefined → leave the projection alone.
    const fence = "toFence" in detail ? detail.toFence : detail.fence;
    foldFenceMetadata(eventTicket, fence);
  } catch {
    /* DB not opened, or a UNIQUE-uuid violation from a buggy upstream — the
       routing path must never die on a descriptor write */
  }
}

// foldFenceMetadata — project a fence-attachment metadata object (the shape
// cluster-claim.mjs::parseClaimMetadata produces: owner_host, generation, phase,
// claimed_at) into ticket_state. Accepts both the wire key (catalyst_generation)
// and the parsed key (generation). A null `fence` clears the projection (a
// release/takeover that drops the owner); undefined leaves it untouched.
function foldFenceMetadata(ticket, fence) {
  if (!ticket || fence === undefined) return;
  if (fence === null) {
    upsertTicketFence({
      ticket,
      ownerHost: null,
      generation: null,
      phase: null,
      claimedAt: null,
    });
    return;
  }
  if (typeof fence !== "object") return;
  const genRaw = fence.generation ?? fence.catalyst_generation;
  const generation = genRaw == null ? null : Number(genRaw);
  upsertTicketFence({
    ticket,
    ownerHost: fence.owner_host ?? fence.ownerHost ?? null,
    generation: Number.isFinite(generation) ? generation : null,
    phase: fence.phase ?? null,
    claimedAt: fence.claimed_at ?? fence.claimedAt ?? null,
  });
}

export function tryTicketLifecycleRoute(event, interestsMap) {
  const matches = [];
  // CTL-357: read event name + payload via the canonical-aware helpers so
  // canonical OTel envelopes (where the name lives under
  // attributes["event.name"] and the payload under body.payload) match the
  // same routing rules as legacy flat events. CTL-354 caught this gap.
  const name = getEventName(event);
  const detail = getEventPayload(event);
  const scope = event.scope ?? {};
  const attrs = event.attributes ?? {};
  // CTL-344: real id on new envelopes, synthetic id for legacy events.
  const eventId = event.id ?? synthesizeEventId(event);

  // Extract the ticket this event concerns. Linear canonical events carry
  // `attributes["linear.issue.identifier"]`; legacy/flat events use `detail.ticket`.
  const eventTicket =
    attrs["linear.issue.identifier"] ?? detail.ticket ?? detail.identifier ?? null;

  // For GitHub PR events extract ticket refs from PR body / title / branch ref.
  let prBodyTickets = [];
  if (name === "github.pr.merged" || name === "github.pr.opened" || name === "github.pr.closed") {
    const bodyText = [detail.body ?? "", detail.title ?? "", detail.headRef ?? ""].join(" ");
    const found = bodyText.match(/\b([A-Z]{1,10}-\d+)\b/g) ?? [];
    prBodyTickets = [...new Set(found)];
  }

  // Side effect: update ticket_state for known state-change events.
  if (name === "linear.issue.state_changed" && eventTicket) {
    const newState = detail.toState ?? detail.state ?? detail.stateName ?? null;
    try {
      upsertTicketState({ ticket: eventTicket, linearState: newState });
    } catch {
      /* DB not opened */
    }
  }
  if ((name === "github.pr.opened" || name === "github.pr.merged") && prBodyTickets.length > 0) {
    const prNum = typeof scope.pr === "number" ? scope.pr : null;
    for (const t of prBodyTickets) {
      try {
        upsertTicketState({ ticket: t, prNumber: prNum });
      } catch {
        /* DB not opened */
      }
    }
  }

  for (const [interestId, reg] of interestsMap) {
    if (reg.interest_type !== "ticket_lifecycle") continue;

    const watchedTickets = reg.tickets ?? [];
    if (watchedTickets.length === 0) continue;

    const wakeOn = reg.wake_on ?? TICKET_LIFECYCLE_ALL_WAKE_ON;
    let reason = null;
    let matchedTicket = null;

    if (
      name === "linear.issue.state_changed" &&
      eventTicket &&
      watchedTickets.includes(eventTicket)
    ) {
      matchedTicket = eventTicket;
      const newState = detail.toState ?? detail.state ?? detail.stateName ?? "unknown";
      if (wakeOn.includes("status_done") && /done/i.test(newState)) {
        reason = `Ticket ${eventTicket} marked Done`;
      } else if (wakeOn.includes("status_in_review") && /in.?review/i.test(newState)) {
        reason = `Ticket ${eventTicket} moved to In Review`;
      } else if (wakeOn.includes("status_changed")) {
        reason = `Ticket ${eventTicket} state changed to ${newState}`;
      }
    } else if (
      name === "linear.issue.updated" &&
      eventTicket &&
      watchedTickets.includes(eventTicket)
    ) {
      if (wakeOn.includes("status_changed")) {
        matchedTicket = eventTicket;
        reason = `Ticket ${eventTicket} updated`;
      }
    } else if (
      name === "linear.comment.created" &&
      eventTicket &&
      watchedTickets.includes(eventTicket)
    ) {
      if (wakeOn.includes("comment_added")) {
        matchedTicket = eventTicket;
        const author = detail.author ?? attrs["linear.actor.id"] ?? "someone";
        reason = `New comment on ${eventTicket} by ${author}`;
      }
    } else if (name === "github.pr.opened") {
      const linked = prBodyTickets.find((t) => watchedTickets.includes(t));
      if (linked && wakeOn.includes("pr_opened")) {
        matchedTicket = linked;
        const pr = scope.pr ?? "?";
        reason = `PR #${pr} opened on ticket ${linked}`;
        // Auto-correlate: give agents watching this ticket a pr_lifecycle interest.
        if (typeof scope.pr === "number") {
          _autoPrLifecycleFromTicket(
            linked,
            scope.pr,
            interestsMap,
            attrs["vcs.repository.name"] ?? null
          );
        }
      }
    } else if (name === "github.pr.merged") {
      const linked = prBodyTickets.find((t) => watchedTickets.includes(t));
      if (linked && wakeOn.includes("pr_merged")) {
        matchedTicket = linked;
        const pr = scope.pr ?? "?";
        reason = `PR #${pr} on ticket ${linked} merged`;
      }
    }

    if (reason) {
      matches.push({
        interestId,
        reason,
        sourceEventId: eventId,
        sourceEvent: summarizeEvent(event),
        ticket: matchedTicket,
      });
    }
  }

  return matches;
}

// When a PR opens linked to a ticket, auto-register pr_lifecycle for any agent
// that checked in with that ticket but hasn't been linked to a PR yet, AND
// (CTL-341) append the new PR number to any orchestrator-level pr_lifecycle
// interest whose orchestrator matches one of those agents.
function _autoPrLifecycleFromTicket(ticket, prNumber, interestsMap, repo) {
  let agents = [];
  try {
    agents = getAgentsByTicket(ticket);
  } catch {
    return;
  }

  let changed = false;

  for (const agent of agents) {
    if (agent.claimedPr) continue;
    const sessionId = agent.sessionId;
    if (interestsMap.has(sessionId)) continue;

    interests.set(sessionId, {
      notify_event: `filter.wake.${sessionId}`,
      prompt: "",
      context: { pr_numbers: [prNumber], tickets: [ticket], workers: [sessionId] },
      orchestrator: agent.orchestrator ?? null,
      session_id: sessionId,
      persistent: true,
      interest_type: "pr_lifecycle",
      pr_numbers: [prNumber],
      repo: repo ?? null,
      base_branches: [],
      tickets: null,
      wake_on: null,
    });

    try {
      upsertFilterStateOpen({ interestId: sessionId, prNumber, repo: repo ?? "" });
    } catch {
      /* DB not opened */
    }

    log.info({ sessionId, ticket, prNumber }, "auto-correlated pr_lifecycle from ticket");
    changed = true;
  }

  // CTL-341: Also append the PR to any orchestrator-level pr_lifecycle interest
  // whose orchestrator owns at least one agent on this ticket. The orchestrator
  // registers its own pr_lifecycle interest at Phase 4 start, often before any
  // worker has opened a PR — so pr_numbers starts empty. Without this update,
  // the deterministic route in tryDeterministicRoute never matches incoming
  // PR/CI/review events for the new PR.
  const orchsForTicket = new Set(agents.map((a) => a.orchestrator).filter((o) => o != null));
  for (const [interestId, reg] of interestsMap) {
    if (reg.interest_type !== "pr_lifecycle") continue;
    if (reg.session_id !== null) continue; // worker-level — skip
    if (!orchsForTicket.has(reg.orchestrator)) continue;
    const prs = reg.pr_numbers ?? [];
    if (prs.includes(prNumber)) continue;
    reg.pr_numbers = [...prs, prNumber];
    try {
      upsertFilterStateOpen({ interestId, prNumber, repo: reg.repo ?? "" });
    } catch {
      /* DB not opened */
    }
    log.info(
      { interestId, ticket, prNumber, orchestrator: reg.orchestrator },
      "appended PR to orchestrator pr_lifecycle interest"
    );
    changed = true;
  }

  if (changed) {
    saveInterests();
    setLastRegisterAt(new Date().toISOString());
    setDegradedEmittedAt(null);
    persistBrokerState();
  }
}

// --- Deterministic routing: phase_lifecycle (CTL-447) -----------------------
//
// Wakes registered sessions on phase boundary events of the shape
//   phase.<name>.complete.<ticket>
//   phase.<name>.failed.<ticket>
//   phase.<name>.turn-cap-exhausted.<ticket>   (CTL-484)
//   phase.<name>.skipped.<ticket>              (CTL-512)
//
// where <name> matches one of the interest's phase_names and <ticket> matches
// the interest's ticket. Used by the phase-agent orchestrator to coordinate
// hand-off between short-lived phase agents (see plan §Initiative 1).
//
// PHASE_EVENT_PATTERN lives in namespace-contract.mjs (CTL-1142 single source of
// truth). Re-exported here to preserve the existing import surface for callers
// that import it from this module (CTL-484, CTL-512 comments live in the contract).
export const PHASE_EVENT_PATTERN = _PHASE_EVENT_PATTERN;

export function tryPhaseLifecycleRoute(event, interestsMap) {
  const matches = [];
  const name = getEventName(event);
  if (!name.startsWith("phase.")) return matches;
  const m = PHASE_EVENT_PATTERN.exec(name);
  if (!m) return matches;
  const [, phaseName, status, ticket] = m;
  const eventId = event.id ?? synthesizeEventId(event);

  for (const [interestId, reg] of interestsMap) {
    if (reg.interest_type !== "phase_lifecycle") continue;
    if (reg.ticket !== ticket) continue;
    const phases = Array.isArray(reg.phase_names) ? reg.phase_names : [];
    if (!phases.includes(phaseName)) continue;

    const reason =
      status === "complete"
        ? `Phase ${phaseName} complete on ${ticket}`
        : status === "turn-cap-exhausted"
          ? `Phase ${phaseName} turn-cap-exhausted on ${ticket}`
          : status === "skipped"
            ? `Phase ${phaseName} skipped on ${ticket}`
            : `Phase ${phaseName} failed on ${ticket}`;
    matches.push({
      interestId,
      reason,
      sourceEventId: eventId,
      sourceEvent: summarizeEvent(event),
      ticket,
    });
  }

  return matches;
}

// CTL-753: workflow substep lifecycle route — informational only, no pipeline advancement.
const WORKFLOW_SUBSTEP_PATTERN =
  /^workflow\.substep\.(started|complete|failed)\.([A-Za-z][A-Za-z0-9_]*-\d+)$/;

export function tryWorkflowSubstepRoute(event, interestsMap) {
  const matches = [];
  const name = getEventName(event);
  if (!name.startsWith("workflow.substep.")) return matches;
  const m = WORKFLOW_SUBSTEP_PATTERN.exec(name);
  if (!m) return matches;
  const [, status, ticket] = m;
  const eventId = event.id ?? synthesizeEventId(event);

  for (const [interestId, reg] of interestsMap) {
    if (reg.interest_type !== "workflow_substep_lifecycle") continue;
    if (reg.ticket !== ticket) continue;
    matches.push({
      interestId,
      reason: `Workflow substep ${status} on ${ticket}`,
      sourceEventId: eventId,
      sourceEvent: summarizeEvent(event),
      ticket,
    });
  }
  return matches;
}

// --- Event classification ---

// CTL-346: skip events the broker itself emitted so we never re-ingest
// our own filter.wake.*/broker.daemon.* output (the 2026-05-12 wake feedback
// loop). The original `event.event` read missed canonical OTel envelopes
// where the name lives at attributes["event.name"]; the new check uses
// getEventName + a service.name guard that catches every broker emission.
// Opt out via BROKER_INGEST_OWN_EMISSIONS=1 for debugging.
export function shouldSkipEvent(event) {
  if (process.env.BROKER_INGEST_OWN_EMISSIONS === "1") {
    return getEventName(event).startsWith("filter.");
  }
  if (event.resource?.["service.name"] === "catalyst.broker") return true;
  const name = getEventName(event);
  if (FORBIDDEN_PREFIXES.some((p) => name.startsWith(p))) return true;
  // CTL-401: liveness pings — handled earlier in processEvent, skip here too
  // so they never reach the Groq queue even if the early-return path changes.
  if (PROTECTED_EXACT_NAMES.includes(name)) return true;
  return false;
}

export function buildGroqPrompt(events) {
  if (!interests.size) return null;

  // Deterministic-routed interest types are excluded from the Groq prompt.
  const proseInterests = [...interests.entries()].filter(
    ([, reg]) => !DETERMINISTIC_INTEREST_TYPES.has(reg.interest_type)
  );
  if (proseInterests.length === 0) return null;

  const interestLines = proseInterests
    .map(([id, reg]) => {
      const ctx = reg.context ? ` (context: ${JSON.stringify(reg.context)})` : "";
      return `- ${id}: "${reg.prompt}"${ctx}`;
    })
    .join("\n");

  const eventLines = events.map((e, i) => `${i + 1}. ${JSON.stringify(e)}`).join("\n");

  const systemPrompt =
    "You are a semantic event router for a developer automation system. " +
    "Given a list of events and registered orchestrator interests, determine which events are relevant to which interests.\n\n" +
    "Respond with a JSON array of matches. Each element: " +
    '{"interest_id":"...","reason":"one sentence why","event_indices":[1,2,...]}.\n' +
    "Only include interests with at least one matching event. Return [] if nothing matches.\n" +
    "Return ONLY the JSON array, no other text.";

  const userPrompt = `Events:\n${eventLines}\n\nRegistered interests:\n${interestLines}`;

  return { systemPrompt, userPrompt };
}

export async function classifyBatch(events) {
  // CTL-357: env-gate the Groq prose path. Default is off; existing prose
  // interests on disk are accepted (for backward compat) but never matched
  // against events. Flip to "1" only when the per-interest prompt is known
  // to produce real signal, not the historical ~95% false-positive firehose.
  if (process.env.CATALYST_BROKER_PROSE_ENABLED !== "1") return;
  const prompts = buildGroqPrompt(events);
  if (!prompts) return;

  if (!GROQ_API_KEY) {
    log.error({ batchSize: events.length }, "GROQ_API_KEY not set — skipping batch");
    return;
  }

  let responseText;
  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        ...GROQ_EXTRA_HEADERS,
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: prompts.systemPrompt },
          { role: "user", content: prompts.userPrompt },
        ],
        temperature: 0,
        max_tokens: 512,
      }),
    });
    if (!res.ok) {
      log.error({ status: res.status, body: await res.text() }, "Groq error");
      return;
    }
    const data = await res.json();
    responseText = data.choices?.[0]?.message?.content ?? "[]";
  } catch (err) {
    log.error({ err: err.message }, "Groq fetch failed");
    return;
  }

  let matches;
  try {
    matches = JSON.parse(responseText);
  } catch {
    log.error({ responseText }, "failed to parse Groq response");
    return;
  }

  const { wakes, oneShotsToDelete } = classifyMatches(events, matches, interests);
  for (const wake of wakes) {
    appendEvent(wake);
    log.info({ notifyEvent: wake.event, reason: wake.detail.reason }, "wake");
  }
  if (wakes.length > 0) {
    setLastWakeAt(new Date().toISOString());
    persistBrokerState();
  }
  for (const id of oneShotsToDelete) {
    interests.delete(id);
    log.info({ interestId: id }, "auto-deregistered (one-shot)");
  }
  if (oneShotsToDelete.length > 0) {
    saveInterests();
    persistBrokerState();
  }
}

/**
 * Pure prose-match classifier (CTL-340). Given a batch of events, the raw
 * Groq match array, and the interests map, returns the wakes that should be
 * appended and the one-shot interest ids that should be deleted.
 *
 * Gating change vs. pre-CTL-340: the suppression guard now triggers when
 * Groq's own `event_indices` is empty, not when post-filter id extraction
 * produced an empty array. Indices pointing past the batch end are still
 * dropped from `source_event_ids`, but `matched_indices_count` preserves
 * what Groq intended for observability.
 */
export function classifyMatches(events, matches, interestsMap) {
  const wakes = [];
  const oneShotsToDelete = [];
  if (!Array.isArray(matches)) return { wakes, oneShotsToDelete };

  for (const match of matches) {
    const reg = interestsMap.get(match.interest_id);
    if (!reg) continue;

    const indices = match.event_indices ?? [];
    if (indices.length === 0) {
      // Groq returned a match without any event references — keep the
      // original bug-catching suppression. Don't log; it fired 779×/hr in
      // production pre-fix and drowned out real failures.
      continue;
    }

    // CTL-344: prefer real event.id; fall back to synthesized id for legacy
    // events. .filter(Boolean) strips any indices pointing past the batch end.
    // CTL-350: also build a parallel source_events array with structured
    // metadata so receivers don't need to re-fetch from GitHub/Linear/git.
    const sourceEvents = indices
      .map((i) => events[i - 1])
      .filter(Boolean)
      .map((e) => summarizeEvent(e));
    const sourceIds = sourceEvents.map((s) => s.id);

    wakes.push({
      event: reg.notify_event,
      orchestrator: reg.orchestrator ?? match.interest_id,
      worker: null,
      // CTL-362: forward the interest's repo so the wake envelope carries
      // vcs.repository.name when the interest tracks a specific repo (today
      // only pr_lifecycle interests do).
      repo: reg.repo ?? null,
      detail: {
        reason: match.reason,
        source_event_ids: sourceIds,
        source_events: sourceEvents,
        matched_indices_count: indices.length,
        interest_id: match.interest_id,
      },
    });

    if (!reg.persistent) oneShotsToDelete.push(match.interest_id);
  }

  return { wakes, oneShotsToDelete };
}

// --- Debounce ---
let pendingBatch = [];
let debounceTimer = null;
let hardCapTimer = null;

export function __getPendingBatchForTest() {
  return [...pendingBatch];
}
export function __clearPendingBatchForTest() {
  clearTimeout(debounceTimer);
  clearTimeout(hardCapTimer);
  debounceTimer = null;
  hardCapTimer = null;
  pendingBatch.splice(0);
}

async function flushBatch() {
  clearTimeout(debounceTimer);
  clearTimeout(hardCapTimer);
  debounceTimer = null;
  hardCapTimer = null;
  const batch = pendingBatch.splice(0);
  if (batch.length) await classifyBatch(batch);
}

function scheduleBatchFlush() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushBatch, DEBOUNCE_MS);
  if (!hardCapTimer) {
    hardCapTimer = setTimeout(flushBatch, HARD_CAP_MS);
  }
}

function queueEvent(event) {
  pendingBatch.push(event);
  if (pendingBatch.length >= MAX_BATCH_SIZE) {
    flushBatch();
  } else {
    scheduleBatchFlush();
  }
}

// --- Heartbeat watchdog ---

// CTL-672: `liveness(sourceId)` returns "alive" | "dead" | "unknown" from the
// `claude agents` source of truth (via the catalyst.db sess_→UUID bridge),
// shared through the TTL cache so all tracked sessions in one tick collapse to a
// single `claude agents` invocation. Injectable for tests. "unknown" (a session
// not yet resolvable to a claude UUID — e.g. interactive sessions) falls back to
// the legacy heartbeat-ts staleness below, so behavior is unchanged for those.
export function runWatchdogTick({ liveness = sessionLiveness } = {}) {
  const now = Date.now();

  // CTL-352: empty-interests observability. Warn on every tick when the table
  // is empty so a silently-dead broker is loud in broker.log, and emit a
  // one-shot broker.daemon.degraded event after the 5-minute startup grace so
  // downstream consumers (HUD, alerts) can pair startup ↔ degraded.
  if (interests.size === 0) {
    const brokerStartedAt = getBrokerStartedAt();
    const startedTs = brokerStartedAt ? new Date(brokerStartedAt).getTime() : now;
    const uptimeMs = now - startedTs;
    log.warn({ uptimeMs }, "watchdog: no registered interests");
    if (uptimeMs > DEGRADED_THRESHOLD_MS && getDegradedEmittedAt() === null) {
      appendEvent({
        event: "broker.daemon.degraded",
        orchestrator: null,
        worker: null,
        severity: "WARN",
        detail: {
          reason: "no registered interests",
          uptimeMs,
          brokerStartedAt,
        },
      });
      setDegradedEmittedAt(new Date().toISOString());
      persistBrokerState();
    }
  } else if (getDegradedEmittedAt() !== null) {
    setDegradedEmittedAt(null);
  }

  // CTL-1122: judge each ingestion source's liveness from its event recency —
  // the surviving-process observation the 11h silent outage proved we were
  // missing. PR1 = monitor heartbeat; PR2 = activity-gated github webhooks.
  for (const source of RECENCY_SOURCES) checkSourceRecency(source, now);

  let watchdogWoke = false;

  // CTL-419: collect all currently-stale not-yet-notified sessions first.
  // Then iterate interests (outer) and batch all matching stale sessions into
  // a single appendEvent call per interest — avoids N identical wake rows in
  // the HUD when N sessions go stale simultaneously.
  const staleNow = new Map(); // sourceId → { ts, minsAgo }
  for (const [sourceId, state] of lastHeartbeat) {
    // CTL-672: prefer the `claude agents` truth (resolved via the catalyst.db
    // sess_→UUID bridge); fall back to heartbeat-ts staleness only when the
    // session isn't yet resolvable to a claude UUID ("unknown").
    const liv = liveness(sourceId);
    const stale =
      liv === "dead" ? true : liv === "alive" ? false : now - state.ts > HEARTBEAT_STALE_MS;
    // CTL-403: skip stale-wake if this session has an active wait whose timeout
    // has not yet elapsed. The session is legitimately blocking — not dead.
    if (stale && waitingSessions.has(sourceId)) {
      const ws = waitingSessions.get(sourceId);
      if (ws.timeoutAt > now) {
        const secsLeft = Math.round((ws.timeoutAt - now) / 1000);
        log.debug(
          { sourceId, secsLeft, waitFor: ws.waitFor },
          "watchdog: skipping stale check — session is legitimately waiting"
        );
        continue;
      }
      // Wait timed out — treat as stale and clean up the waiting record.
      waitingSessions.delete(sourceId);
      try {
        clearWaitingSession(sourceId);
      } catch {
        /* DB not opened */
      }
    }
    if (stale && !state.notified) {
      const minsAgo = Math.round((now - state.ts) / 60_000);
      staleNow.set(sourceId, { ts: state.ts, minsAgo });
    } else if (!stale && state.notified) {
      lastHeartbeat.set(sourceId, { ts: state.ts, notified: false });
    }
  }

  // Track which sessions were actually woken so we can mark + clean up after.
  const notifiedSessions = new Set();

  for (const [interestId, interest] of interests) {
    const matched = []; // { sourceId, ts, minsAgo }
    for (const [sourceId, info] of staleNow) {
      const workers = interest.context?.workers;
      const orchForSource = workerToOrchestrator.get(sourceId);
      const orchMatch = orchForSource != null && orchForSource === interest.orchestrator;
      if ((workers != null && workers.includes(sourceId)) || (workers == null && orchMatch)) {
        matched.push({ sourceId, ...info });
      }
    }
    if (matched.length === 0) continue;

    const isSingle = matched.length === 1;
    const singleId = matched[0].sourceId;
    const reason = isSingle
      ? `No heartbeat from ${singleId} for >${matched[0].minsAgo} min`
      : `${matched.length} sessions stale`;

    appendEvent({
      event: interest.notify_event,
      orchestrator: interest.orchestrator ?? interestId,
      worker: null,
      // CTL-362: forward the interest's repo so the watchdog wake
      // envelope carries vcs.repository.name when known.
      repo: interest.repo ?? null,
      // CTL-350: watchdog wakes have no triggering event, so source_events
      // is always empty — receivers should fall back to the reason/stale_sessions.
      // CTL-419: include stale_sessions[] and stale_count for HUD batched display.
      detail: {
        reason,
        stale_sessions: matched.map((m) => m.sourceId),
        stale_count: matched.length,
        source_event_ids: [],
        source_events: [],
        interest_id: interestId,
      },
    });
    log.info(
      { notifyEvent: interest.notify_event, staleSessions: matched.map((m) => m.sourceId) },
      "watchdog wake (batched)"
    );
    watchdogWoke = true;

    for (const { sourceId } of matched) {
      notifiedSessions.add(sourceId);
    }
  }

  // Mark notified sessions and clean up their own registered interests.
  // Done after the interests loop to avoid concurrent-modification issues.
  if (notifiedSessions.size > 0) {
    const toDelete = [];
    for (const [interestId, interest] of interests) {
      if (interest.session_id && notifiedSessions.has(interest.session_id)) {
        toDelete.push({ interestId, sourceId: interest.session_id });
      }
    }
    for (const { interestId, sourceId } of toDelete) {
      interests.delete(interestId);
      log.info({ interestId, sourceId }, "watchdog cleanup: removed stale session");
    }
    for (const sourceId of notifiedSessions) {
      const info = staleNow.get(sourceId);
      lastHeartbeat.set(sourceId, { ts: info.ts, notified: true });
    }
  }

  if (watchdogWoke) {
    setLastWakeAt(new Date().toISOString());
    persistBrokerState();
  }
}

export function startWatchdog() {
  return setInterval(runWatchdogTick, WATCHDOG_INTERVAL_MS);
}

// CTL-1161: periodic drift-check backstop. Mirrors startWatchdog — same
// pattern, same shutdown contract (caller clearIntervals the returned handle).
// The tickFn is wired here (where the private config accessors live) rather
// than in index.mjs so the private __REPO_CONFIG_PATH / __loadedCommit* state
// never leaks out of router.mjs.
export function startDriftCheckWatcher() {
  return startPluginDriftCheck({
    tickFn: () => {
      const results = refreshAllPluginCheckouts({
        repoConfigPath: __REPO_CONFIG_PATH,
        machineConfigPath: __machineConfigPath(),
        emitFn: appendEvent,
        loadedCommit: __loadedCommit(),
        loadedCommitRoot: __loadedCommitRoot(),
      });
      handleStackReloadEvent({
        results,
        loadedCommitRoot: __loadedCommitRoot(),
        emitFn: appendEvent,
        getByteOffsetFn: getLastByteOffset,
        logPath: getEventLogPath(),
      });
    },
  });
}

// --- Event processing ---
export function processEvent(event) {
  const name = getEventName(event);

  // CTL-1122: fold every event into the per-service last-seen map (recency for
  // the ingestion-silence detector). Non-consuming; runs ABOVE all gates so a
  // catalyst.monitor heartbeat is recorded even though no interest matches it.
  recordLastSeen(event);

  // CTL-532: fold every event into the worker-state projection (best-effort,
  // non-consuming — the projection is a side-channel observer and never
  // returns, so existing routing below is untouched).
  projectWorkerStateEvent(event);

  // CTL-993: on a merge-to-main of the configured repo, ff-only pull the
  // pluginDirs checkout so fixes go live within seconds. Non-consuming
  // side-channel like projectWorkerStateEvent — runs ABOVE the shouldSkipEvent /
  // interests.size gates because GitHub merge events arrive whether or not any
  // orchestration is active. handlePluginRefreshEvent never throws and the
  // events it emits carry resource["service.name"]=catalyst.broker, which
  // shouldSkipEvent drops on re-ingest (no self-wake loop).
  const __refreshResults = handlePluginRefreshEvent({
    event,
    repoFullName: __repoFullName(),
    machineConfigPath: __machineConfigPath(),
    repoConfigPath: __REPO_CONFIG_PATH,
    emitFn: appendEvent,
    loadedCommit: __loadedCommit(),
    loadedCommitRoot: __loadedCommitRoot(),
  });
  // CTL-1077: act on the refresh — reload the running stack when the checkout advanced.
  // logPath MUST be threaded through: the broker self-reload handoff records it so the
  // successor's resolveBootByteOffset can confirm it resumes the same month file. Omitting
  // it writes logPath:"" into the handoff, which never matches the real path on boot, so the
  // successor silently reseeds to EOF and drops events appended during the restart gap —
  // defeating the gap-free handoff entirely.
  //
  // CTL-1077 remediate (M5): pass getByteOffsetFn (the live accessor), not an
  // eagerly-evaluated currentByteOffset. The handoff is written ~30 s later when
  // the debounce fires; capturing the offset HERE at processEvent time would make
  // the successor resume from a low-water mark and re-process ~30 s of events
  // (double-firing non-idempotent handlers). The accessor is evaluated at
  // handoff-write time so the successor resumes from the true tail position.
  handleStackReloadEvent({
    results: __refreshResults,
    loadedCommitRoot: __loadedCommitRoot(),
    emitFn: appendEvent,
    getByteOffsetFn: getLastByteOffset,
    logPath: getEventLogPath(),
  });

  if (name === "filter.register") {
    handleRegister(event);
    return;
  }
  if (name === "filter.deregister") {
    handleDeregister(event);
    return;
  }

  // CTL-303: structured agent identity events.
  // CTL-381: also accept the orchestrator.-prefixed name that pre-fix
  // catalyst-state.sh wrote, so check-in events replayed on broker restart
  // during the rollout window still route to the right handler.
  if (name === "agent.checkin" || name === "orchestrator.agent.checkin") {
    handleAgentCheckin(event);
    return;
  }
  if (name === "agent.checkout" || name === "orchestrator.agent.checkout") {
    handleAgentCheckout(event);
    return;
  }
  if (name === "agent.heartbeat") {
    handleAgentHeartbeat(event);
    return;
  }
  // CTL-401: route canonical session.heartbeat to the same watchdog liveness
  // handler. The session ID lives in attributes["catalyst.session.id"] rather
  // than the top-level flat field; handleAgentHeartbeat now reads both shapes.
  if (name === "session.heartbeat") {
    handleAgentHeartbeat(event);
    return;
  }

  // CTL-403: worker wait-loop visibility events.
  if (name === "worker.waiting") {
    handleWorkerWaiting(event);
    return;
  }
  if (name === "worker.resumed") {
    handleWorkerResumed(event);
    return;
  }

  // CTL-405: orchestrator self-status events — liveness + phase visibility.
  if (name === "orchestrator.status") {
    handleOrchestratorStatus(event);
    return;
  }

  // CTL-483 Phase 1: project worker state mutations to a shadow file so the
  // verification cycle can confirm byte-for-byte agreement with direct writes.
  if (name === "worker.state_changed") {
    handleWorkerStateChanged(event);
    return;
  }

  if (shouldSkipEvent(event)) return;

  // CTL-822: durable descriptor write-through. MUST run for every
  // linear.issue.* event REGARDLESS of registered interests — webhooks arrive
  // whether or not any orchestration is active, and the descriptor store is
  // CTL-823's source of truth. Mirrors the projectWorkerStateEvent model
  // (folds live ABOVE the `if (!interests.size) return` gate; the verify
  // panel caught that placing this inside tryTicketLifecycleRoute silently
  // starved the store during idle periods).
  if (typeof name === "string" && name.startsWith("linear.issue.")) {
    const foldDetail = getEventPayload(event);
    const foldTicket =
      event.attributes?.["linear.issue.identifier"] ??
      foldDetail.ticket ??
      foldDetail.identifier ??
      null;
    foldLinearIssueDescriptor(name, foldDetail, foldTicket);
  }

  if (name === "heartbeat") {
    const sourceId = event.worker ?? event.session ?? event.orchestrator;
    if (sourceId) {
      const existing = lastHeartbeat.get(sourceId);
      lastHeartbeat.set(sourceId, { ts: Date.now(), notified: existing?.notified ?? false });
      const orchId = event.orchestrator;
      if (orchId && sourceId !== orchId) {
        workerToOrchestrator.set(sourceId, orchId);
      }
    }
    return;
  }

  if (name === "orchestrator-completed" || name === "orchestrator-failed") {
    handleOrchestratorTerminated(event);
  }

  if (!interests.size) return;

  // Deterministic short-circuit: pr_lifecycle (CTL-284), ticket_lifecycle (CTL-303),
  // phase_lifecycle (CTL-447).
  const prMatches = tryDeterministicRoute(event, interests);
  const ticketMatches = tryTicketLifecycleRoute(event, interests);
  const phaseMatches = tryPhaseLifecycleRoute(event, interests);
  const substepMatches = tryWorkflowSubstepRoute(event, interests);
  const directMatches = [...prMatches, ...ticketMatches, ...phaseMatches, ...substepMatches];

  for (const m of directMatches) {
    const reg = interests.get(m.interestId);
    if (!reg) continue;
    // CTL-406: skip duplicate (source_event_id, interest_id) pairs.
    if (shouldSkipWake(m.sourceEventId, m.interestId)) {
      log.debug(
        { interestId: m.interestId, sourceEventId: m.sourceEventId },
        "dedup: skipping duplicate wake"
      );
      continue;
    }

    // CTL-407: suppress wake when downstream state is unchanged from last emission.
    if (reg.suppress_identical_wakes && m.wakeStateKey !== null) {
      if (reg.last_wake_state[m.wakeStateKey] === m.wakeStateValue) {
        log.info(
          {
            notifyEvent: reg.notify_event,
            wakeStateKey: m.wakeStateKey,
            wakeStateValue: m.wakeStateValue,
          },
          "suppressed redundant wake (state unchanged)"
        );
        continue;
      }
      reg.last_wake_state[m.wakeStateKey] = m.wakeStateValue;
    }

    appendEvent({
      event: reg.notify_event,
      orchestrator: reg.orchestrator ?? m.interestId,
      worker: null,
      // CTL-362: forward the interest's repo so the wake envelope carries
      // vcs.repository.name.
      repo: reg.repo ?? null,
      detail: {
        reason: m.reason,
        source_event_ids: m.sourceEventId ? [m.sourceEventId] : [],
        source_events: m.sourceEvent ? [m.sourceEvent] : [],
        interest_id: m.interestId,
        ...(m.ticket ? { ticket: m.ticket } : {}),
      },
    });
    log.info({ notifyEvent: reg.notify_event, reason: m.reason }, "direct wake");
    if (!reg.persistent) {
      interests.delete(m.interestId);
      if (reg.interest_type === "pr_lifecycle") {
        try {
          deleteFilterState(m.interestId);
        } catch {
          /* DB not opened */
        }
      }
      saveInterests();
      log.info({ interestId: m.interestId }, "auto-deregistered (one-shot)");
    }
  }

  if (directMatches.length > 0) {
    setLastWakeAt(new Date().toISOString());
    persistBrokerState();
    return;
  }

  // CTL-397: comms.message.posted is handled deterministically via comms_lifecycle
  // interests. If no deterministic match fired (types_of_interest filtered it out,
  // sender not in owned_workers, etc.), drop the event rather than passing it to
  // the Groq queue — info-type phase-narration heartbeats would otherwise generate
  // spurious filter.wake events when prose interests are present.
  if (getEventName(event) === "comms.message.posted") return;

  queueEvent(event);
}

// --- worker.state_changed handler (CTL-483 / CTL-529) ---
// Stays with the other event handlers; getProjectedWorkerStatePath +
// writeProjectedWorkerState come from projection.mjs via the existing
// router -> projection import edge.
export function handleWorkerStateChanged(event) {
  const payload = getEventPayload(event);
  const orchestrator = getEventOrchestrator(event);
  const ticket = event.attributes?.["catalyst.worker.ticket"] ?? payload.ticket;
  if (!orchestrator || !ticket) {
    log.warn(
      { orchestrator, ticket },
      "worker.state_changed missing orchestrator/ticket — dropping"
    );
    return;
  }
  const state = payload.state;
  if (!state || typeof state !== "object") {
    log.warn(
      { orchestrator, ticket },
      "worker.state_changed missing body.payload.state — dropping"
    );
    return;
  }
  const target = getProjectedWorkerStatePath(orchestrator, ticket);
  writeProjectedWorkerState(target, state, {
    writer: event.attributes?.["catalyst.writer"] ?? payload.writer ?? "unknown",
    ts: event.ts ?? event.observedTs ?? new Date().toISOString(),
  });
}

// CTL-529: stop the debounce timers without flushing the pending batch. Used
// by the daemon shutdown path in index.mjs — the timer handles are router
// module-internal, so the entrypoint reaches them through this export.
export function clearDebounceTimers() {
  clearTimeout(debounceTimer);
  clearTimeout(hardCapTimer);
}
