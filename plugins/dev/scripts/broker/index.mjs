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
import { createHash } from "node:crypto";
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
} from "./broker-state.mjs";
import {
  resolveApiKey,
  formatMissingKeyWarning,
  formatLoadedKeyInfo,
  probeGroq,
  deriveGroqEndpoint,
} from "../lib/api-key-health.mjs";

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

// Canonical envelope helpers (mirrors lib/canonical-event.sh and
// orch-monitor/lib/canonical-event.ts so trace/span IDs match deterministically
// across producers — CTL-331).

const __PLUGIN_JSON_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".claude-plugin",
  "plugin.json",
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

function sha256Hex(input) {
  return createHash("sha256").update(input).digest("hex");
}

function deriveTraceId(orchestratorId) {
  if (orchestratorId && orchestratorId.length > 0) {
    return sha256Hex(orchestratorId).slice(0, 32);
  }
  return null;
}

function deriveSpanId(workerTicket) {
  if (workerTicket && workerTicket.length > 0) {
    return sha256Hex(workerTicket).slice(0, 16);
  }
  return null;
}

const __SEVERITY_NUMBERS = { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 };

// Translate the broker's internal {event, orchestrator, worker, detail} shape
// into a canonical OTel-style envelope. Severity defaults to INFO — broker
// emissions today (filter.wake.*, broker.daemon.startup) are all info-level.
export function buildCanonicalEnvelope(legacy) {
  const eventName = legacy.event ?? "";
  const orch = legacy.orchestrator ?? null;
  const worker = legacy.worker ?? null;
  const severity = legacy.severity ?? "INFO";
  const ts = legacy.ts ?? new Date().toISOString();

  const attributes = { "event.name": eventName };
  if (orch) attributes["catalyst.orchestrator.id"] = orch;
  if (worker) attributes["catalyst.worker.ticket"] = worker;

  return {
    ts,
    observedTs: ts,
    severityText: severity,
    severityNumber: __SEVERITY_NUMBERS[severity] ?? __SEVERITY_NUMBERS.INFO,
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

// --- Interest table ---
const interests = new Map();

export function getInterests() {
  return interests;
}

export function clearInterests() {
  interests.clear();
}

// --- Interest persistence ---
const INTERESTS_FILE = resolve(CATALYST_DIR, "broker-interests.json");
const LEGACY_INTERESTS_FILE = resolve(CATALYST_DIR, "filter-interests.json");

// One-time rename: legacy filter-interests.json → broker-interests.json on startup.
function migrateLegacyInterestsFile() {
  try {
    if (existsSync(LEGACY_INTERESTS_FILE) && !existsSync(INTERESTS_FILE)) {
      renameSync(LEGACY_INTERESTS_FILE, INTERESTS_FILE);
      log.info(
        { from: LEGACY_INTERESTS_FILE, to: INTERESTS_FILE },
        "migrated legacy interests file"
      );
    }
  } catch (err) {
    log.error({ err: err.message }, "failed to migrate legacy interests file");
  }
}

export function saveInterests() {
  try {
    mkdirSync(dirname(INTERESTS_FILE), { recursive: true });
    writeFileSync(INTERESTS_FILE, JSON.stringify([...interests.entries()], null, 2));
  } catch (err) {
    log.error({ err: err.message }, "failed to save interests");
  }
}

export function loadPersistedInterests() {
  try {
    const entries = JSON.parse(readFileSync(INTERESTS_FILE, "utf8"));
    for (const [id, reg] of entries) {
      interests.set(id, reg);
    }
    if (interests.size) {
      log.info({ count: interests.size }, "loaded persisted interests");
    }
  } catch {
    // No file yet or parse error — fine
  }
}

// --- Heartbeat tracking ---
// sourceId → { ts: number (Date.now()), notified: boolean }
const lastHeartbeat = new Map();
// worker/session id → orchestrator id (inferred from heartbeat event fields)
const workerToOrchestrator = new Map();

export function getLastHeartbeat() {
  return lastHeartbeat;
}

export function clearLastHeartbeat() {
  lastHeartbeat.clear();
  workerToOrchestrator.clear();
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
  });

  if (isPrLifecycle) {
    try {
      for (const prNumber of (d.pr_numbers ?? [])) {
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
      "registered",
    );
  } else if (isTicketLifecycle) {
    log.info(
      { interestId: id, type: "ticket_lifecycle", tickets: d.tickets ?? [], persistent },
      "registered",
    );
  } else {
    log.info({ interestId: id, prompt: d.prompt, persistent }, "registered");
  }
  saveInterests();
}

export function handleDeregister(event) {
  const d = getEventPayload(event);
  const id = d.interest_id ?? getEventOrchestrator(event);
  if (!id) return;
  const reg = interests.get(id);
  if (interests.delete(id)) {
    if (reg && reg.interest_type === "pr_lifecycle") {
      try { deleteFilterState(id); } catch { /* DB not opened */ }
    }
    log.info({ interestId: id }, "deregistered");
    saveInterests();
  }
}

export function handleOrchestratorTerminated(event) {
  const orchId = event.orchestrator;
  if (!orchId) return;
  let changed = false;
  for (const [id, reg] of interests) {
    if (reg.orchestrator === orchId) {
      if (reg.interest_type === "pr_lifecycle") {
        try { deleteFilterState(id); } catch { /* DB not opened */ }
      }
      interests.delete(id);
      log.info(
        { interestId: id, orchestrator: orchId },
        "auto-deregistered (orchestrator terminated)",
      );
      changed = true;
    }
  }
  if (changed) saveInterests();
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

  log.info(
    { agentName, sessionId, ticket, claimedPr },
    "agent checked in",
  );
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
  } catch { /* DB not opened */ }

  log.info({ sessionId, prNumber }, "auto-correlated pr_lifecycle for session");
  saveInterests();
}

