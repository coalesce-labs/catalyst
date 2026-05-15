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
  existsSync,
  renameSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
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
  resolveApiKey,
  formatMissingKeyWarning,
  formatLoadedKeyInfo,
  probeGroq,
  deriveGroqEndpoint,
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

// --- Logger ---
const log = pino({
  name: "broker",
  level: process.env.LOG_LEVEL ?? "info",
});

// --- Config ---
const CATALYST_DIR = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
const GLOBAL_CONFIG_PATH = resolve(homedir(), ".config/catalyst/config.json");

// CTL-343: key resolution moved to lib/api-key-health.mjs. Read groq gateway
// alongside the key so the chat-completions endpoint can route through a
// configured proxy (e.g. Adva AI Gateway, Litellm, Helicone).
export function readGroqConfig(configPath) {
  const path = configPath ?? GLOBAL_CONFIG_PATH;
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    return cfg?.groq ?? null;
  } catch {
    return null;
  }
}

// Retained as a named export for any external callers; new code should use
// resolveApiKey() from lib/api-key-health.mjs directly.
export function readGroqApiKeyFromConfig(configPath) {
  return readGroqConfig(configPath)?.apiKey ?? "";
}

const groqKeyResolution = resolveApiKey({
  envName: "GROQ_API_KEY",
  configKeyPath: "groq.apiKey",
  configPath: GLOBAL_CONFIG_PATH,
});
const groqConfig = readGroqConfig();
const groqEndpoint = deriveGroqEndpoint({ gateway: groqConfig?.gateway });

const GROQ_API_KEY = groqKeyResolution.value;
const GROQ_KEY_SOURCE = groqKeyResolution.source;
const GROQ_KEY_PREFIX = groqKeyResolution.prefix;
const GROQ_ENDPOINT = groqEndpoint.url;
const GROQ_EXTRA_HEADERS = groqEndpoint.extraHeaders;
const GROQ_GATEWAY_ENABLED = groqEndpoint.gatewayEnabled;
const GROQ_GATEWAY_BASE_URL = GROQ_GATEWAY_ENABLED ? groqConfig?.gateway?.baseUrl : null;
const GROQ_MODEL = process.env.FILTER_GROQ_MODEL ?? "llama-3.1-8b-instant";
const DEBOUNCE_MS = parseInt(process.env.FILTER_DEBOUNCE_MS ?? "100", 10);
const HARD_CAP_MS = parseInt(process.env.FILTER_HARD_CAP_MS ?? "500", 10);
const MAX_BATCH_SIZE = parseInt(process.env.FILTER_BATCH_SIZE ?? "20", 10);
const LOOKBACK_LINES = 1000;
const WATCHDOG_INTERVAL_MS = parseInt(process.env.FILTER_WATCHDOG_INTERVAL_MS ?? "60000", 10);
const HEARTBEAT_STALE_MS = parseInt(process.env.FILTER_HEARTBEAT_STALE_MS ?? "180000", 10);

// --- Event log ---
function getEventLogPath() {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  // Re-read CATALYST_DIR per call so tests can redirect by setting the env
  // var. Production deployments still pin a stable value via daemon launch.
  const catalystDir = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
  return resolve(catalystDir, "events", `${ym}.jsonl`);
}

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
    resource: {
      "service.name": "catalyst.broker",
      "service.namespace": "catalyst",
      "service.version": pluginVersion(),
    },
    attributes,
    body: { payload: legacy.detail ?? null },
  };
}

