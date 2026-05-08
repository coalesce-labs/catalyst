#!/usr/bin/env node
// filter-daemon/index.mjs — Groq-powered semantic event router
// No build step, no npm dependencies. Requires Node.js >=21 or Bun.

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
import { homedir } from "node:os";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openFilterStateDb,
  closeFilterStateDb,
  upsertFilterStateOpen,
  setFilterStateMerged,
  setFilterStateDeploying,
  setFilterStateDeployed,
  setFilterStateFailed,
  deleteFilterState,
} from "./filter-state.mjs";

// --- Config ---
const CATALYST_DIR = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;

export function readGroqApiKeyFromConfig(configPath) {
  const path = configPath ?? resolve(homedir(), ".config/catalyst/config.json");
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8"));
    return cfg?.groq?.apiKey ?? "";
  } catch {
    return "";
  }
}

const GROQ_API_KEY = process.env.GROQ_API_KEY || readGroqApiKeyFromConfig();
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
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
  return resolve(CATALYST_DIR, "events", `${ym}.jsonl`);
}

function appendEvent(event) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
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
const INTERESTS_FILE = resolve(CATALYST_DIR, "filter-interests.json");

export function saveInterests() {
  try {
    mkdirSync(dirname(INTERESTS_FILE), { recursive: true });
    writeFileSync(INTERESTS_FILE, JSON.stringify([...interests.entries()], null, 2));
  } catch (err) {
    console.error("[filter] Failed to save interests:", err.message);
  }
}

export function loadPersistedInterests() {
  try {
    const entries = JSON.parse(readFileSync(INTERESTS_FILE, "utf8"));
    for (const [id, reg] of entries) {
      interests.set(id, reg);
    }
    if (interests.size) {
      console.log(`[filter] Loaded ${interests.size} persisted interest(s)`);
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

export function handleRegister(event) {
  const d = event.detail ?? {};
  const id = d.interest_id ?? event.orchestrator ?? d.notify_event;
  if (!id) return;
  const isPrLifecycle = d.interest_type === "pr_lifecycle";
  interests.set(id, {
    notify_event: d.notify_event ?? `filter.wake.${id}`,
    prompt: d.prompt ?? "",
    context: d.context ?? null,
    orchestrator: event.orchestrator ?? null,
    session_id: d.session_id ?? null,
    persistent: d.persistent === true,
    // CTL-284: built-in pr_lifecycle interest type
    interest_type: d.interest_type ?? null,
    pr_numbers: isPrLifecycle ? (Array.isArray(d.pr_numbers) ? d.pr_numbers : []) : null,
    repo: isPrLifecycle ? (d.repo ?? null) : null,
    base_branches: isPrLifecycle ? (Array.isArray(d.base_branches) ? d.base_branches : []) : null,
  });

  if (isPrLifecycle) {
    // Seed filter_state rows so deployment correlations can be persisted later.
    // Skip silently if the DB hasn't been opened yet (e.g. in unit tests that
    // don't call openFilterStateDb).
    try {
      for (const prNumber of (d.pr_numbers ?? [])) {
        upsertFilterStateOpen({
          interestId: id,
          prNumber,
          repo: d.repo ?? "",
        });
      }
    } catch {
      // filter_state DB not opened — okay for tests that don't exercise the chain
    }
  }

  const sessionTag = d.session_id ? `, session: ${d.session_id}` : "";
  if (isPrLifecycle) {
    const prs = (d.pr_numbers ?? []).join(",");
    console.log(`[filter] Registered: ${id} [pr_lifecycle pr=${prs}] (persistent: ${d.persistent === true}${sessionTag})`);
  } else {
    console.log(`[filter] Registered: ${id} — "${d.prompt}" (persistent: ${d.persistent === true}${sessionTag})`);
  }
  saveInterests();
}

export function handleDeregister(event) {
  const id = (event.detail ?? {}).interest_id ?? event.orchestrator;
  if (!id) return;
  const reg = interests.get(id);
  if (interests.delete(id)) {
    if (reg && reg.interest_type === "pr_lifecycle") {
      try {
        deleteFilterState(id);
      } catch {
        // filter_state DB not opened — okay for tests
      }
    }
    console.log(`[filter] Deregistered: ${id}`);
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
      console.log(`[filter] Auto-deregistered: ${id} (orchestrator ${orchId} terminated)`);
      changed = true;
    }
  }
  if (changed) saveInterests();
}

// --- Deterministic event routing (CTL-284) ---
//
// `pr_lifecycle` interests are matched against typed schema-v2 events using
// pure field comparison — no Groq round-trip. Returns an array of matches the
// caller turns into `filter.wake.*` events. Side effect: persists merge SHA
// and deployment_id into the filter_state SQLite store so PR ↔ deployment
// correlations survive daemon restarts.

function botPrefix(author, kind) {
  const isBot = author?.type === "Bot";
  if (kind === "review") {
    return isBot ? "Automated review comment from " : "Changes requested by ";
  }
  if (kind === "comment") {
    return isBot ? "Automated review comment from " : "New review comment from ";
  }
  return "";
}

export function tryDeterministicRoute(event, interestsMap) {
  const matches = [];
  const name = event.event ?? "";
  const detail = event.detail ?? {};
  const scope = event.scope ?? {};
  const eventId = event.id ?? null;

  // Deployment events have global state-machine effects: the SQLite mutators
  // look up by SHA / deploymentId, not by interestId, so we run them ONCE per
  // event (not once per pr_lifecycle interest) and compare the returned
  // interestId inside the loop.
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
      // Defensive: webhook handler routes closed+merged=true to pr.merged, so a
      // pr.closed event here should always have merged=false.
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
      // SHA→interestId match was computed once before the loop.
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
      const branch = ref.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : ref;
      const matchedBase = (reg.base_branches ?? []).find((b) => b.base === branch);
      if (matchedBase) {
        reason = `Base branch ${branch} updated — PR #${matchedBase.pr} is now behind. Rebase may be needed.`;
      }
    }

    if (reason) {
      matches.push({ interestId, reason, sourceEventId: eventId });
    }
  }

  return matches;
}