export function handleAgentCheckout(event) {
  const d = event.detail ?? {};
  const sessionId = d.session_id;
  if (!sessionId) return;

  const finalStatus = d.status ?? "done";

  try { markAgentDone(sessionId, finalStatus); } catch { /* DB not opened */ }

  // Deregister auto-derived pr_lifecycle interest so the watchdog doesn't
  // fire stale wakes after the agent exits.
  const reg = interests.get(sessionId);
  if (reg && reg.interest_type === "pr_lifecycle") {
    interests.delete(sessionId);
    try { deleteFilterState(sessionId); } catch { /* DB not opened */ }
    saveInterests();
  }

  log.info({ sessionId, status: finalStatus }, "agent checked out");
}

export function handleAgentHeartbeat(event) {
  const sessionId = event.session ?? event.worker ?? event.orchestrator;
  if (!sessionId) return;
  const existing = lastHeartbeat.get(sessionId);
  lastHeartbeat.set(sessionId, { ts: Date.now(), notified: existing?.notified ?? false });
  const orchId = event.orchestrator;
  if (orchId && sessionId !== orchId) {
    workerToOrchestrator.set(sessionId, orchId);
  }
}

// --- Deterministic routing: pr_lifecycle (CTL-284) ---------------------------

function botPrefix(author, kind) {
  const isBot = author?.type === "Bot";
  if (kind === "review") return isBot ? "Automated review comment from " : "Changes requested by ";
  if (kind === "comment") return isBot ? "Automated review comment from " : "New review comment from ";
  return "";
}