export function appendEvent(event) {
  const logPath = getEventLogPath();
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

// --- Interest table ---
const interests = new Map();

export function getInterests() {
  return interests;
}

export function clearInterests() {
  interests.clear();
}

// --- Broker liveness stats (CTL-352) -----------------------------------------
// Mutable module state that buildBrokerState() surfaces in broker.state.json so
// operators (and the HUD pill in Phase 3) can tell at a glance whether the
// broker has any registered interests and when it last did real work.
let brokerStartedAt = null;
let lastWakeAt = null;
let lastRegisterAt = null;
// One-shot guard for broker.daemon.degraded — set on emission, cleared whenever
// interests.size > 0 so a future empty window re-arms.
let degradedEmittedAt = null;

const DEGRADED_THRESHOLD_MS = 5 * 60 * 1000;

// Test-only setters. Production paths only ever set these via main() and the
// hook points below; tests use these to time-travel without touching Date.now().
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
}

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
function migrateLegacyInterestsFile() {
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

// CTL-357: one-shot startup event. If the Groq prose path is gated off (the
// default) and any non-deterministic interests are sitting in the interests
// table (loaded from disk for backward compat), emit a single
// broker.daemon.prose_disabled event so the operator can see at a glance that
// those entries exist but will never fire. Idempotent across the process
// lifetime — once emitted, subsequent calls are no-ops.
const DETERMINISTIC_INTEREST_TYPES = new Set([
  "pr_lifecycle",
  "ticket_lifecycle",
  "comms_lifecycle",
]);
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

// --- Heartbeat tracking ---
// sourceId → { ts: number (Date.now()), notified: boolean }
const lastHeartbeat = new Map();
// worker/session id → orchestrator id (inferred from heartbeat event fields)
const workerToOrchestrator = new Map();
// CTL-403: session_id → { timeoutAt: number, waitFor, ticket, orchestrator, reason }
const waitingSessions = new Map();

export function getLastHeartbeat() {
  return lastHeartbeat;
}

export function clearLastHeartbeat() {
  lastHeartbeat.clear();
  workerToOrchestrator.clear();
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

// CTL-336: read name/payload/orchestrator from canonical OTel-format events
// (data in `attributes` + `body.payload`) as well as legacy flat events
// (data in `event` + `detail` + `orchestrator`). Resolved here so the
// rest of the broker can stay shape-agnostic.
function getEventName(event) {
  return event.event ?? event.attributes?.["event.name"] ?? "";
}
function getEventPayload(event) {
  return event.detail ?? event.body?.payload ?? {};
}
function getEventOrchestrator(event) {
  return event.orchestrator ?? event.attributes?.["catalyst.orchestrator.id"] ?? null;
}

export function handleRegister(event) {
  const d = getEventPayload(event);
  const orchestrator = getEventOrchestrator(event);
  const id = d.interest_id ?? orchestrator ?? d.notify_event;
  if (!id) return;
  const isPrLifecycle = d.interest_type === "pr_lifecycle";
  const isTicketLifecycle = d.interest_type === "ticket_lifecycle";
  const isCommsLifecycle = d.interest_type === "comms_lifecycle";
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
    types_of_interest: isCommsLifecycle ? (Array.isArray(d.types_of_interest) ? d.types_of_interest : null) : null,
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
  } else {
    log.info({ interestId: id, prompt: d.prompt, persistent }, "registered");
  }
  saveInterests();
  lastRegisterAt = new Date().toISOString();
  // CTL-352: a fresh registration arms a future degraded event.
  degradedEmittedAt = null;
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
}

// --- Agent identity (CTL-303) ------------------------------------------------

// Handle agent.checkin: store identity and auto-derive pr_lifecycle if claimed_pr is set.
export function handleAgentCheckin(event) {
  const d = event.detail ?? {};
  const sessionId = d.session_id;
  if (!sessionId) return;

  const agentName = d.agent_name ?? sessionId;
  const ticket = d.ticket ?? null;
  const claimedPr = d.claimed_pr ?? null;
  const orchestrator = d.orchestrator ?? event.orchestrator ?? null;
  const cwd = d.cwd ?? null;

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
  if (claimedPr) {
    _autoRegisterPrLifecycle(sessionId, claimedPr, orchestrator, ticket);
  }

  log.info({ agentName, sessionId, ticket, claimedPr }, "agent checked in");
}

// Auto-register a pr_lifecycle interest when we learn agent ↔ PR mapping.
function _autoRegisterPrLifecycle(sessionId, prNumber, orchestrator, ticket) {
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
    repo: null,
    base_branches: [],
    tickets: null,
    wake_on: null,
  });

  try {
    upsertFilterStateOpen({ interestId: sessionId, prNumber, repo: "" });
  } catch {
    /* DB not opened */
  }

  log.info({ sessionId, prNumber }, "auto-correlated pr_lifecycle for session");
  saveInterests();
  lastRegisterAt = new Date().toISOString();
  degradedEmittedAt = null;
  persistBrokerState();
}