// --- Event classification ---

// Returns true if this event should be completely ignored (not batched, not dispatched)
export function shouldSkipEvent(event) {
  const name = event.event ?? "";
  // Self-loop prevention: skip all filter.* events the daemon produces or handles.
  // filter.register and filter.deregister are dispatched to handlers before this is called,
  // but skipping all filter.* here ensures no future filter.* variants reach Groq.
  return name.startsWith("filter.");
}

export function buildGroqPrompt(events) {
  if (!interests.size) return null;

  // CTL-284: pr_lifecycle interests are routed deterministically — they have no prompt
  // and would only add noise (or empty entries) to the Groq classification prompt.
  const proseInterests = [...interests.entries()].filter(
    ([, reg]) => reg.interest_type !== "pr_lifecycle",
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
    console.error("[filter] GROQ_API_KEY not set — skipping batch of", events.length, "events");
    return;
  }

  let responseText;
  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: {
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
      console.error(`[filter] Groq error ${res.status}:`, await res.text());
      return;
    }
    const data = await res.json();
    responseText = data.choices?.[0]?.message?.content ?? "[]";
  } catch (err) {
    console.error("[filter] Groq fetch failed:", err.message);
    return;
  }

  let matches;
  try {
    matches = JSON.parse(responseText);
  } catch {
    console.error("[filter] Failed to parse Groq response:", responseText);
    return;
  }

  if (!Array.isArray(matches)) return;

  for (const match of matches) {
    const reg = interests.get(match.interest_id);
    if (!reg) continue;

    const sourceIds = (match.event_indices ?? []).map((i) => events[i - 1]?.id).filter(Boolean);

    if (!sourceIds.length) {
      console.log(`[filter] No source events for ${reg.notify_event} — suppressing empty wake`);
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
    console.log(`[filter] Wake: ${reg.notify_event} — ${match.reason}`);
    if (!reg.persistent) {
      interests.delete(match.interest_id);
      console.log(`[filter] Auto-deregistered (one-shot): ${match.interest_id}`);
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
          console.log(`[filter] Watchdog wake: ${interest.notify_event} — ${reason}`);
          woke = true;
        }
      }
      if (woke) {
        // CTL-269: belt-and-suspenders cleanup — after firing the stale wake,
        // delete registrations whose session_id matches the stale sourceId.
        // Pairs with the trap-handler deregister in oneshot/SKILL.md so crashed
        // sessions don't leak interests across daemon restarts.
        for (const [interestId, interest] of interests) {
          if (interest.session_id && interest.session_id === sourceId) {
            interests.delete(interestId);
            console.log(`[filter] Watchdog cleanup: removed ${interestId} (stale session ${sourceId})`);
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
  const name = event.event ?? "";

  if (name === "filter.register") {
    handleRegister(event);
    return;
  }
  if (name === "filter.deregister") {
    handleDeregister(event);
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

  // Implicitly deregister interests belonging to a terminated orchestrator.
  // The event is still queued for Groq so other orchestrators watching for this event can fire.
  if (name === "orchestrator-completed" || name === "orchestrator-failed") {
    handleOrchestratorTerminated(event);
  }

  if (!interests.size) return;

  // CTL-284: deterministic short-circuit for pr_lifecycle interests.
  // Matched events fire wakes immediately without batching to Groq.
  const directMatches = tryDeterministicRoute(event, interests);
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
      },
    });
    console.log(`[filter] Direct wake: ${reg.notify_event} — ${m.reason}`);
    if (!reg.persistent) {
      interests.delete(m.interestId);
      if (reg.interest_type === "pr_lifecycle") {
        try { deleteFilterState(m.interestId); } catch { /* DB not opened */ }
      }
      saveInterests();
      console.log(`[filter] Auto-deregistered (one-shot): ${m.interestId}`);
    }
  }

  // If a deterministic match fired, don't re-route through Groq — pr_lifecycle
  // interests are excluded from buildGroqPrompt anyway, but skipping the queue
  // also avoids pointless batching for events that have already been handled.
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
    // Month rollover: seek to end of new file to avoid replaying history
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
  // Watch the directory so we handle the "log file doesn't exist yet" case gracefully.
  // When the current month's JSONL file changes, read only new bytes.
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
      if (event.event === "filter.register") handleRegister(event);
      if (event.event === "filter.deregister") handleDeregister(event);
      if (event.event === "orchestrator-completed" || event.event === "orchestrator-failed") {
        handleOrchestratorTerminated(event);
      }
    }
    if (interests.size) {
      console.log(`[filter] Recovered ${interests.size} interest(s) from log`);
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
    console.error("[filter] Failed to write PID file:", err.message);
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

// --- Main ---
function main() {
  if (!GROQ_API_KEY) {
    console.warn(
      "[filter] WARN: GROQ_API_KEY not set and groq.apiKey absent from ~/.config/catalyst/config.json — semantic filtering disabled"
    );
  }

  writePidFile();

  lastLogPath = getEventLogPath();
  loadPersistedInterests();
  loadExistingRegistrations();

  // CTL-284: open the persistent filter_state DB for SHA → deployment correlation
  openFilterStateDb();

  try {
    const fd = openSync(lastLogPath, "r");
    const stat = fstatSync(fd);
    lastByteOffset = stat.size;
    closeSync(fd);
    console.log(`[filter] Starting from byte ${lastByteOffset} of ${lastLogPath}`);
  } catch {
    console.log(`[filter] Starting (no log file yet at ${lastLogPath})`);
  }

  // CTL-269: emit startup event so subscribers can detect daemon restarts
  // and re-register their interests. Persistent interests are also recovered
  // from the log on boot (loadExistingRegistrations) — this is belt-and-suspenders.
  appendEvent({
    event: "filter.daemon.startup",
    orchestrator: null,
    worker: null,
    detail: {
      pid: process.pid,
      recovered_interests: interests.size,
      watchdog_interval_ms: WATCHDOG_INTERVAL_MS,
      heartbeat_stale_ms: HEARTBEAT_STALE_MS,
    },
  });

  startTailing();
  const watchdogId = startWatchdog();
  console.log(
    `[filter] catalyst-filter daemon started (pid ${process.pid}, watchdog: ${WATCHDOG_INTERVAL_MS}ms, stale: ${HEARTBEAT_STALE_MS}ms)`
  );

  const shutdown = () => {
    eventsWatcher?.close();
    clearInterval(watchdogId);
    clearTimeout(debounceTimer);
    clearTimeout(hardCapTimer);
    closeFilterStateDb();
    removePidFile();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run as script only, not when imported as a module (enables unit testing)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