export function tryDeterministicRoute(event, interestsMap) {
  const matches = [];
  const name = event.event ?? "";
  const detail = event.detail ?? {};
  const scope = event.scope ?? {};
  const eventId = event.id ?? null;

  let deployMatchedInterest = null;
  if (name === "github.deployment.created") {
    try { deployMatchedInterest = setFilterStateDeploying(scope.sha, detail.deploymentId, scope.environment); } catch { /* DB not opened */ }
  } else if (name === "github.deployment_status.success") {
    try { deployMatchedInterest = setFilterStateDeployed(detail.deploymentId); } catch { /* DB not opened */ }
  } else if (name === "github.deployment_status.failure" || name === "github.deployment_status.error") {
    try { deployMatchedInterest = setFilterStateFailed(detail.deploymentId); } catch { /* DB not opened */ }
  }

  for (const [interestId, reg] of interestsMap) {
    if (reg.interest_type !== "pr_lifecycle") continue;

    let reason = null;
    const prList = reg.pr_numbers ?? [];

    if (name === "github.check_suite.completed") {
      const eventPrs = Array.isArray(detail.prNumbers) ? detail.prNumbers : [];
      const matchedPr = eventPrs.find((n) => prList.includes(n));
      if (matchedPr !== undefined) {
        if (detail.conclusion === "failure") {
          reason = `CI failing on PR #${matchedPr} — check_suite conclusion: failure`;
        } else if (detail.conclusion === "success") {
          reason = `All CI checks passing on PR #${matchedPr}`;
        }
      }
    } else if (name === "github.pr.merged") {
      if (prList.includes(scope.pr)) {
        const sha = detail.mergeCommitSha ?? "unknown";
        reason = `PR #${scope.pr} merged (merge commit: ${sha}). Now waiting for deployment — do not close out until deployment succeeds.`;
        if (detail.mergeCommitSha) {
          try { setFilterStateMerged(interestId, detail.mergeCommitSha); } catch { /* DB not opened */ }
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
    } else if (name === "github.deployment_status.failure" || name === "github.deployment_status.error") {
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

    if (reason) matches.push({ interestId, reason, sourceEventId: eventId });
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
  "pr_opened", "pr_merged", "status_done", "status_in_review", "status_changed", "comment_added",
];

export function tryTicketLifecycleRoute(event, interestsMap) {
  const matches = [];
  const name = event.event ?? "";
  const detail = event.detail ?? {};
  const scope = event.scope ?? {};
  const attrs = event.attributes ?? {};
  const eventId = event.id ?? null;

  // Extract the ticket this event concerns. Linear canonical events carry
  // `attributes["linear.issue.identifier"]`; legacy/flat events use `detail.ticket`.
  const eventTicket =
    attrs["linear.issue.identifier"] ??
    detail.ticket ??
    detail.identifier ??
    null;

  // For GitHub PR events extract ticket refs from PR body / title / branch ref.
  let prBodyTickets = [];
  if (name === "github.pr.merged" || name === "github.pr.opened" || name === "github.pr.closed") {
    const bodyText = [detail.body ?? "", detail.title ?? "", detail.headRef ?? ""].join(" ");
    const found = bodyText.match(/\b([A-Z]{1,10}-\d+)\b/g) ?? [];
    prBodyTickets = [...new Set(found)];
  }

  // Side effect: update ticket_state for known state-change events.
  if (name === "linear.issue.state_changed" && eventTicket) {
    const newState = detail.state ?? detail.stateName ?? null;
    try { upsertTicketState({ ticket: eventTicket, linearState: newState }); } catch { /* DB not opened */ }
  }
  if ((name === "github.pr.opened" || name === "github.pr.merged") && prBodyTickets.length > 0) {
    const prNum = typeof scope.pr === "number" ? scope.pr : null;
    for (const t of prBodyTickets) {
      try { upsertTicketState({ ticket: t, prNumber: prNum }); } catch { /* DB not opened */ }
    }
  }

  for (const [interestId, reg] of interestsMap) {
    if (reg.interest_type !== "ticket_lifecycle") continue;

    const watchedTickets = reg.tickets ?? [];
    if (watchedTickets.length === 0) continue;

    const wakeOn = reg.wake_on ?? TICKET_LIFECYCLE_ALL_WAKE_ON;
    let reason = null;
    let matchedTicket = null;

    if (name === "linear.issue.state_changed" && eventTicket && watchedTickets.includes(eventTicket)) {
      matchedTicket = eventTicket;
      const newState = detail.state ?? detail.stateName ?? "unknown";
      if (wakeOn.includes("status_done") && /done/i.test(newState)) {
        reason = `Ticket ${eventTicket} marked Done`;
      } else if (wakeOn.includes("status_in_review") && /in.?review/i.test(newState)) {
        reason = `Ticket ${eventTicket} moved to In Review`;
      } else if (wakeOn.includes("status_changed")) {
        reason = `Ticket ${eventTicket} state changed to ${newState}`;
      }
    } else if (name === "linear.issue.updated" && eventTicket && watchedTickets.includes(eventTicket)) {
      if (wakeOn.includes("status_changed")) {
        matchedTicket = eventTicket;
        reason = `Ticket ${eventTicket} updated`;
      }
    } else if (name === "linear.comment.created" && eventTicket && watchedTickets.includes(eventTicket)) {
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
      matches.push({ interestId, reason, sourceEventId: eventId, ticket: matchedTicket });
    }
  }

  return matches;
}

// When a PR opens linked to a ticket, auto-register pr_lifecycle for any agent
// that checked in with that ticket but hasn't been linked to a PR yet.
function _autoPrLifecycleFromTicket(ticket, prNumber, interestsMap) {
  let agents = [];
  try { agents = getAgentsByTicket(ticket); } catch { return; }

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

    try { upsertFilterStateOpen({ interestId: sessionId, prNumber, repo: "" }); } catch { /* DB not opened */ }

    log.info(
      { sessionId, ticket, prNumber },
      "auto-correlated pr_lifecycle from ticket",
    );
    saveInterests();
  }
}

// --- Event classification ---

export function shouldSkipEvent(event) {
  const name = event.event ?? "";
  return name.startsWith("filter.");
}

export function buildGroqPrompt(events) {
  if (!interests.size) return null;

  // Deterministic-routed interest types are excluded from the Groq prompt.
  const proseInterests = [...interests.entries()].filter(
    ([, reg]) => reg.interest_type !== "pr_lifecycle" && reg.interest_type !== "ticket_lifecycle",
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

async function classifyBatch(events) {
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

  if (!Array.isArray(matches)) return;

  for (const match of matches) {
    const reg = interests.get(match.interest_id);
    if (!reg) continue;

    const sourceIds = (match.event_indices ?? []).map((i) => events[i - 1]?.id).filter(Boolean);

    if (!sourceIds.length) {
      log.info(
        { notifyEvent: reg.notify_event },
        "no source events — suppressing empty wake",
      );
      continue;
    }

    appendEvent({
      event: reg.notify_event,
      orchestrator: reg.orchestrator ?? match.interest_id,
      worker: null,
      detail: {
        reason: match.reason,
        source_event_ids: sourceIds,
        interest_id: match.interest_id,
      },
    });
    log.info({ notifyEvent: reg.notify_event, reason: match.reason }, "wake");
    if (!reg.persistent) {
      interests.delete(match.interest_id);
      log.info({ interestId: match.interest_id }, "auto-deregistered (one-shot)");
    }
  }
}

// --- Debounce ---
let pendingBatch = [];
let debounceTimer = null;
let hardCapTimer = null;

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
  for (const [sourceId, state] of lastHeartbeat) {
    const stale = now - state.ts > HEARTBEAT_STALE_MS;
    if (stale && !state.notified) {
      const minsAgo = Math.round((now - state.ts) / 60_000);
      const reason = `No heartbeat from ${sourceId} for >${minsAgo} min`;
      let woke = false;
      for (const [interestId, interest] of interests) {
        const workers = interest.context?.workers;
        const orchForSource = workerToOrchestrator.get(sourceId);
        const orchMatch = orchForSource != null && orchForSource === interest.orchestrator;
        if ((workers != null && workers.includes(sourceId)) || (workers == null && orchMatch)) {
          appendEvent({
            event: interest.notify_event,
            orchestrator: interest.orchestrator ?? interestId,
            worker: null,
            detail: { reason, source_event_ids: [], interest_id: interestId },
          });
          log.info(
            { notifyEvent: interest.notify_event, reason },
            "watchdog wake",
          );
          woke = true;
        }
      }
      if (woke) {
        // Belt-and-suspenders: clean up interests for the stale session.
        for (const [interestId, interest] of interests) {
          if (interest.session_id && interest.session_id === sourceId) {
            interests.delete(interestId);
            log.info(
              { interestId, sourceId },
              "watchdog cleanup: removed stale session",
            );
          }
        }
        lastHeartbeat.set(sourceId, { ts: state.ts, notified: true });
      }
    } else if (!stale && state.notified) {
      lastHeartbeat.set(sourceId, { ts: state.ts, notified: false });
    }
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
    appendEvent({
      event: reg.notify_event,
      orchestrator: reg.orchestrator ?? m.interestId,
      worker: null,
      detail: {
        reason: m.reason,
        source_event_ids: m.sourceEventId ? [m.sourceEventId] : [],
        interest_id: m.interestId,
        ...(m.ticket ? { ticket: m.ticket } : {}),
      },
    });
    log.info(
      { notifyEvent: reg.notify_event, reason: m.reason },
      "direct wake",
    );
    if (!reg.persistent) {
      interests.delete(m.interestId);
      if (reg.interest_type === "pr_lifecycle") {
        try { deleteFilterState(m.interestId); } catch { /* DB not opened */ }
      }
      saveInterests();
      log.info({ interestId: m.interestId }, "auto-deregistered (one-shot)");
    }
  }

  if (directMatches.length > 0) return;

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
      try { event = JSON.parse(line); } catch { continue; }
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
      try { event = JSON.parse(line); } catch { continue; }
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
  try { unlinkSync(PID_FILE_PATH); } catch { /* already gone */ }
}

// --- State file (CTL-343) ---
// ~/catalyst/broker.state.json is the single source of truth for at-a-glance
// broker key health. Consumed by `catalyst-broker status --json`,
// `catalyst-monitor status --json`, and the HUD header chip.
const BROKER_STATE_FILE = resolve(CATALYST_DIR, "broker.state.json");

export function buildBrokerState({ probe } = {}) {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
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

export function writeBrokerStateFile(state, { path = BROKER_STATE_FILE } = {}) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    log.warn({ err: err.message, path }, "failed to write broker state file");
  }
}

// Exported so the state-file path is discoverable by tests.
export function getBrokerStateFilePath() {
  return BROKER_STATE_FILE;
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
      { source: GROQ_KEY_SOURCE, prefix: GROQ_KEY_PREFIX, model: GROQ_MODEL, endpoint: GROQ_ENDPOINT },
      formatLoadedKeyInfo({ name: "GROQ_API_KEY", source: GROQ_KEY_SOURCE, prefix: GROQ_KEY_PREFIX }),
    );
    if (GROQ_GATEWAY_ENABLED) {
      log.info({ baseUrl: GROQ_GATEWAY_BASE_URL }, "GROQ gateway enabled — routing chat completions through configured baseUrl");
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
      log.warn({ err: probe.error }, "Groq probe could not complete — semantic routing may be impaired");
      break;
    case "missing":
      // already warned at startup
      break;
  }
  return probe;
}

// --- Main ---
function main() {
  logKeyHealthAtStartup();

  writePidFile();
  // Write initial state (probeStatus: pending or missing). Updated after probe completes.
  writeBrokerStateFile(buildBrokerState());

  migrateLegacyInterestsFile();

  lastLogPath = getEventLogPath();
  loadPersistedInterests();
  loadExistingRegistrations();

  openBrokerStateDb();

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
      key_health: { source: GROQ_KEY_SOURCE, prefix: GROQ_KEY_PREFIX, gateway: GROQ_GATEWAY_ENABLED },
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
    "catalyst-broker daemon started",
  );

  // Fire the Groq /v1/models probe asynchronously so it doesn't gate startup.
  runStartupProbe().then((probe) => {
    writeBrokerStateFile(buildBrokerState({ probe }));
  }).catch((err) => {
    log.warn({ err: err.message }, "probe error suppressed");
  });

  const shutdown = () => {
    eventsWatcher?.close();
    clearInterval(watchdogId);
    clearTimeout(debounceTimer);
    clearTimeout(hardCapTimer);
    closeBrokerStateDb();
    removePidFile();
    try { unlinkSync(BROKER_STATE_FILE); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