export function handleAgentCheckout(event) {
  const d = event.detail ?? {};
  const sessionId = d.session_id;
  if (!sessionId) return;

  const finalStatus = d.status ?? "done";

  try {
    markAgentDone(sessionId, finalStatus);
  } catch {
    /* DB not opened */
  }

  // Deregister auto-derived pr_lifecycle interest so the watchdog doesn't
  // fire stale wakes after the agent exits.
  const reg = interests.get(sessionId);
  if (reg && reg.interest_type === "pr_lifecycle") {
    interests.delete(sessionId);
    try {
      deleteFilterState(sessionId);
    } catch {
      /* DB not opened */
    }
    saveInterests();
    persistBrokerState();
  }

  log.info({ sessionId, status: finalStatus }, "agent checked out");
}

export function handleAgentHeartbeat(event) {
  const sessionId =
    event.session ?? event.worker ?? event.orchestrator ??
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
  } catch { /* DB not opened */ }

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

  try { clearWaitingSession(sessionId); } catch { /* DB not opened */ }

  log.info({ sessionId, outcome: d.outcome ?? "unknown" }, "worker resumed");
  persistBrokerState();
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
  const scope = event.scope ?? {};
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
      if (matchedPr !== undefined) {
        if (detail.conclusion === "failure") {
          reason = `CI failing on PR #${matchedPr} — check_suite conclusion: failure`;
          wakeStateKey = `ci_conclusion:${matchedPr}`;
          wakeStateValue = "failure";
        } else if (detail.conclusion === "success") {
          reason = `All CI checks passing on PR #${matchedPr}`;
          wakeStateKey = `ci_conclusion:${matchedPr}`;
          wakeStateValue = "success";
        }
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
    try { upsertTicketState({ ticket: eventTicket, linearState: newState }); } catch { /* DB not opened */ }
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
          _autoPrLifecycleFromTicket(linked, scope.pr, interestsMap);
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
function _autoPrLifecycleFromTicket(ticket, prNumber, interestsMap) {
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
      repo: null,
      base_branches: [],
      tickets: null,
      wake_on: null,
    });

    try {
      upsertFilterStateOpen({ interestId: sessionId, prNumber, repo: "" });
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
    lastRegisterAt = new Date().toISOString();
    degradedEmittedAt = null;
    persistBrokerState();
  }
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
  if (name.startsWith("filter.")) return true;
  if (name.startsWith("broker.daemon")) return true;
  // CTL-401: liveness pings — handled earlier in processEvent, skip here too
  // so they never reach the Groq queue even if the early-return path changes.
  if (name === "session.heartbeat") return true;
  return false;
}

export function buildGroqPrompt(events) {
  if (!interests.size) return null;

  // Deterministic-routed interest types are excluded from the Groq prompt.
  const proseInterests = [...interests.entries()].filter(
    ([, reg]) =>
      reg.interest_type !== "pr_lifecycle" &&
      reg.interest_type !== "ticket_lifecycle" &&
      reg.interest_type !== "comms_lifecycle"
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
    lastWakeAt = new Date().toISOString();
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

export function runWatchdogTick() {
  const now = Date.now();

  // CTL-352: empty-interests observability. Warn on every tick when the table
  // is empty so a silently-dead broker is loud in broker.log, and emit a
  // one-shot broker.daemon.degraded event after the 5-minute startup grace so
  // downstream consumers (HUD, alerts) can pair startup ↔ degraded.
  if (interests.size === 0) {
    const startedTs = brokerStartedAt ? new Date(brokerStartedAt).getTime() : now;
    const uptimeMs = now - startedTs;
    log.warn({ uptimeMs }, "watchdog: no registered interests");
    if (uptimeMs > DEGRADED_THRESHOLD_MS && degradedEmittedAt === null) {
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
      degradedEmittedAt = new Date().toISOString();
      persistBrokerState();
    }
  } else if (degradedEmittedAt !== null) {
    degradedEmittedAt = null;
  }

  let watchdogWoke = false;

  // CTL-419: collect all currently-stale not-yet-notified sessions first.
  // Then iterate interests (outer) and batch all matching stale sessions into
  // a single appendEvent call per interest — avoids N identical wake rows in
  // the HUD when N sessions go stale simultaneously.
  const staleNow = new Map(); // sourceId → { ts, minsAgo }
  for (const [sourceId, state] of lastHeartbeat) {
    const stale = now - state.ts > HEARTBEAT_STALE_MS;
    // CTL-403: skip stale-wake if this session has an active wait whose timeout
    // has not yet elapsed. The session is legitimately blocking — not dead.
    if (stale && waitingSessions.has(sourceId)) {
      const ws = waitingSessions.get(sourceId);
      if (ws.timeoutAt > now) {
        const secsLeft = Math.round((ws.timeoutAt - now) / 1000);
        log.debug({ sourceId, secsLeft, waitFor: ws.waitFor }, "watchdog: skipping stale check — session is legitimately waiting");
        continue;
      }
      // Wait timed out — treat as stale and clean up the waiting record.
      waitingSessions.delete(sourceId);
      try { clearWaitingSession(sourceId); } catch { /* DB not opened */ }
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
      "watchdog wake (batched)",
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
    lastWakeAt = new Date().toISOString();
    persistBrokerState();
  }
}

function startWatchdog() {
  return setInterval(runWatchdogTick, WATCHDOG_INTERVAL_MS);
}

// --- Event processing ---
export function processEvent(event) {
  const name = getEventName(event);

  if (name === "filter.register") {
    handleRegister(event);
    return;
  }
  if (name === "filter.deregister") {
    handleDeregister(event);
    return;
  }

  // CTL-303: structured agent identity events.
  if (name === "agent.checkin") {
    handleAgentCheckin(event);
    return;
  }
  if (name === "agent.checkout") {
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

  if (shouldSkipEvent(event)) return;

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

  // Deterministic short-circuit: pr_lifecycle (CTL-284) and ticket_lifecycle (CTL-303).
  const prMatches = tryDeterministicRoute(event, interests);
  const ticketMatches = tryTicketLifecycleRoute(event, interests);
  const directMatches = [...prMatches, ...ticketMatches];

  for (const m of directMatches) {
    const reg = interests.get(m.interestId);
    if (!reg) continue;
    // CTL-406: skip duplicate (source_event_id, interest_id) pairs.
    if (shouldSkipWake(m.sourceEventId, m.interestId)) {
      log.debug({ interestId: m.interestId, sourceEventId: m.sourceEventId }, "dedup: skipping duplicate wake");
      continue;
    }

    // CTL-407: suppress wake when downstream state is unchanged from last emission.
    if (reg.suppress_identical_wakes && m.wakeStateKey !== null) {
      if (reg.last_wake_state[m.wakeStateKey] === m.wakeStateValue) {
        log.info(
          { notifyEvent: reg.notify_event, wakeStateKey: m.wakeStateKey, wakeStateValue: m.wakeStateValue },
          "suppressed redundant wake (state unchanged)",
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
    lastWakeAt = new Date().toISOString();
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

function loadExistingRegistrations() {
  try {
    const content = readFileSync(lastLogPath, "utf8");
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
      if (name === "agent.checkin") handleAgentCheckin(event);
      if (name === "agent.checkout") handleAgentCheckout(event);
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
    startedAt: brokerStartedAt ?? new Date().toISOString(),
    // CTL-352: liveness fields so the HUD pill and operators can detect a
    // silently-dead broker (interests.size === 0 with stale lastWakeAt).
    interestCount: interests.size,
    lastWakeAt,
    lastRegisterAt,
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
function persistBrokerState({ probe } = {}) {
  writeBrokerStateFile(buildBrokerState({ probe }));
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
  brokerStartedAt = new Date().toISOString();

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
    clearTimeout(debounceTimer);
    clearTimeout(hardCapTimer);
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
