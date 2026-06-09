// board-data.mjs — assembles the live "Worker/Ticket board" payload (CTL-727).
//
// Single source of board state for the new monitor UI, built from the stateless
// execution-core surfaces (no long-running orchestrator required):
//   • `claude agents --json`                         → live workers + status
//   • ~/catalyst/execution-core/workers/<T>/phase-*.json → per-ticket phase/status
//   • ~/catalyst/execution-core/eligible/<TEAM>.json → ranked priority queue
//   • ~/catalyst/catalyst.db (sessions ⋈ session_metrics) → cost rollup per ticket
//
// CTL-733: assembleBoard() is now ASYNC and non-blocking — every filesystem read
// and subprocess spawn uses node:fs/promises + promisified execFile, and the
// per-ticket reads fan out with Promise.all — so the monitor's reactive snapshot
// manager can recompute it without ever blocking the server event loop. The
// transcript-path lookup is memoized per session to kill the ~1.5k-dir rescan.
// Returns a plain JSON object. Used by server.ts (the reactive snapshot) and the
// Vite dev middleware.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";
import { readLinearCache } from "./linear-cache-reader.mjs";

const execFileP = promisify(execFile);

const HOME = homedir();
const EC = join(HOME, "catalyst", "execution-core");
const WORKERS_DIR = join(EC, "workers");
const ELIGIBLE_DIR = join(EC, "eligible");
const DB = join(HOME, "catalyst", "catalyst.db");
// CTL-928: the durable per-`claude --bg`-job state directory. A worker's
// liveness is proven by its job's state.json HERE, NOT by a phase signal that
// merely says `running` (on 2026-06-09 four sources disagreed on liveness — the
// signal file was the least reliable). Mirrors the daemon's recovery.mjs lookup
// (~/.claude/jobs/<bg_job_id>/state.json) and honours the same
// CATALYST_REVIVE_JOBS_DIR override. Resolved at call time (like recovery.mjs's
// getJobsRoot) so a test can point it at a temp dir without an import dance.
function jobsRoot() {
  return process.env.CATALYST_REVIVE_JOBS_DIR || join(HOME, ".claude", "jobs");
}

// Canonical 10-phase pipeline order + which statuses are terminal for a phase.
export const PHASE_ORDER = [
  "triage", "research", "plan", "implement", "verify",
  "review", "pr", "monitor-merge", "monitor-deploy", "teardown",
];
// Single source of truth for which phase statuses are terminal (no longer
// running). Exported so the UI's PhaseStrip terminal-status list can be guarded
// against drift (board-phase-drift.test.ts) instead of carrying a silent
// hand-copied duplicate (CTL-754).
export const TERMINAL = new Set([
  "done", "failed", "stalled", "skipped", "signal_corrupt", "superseded", "canceled",
]);

// CTL-928 — the authoritative `claude --bg` job-LIFECYCLE terminal states (the
// `state` value Claude writes into ~/.claude/jobs/<id>/state.json). DISTINCT from
// the worker-SIGNAL TERMINAL set above (a phase-signal `status` like done/skipped):
// a signal can say `running` while the durable job state is `stopped`/`failed`/
// `done` — that disagreement is exactly the dead-worker-shown-active bug. Kept in
// lock-step with execution-core/recovery.mjs TERMINAL_JOB_STATES (the daemon's
// dead-detection source); `working` is the sole non-terminal value.
export const TERMINAL_JOB_STATES = new Set(["stopped", "failed", "done", "blocked"]);

// CTL-928: the FINAL pipeline phases. A ticket whose CURRENT phase (per
// deriveCurrentPhase) is one of these and is terminal has genuinely finished the
// pipeline → it belongs in the recent-done tail. deriveCurrentPhase already
// collapses a terminal monitor-deploy/teardown to the synthetic phase "done"
// (CTL-745, :258), so "done" is the one true pipeline-done marker. Every OTHER
// terminal phase (triage/research/plan/verify/review… done) is an INTERMEDIATE
// completion → the ticket is idle BETWEEN phases, not finished.
export const PIPELINE_DONE_PHASE = "done";

// bgJobLifecycle — CTL-928 read-model mirror of recovery.mjs::jobLifecycle. PURE
// given the already-read job state (so it is trivially unit-testable and the
// async fs read stays at the edge). `jobState` is { state, firstTerminalAt } as
// read from ~/.claude/jobs/<id>/state.json, or null when the dir is gone.
//   "dead-gone"     — job dir gone (null): the worker process no longer exists.
//   "dead-terminal" — firstTerminalAt set OR .state ∈ TERMINAL_JOB_STATES: Claude
//                     marked the job terminal. Definitive — no grace window.
//   "alive"         — any other readable state (notably "working", or an
//                     unreadable state.json whose dir still exists). mtime is NOT
//                     consulted — a multi-minute in-process sub-agent fan-out keeps
//                     .state non-terminal while mtime ages (the CTL-662 trap).
export function bgJobLifecycle(jobState) {
  if (!jobState) return "dead-gone";
  if (jobState.firstTerminalAt || TERMINAL_JOB_STATES.has(jobState.state)) return "dead-terminal";
  return "alive";
}

// isBgJobDead — convenience predicate over bgJobLifecycle: a job is DEAD when its
// lifecycle is either dead-gone or dead-terminal. A worker whose bg job is dead
// must NOT count as in-flight, hold a maxParallel slot, or render "active"
// (CTL-928). null jobState (no bg_job_id resolvable) → treated as dead-gone.
export function isBgJobDead(jobState) {
  return bgJobLifecycle(jobState) !== "alive";
}

// CTL-755 held-indicator labels (admission-control gate). A triaged-waiting
// ticket the scheduler holds before the triage→research promotion carries one of
// these Linear labels: `blocked` (≥1 non-terminal blocked_by dependency) or
// `waiting` (deps satisfied but it lost the priority/capacity selection this
// tick). The scheduler converges them ON A DIFF (apply/remove) and clears BOTH
// on pickup. These two strings MUST stay in lock-step with
// execution-core/scheduler.mjs HELD_LABEL_BLOCKED / HELD_LABEL_WAITING — the
// board-held-indicator drift guard asserts that, so the board reads the same
// label the daemon writes (we copy the literals rather than import the whole
// scheduler module into the lightweight board data layer).
export const HELD_LABEL_BLOCKED = "blocked";
export const HELD_LABEL_WAITING = "waiting";

// heldFor — classify a ticket's held state from its Linear label set. `blocked`
// wins over `waiting` when both are somehow present (it is the more severe hold;
// steady-state convergence only ever leaves one applied). Returns "blocked" |
// "waiting" | null. Pure + exported so it is unit-testable.
export function heldFor(labels) {
  const set = new Set(Array.isArray(labels) ? labels : []);
  if (set.has(HELD_LABEL_BLOCKED)) return HELD_LABEL_BLOCKED;
  if (set.has(HELD_LABEL_WAITING)) return HELD_LABEL_WAITING;
  return null;
}

// phase → Linear workflow state (board columns for the Tickets/Linear lens).
export const PHASE_TO_LINEAR = {
  triage: "Triage", research: "Research", plan: "Plan", implement: "Implement",
  verify: "Validate", review: "Validate", pr: "PR", "monitor-merge": "PR",
  "monitor-deploy": "Done", teardown: "Done", done: "Done",
  queued: "Todo",  // synthetic phase for eligible-queue board cards (CTL-767)
};

// synthesizeQueuedTicket — build a thin BoardTicket from an eligible queue entry
// so it renders in the "Todo" Kanban column (CTL-767). All agent/cost/phase-summary
// fields default to null / empty since there is no worker dir for these tickets.
export function synthesizeQueuedTicket(e, linfo) {
  const li = linfo[e.id] ?? {};
  return {
    id: e.id,
    title: e.title || e.id,
    type: "task",
    repo: e.repo || repoFor(e.id),
    team: e.team || teamFor(e.id),
    phase: "queued",
    status: "queued",
    model: null,
    linearState: PHASE_TO_LINEAR.queued,
    workerStatus: null,
    activeState: null,
    working: false,
    lastActiveMs: null,
    priority: li.priority ?? e.priority ?? 0,
    estimate: li.estimate ?? null,
    scope: null,
    project: li.project ?? null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: e.createdAt || new Date(0).toISOString(),
    held: heldFor(li.labels),
    blockers: [],
    // CTL-901 (HOME3): a queued ticket has no worker dir / phase signal, so it
    // has no current-phase start (null). Its held duration, when held, comes from
    // the durable ticket_state heldSince the broker projected (BFF11) — honest
    // null when the cache has no stamp.
    heldSince: li.heldSince ?? null,
    currentPhaseSince: null,
    // CTL-922 (BFF10): node attribution. A queued ticket has no worker dir /
    // phase signal, so host + generation come purely from the durable fence
    // projection (li, via the broker's BFF11 ticket_state). team is the
    // prefix-derived team (BoardQueueItem also carries it now). All null/identity
    // for a queued ticket with no fence attachment yet — never fabricated.
    host: deriveHost([], li),
    generation: deriveGeneration([], li),
  };
}

// team/prefix → repo swim-lane label
const TEAM_REPO = { CTL: "catalyst", ADV: "adva" };
const repoFor = (ticket) => TEAM_REPO[String(ticket).split("-")[0]] || "other";
const teamFor = (ticket) => String(ticket).split("-")[0];

async function readJSON(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}
// Cheap async existence check (replaces existsSync — no blocking stat).
async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// CTL-928: read a `claude --bg` job's durable state from
// ~/.claude/jobs/<bgJobId>/state.json. Returns { state, firstTerminalAt } — the
// two fields bgJobLifecycle needs — or null when the job dir/file is gone
// (worker process no longer exists). An UNREADABLE-but-present state.json yields
// { state: null, firstTerminalAt: null }, which bgJobLifecycle treats as "alive"
// (dir existence still proves the process is up — same fail-open as recovery.mjs).
// Fail-open everywhere: a missing bg_job_id or any error never throws. Exported
// so the CTL-928 liveness read is unit-testable against a temp jobs dir via the
// CATALYST_REVIVE_JOBS_DIR override (set before import — JOBS_DIR is read once).
export async function readBgJobState(bgJobId) {
  if (!bgJobId) return null;
  const root = jobsRoot();
  const file = join(root, bgJobId, "state.json");
  // The dir/file being gone is the death signal — distinguish it from a present
  // dir whose state.json is merely unparseable.
  if (!(await exists(file))) {
    // The file may be absent while the dir still exists (job up, state not yet
    // written). Treat a present dir as alive; a gone dir as dead.
    return (await exists(join(root, bgJobId))) ? { state: null, firstTerminalAt: null } : null;
  }
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return { state: parsed?.state ?? null, firstTerminalAt: parsed?.firstTerminalAt ?? null };
  } catch {
    // Present but unreadable — dir existence still proves liveness.
    return { state: null, firstTerminalAt: null };
  }
}

// CTL-928: a worker maps to a ticket:phase via `claude agents --json`, but the
// durable bg_job_id lives on the phase SIGNAL (phase-<phase>.json `.bg_job_id`).
// Resolve it so the board can read the worker's bg-job state. Returns the raw
// bg_job_id string or null (no signal / no bg_job_id) — null then flows to
// readBgJobState → null → bgJobLifecycle "dead-gone" only if the job dir is also
// absent, so an as-yet-unstamped signal does not falsely kill a live worker
// (readBgJobState falls open on a present dir; a null id with no dir is dead).
async function workerBgJobId(ticket, phase) {
  const sig = await readJSON(join(WORKERS_DIR, ticket, `phase-${phase}.json`));
  return sig?.bg_job_id ?? sig?.bgJobId ?? null;
}

// ── live workers via `claude agents --json` ─────────────────────────────────
async function liveAgents() {
  try {
    const { stdout } = await execFileP("claude", ["agents", "--json"], {
      encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    return [];
  }
}

// "o-CTL-680:CTL-680:verify:1" → {orch, ticket, phase, cont}; also "CTL-680 verify"
function parseAgentName(name = "") {
  let m = /^o-([^:]+):([^:]+):([^:]+):(\d+)$/.exec(name);
  if (m) return { orch: m[1], ticket: m[2], phase: m[3], cont: Number(m[4]) };
  m = /^([A-Z]+-\d+)\s+([a-z-]+)$/.exec(name);
  if (m) return { orch: m[1], ticket: m[1], phase: m[2], cont: 1 };
  return null;
}

// ── real activity signal (transcript freshness, not claude's busy bit) ──
const WORKING_MS = 45_000;     // transcript touched within 45s → generating right now
const STUCK_MS = 1_800_000;    // no transcript activity for 30m → likely abandoned/zombie

// CTL-733: a session's transcript path is stable once it exists, so memoize the
// (expensive) ~1.5k-project-dir scan. Only cache HITS — a brand-new worker whose
// transcript dir is created after a miss must still be found on a later pass.
const _transcriptPathCache = new Map(); // sessionId -> absolute path

// CTL-887 (BFF5): cache-only peek so the live-tail SSE endpoint resolves a
// running worker's transcript without ever triggering the ~1.5k-dir scan —
// board assembly has already populated the cache for every live session.
// Returns the cached absolute path, or null on a miss (the caller decides
// whether a single fallback scan is warranted).
export function peekTranscriptCache(sessionId) {
  if (!sessionId) return null;
  return _transcriptPathCache.get(sessionId) ?? null;
}

export async function resolveTranscript(sessionId) {
  if (!sessionId) return null;
  const cached = _transcriptPathCache.get(sessionId);
  if (cached) return cached;
  const projectsDir = join(HOME, ".claude", "projects");
  let entries;
  try { entries = await readdir(projectsDir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = join(projectsDir, e.name, `${sessionId}.jsonl`);
    if (await exists(candidate)) {
      _transcriptPathCache.set(sessionId, candidate);
      return candidate;
    }
  }
  return null;
}

// Newest transcript activity for a session = min age across the session's own
// transcript AND any sub-agent transcripts (a worker mid sub-agent fan-out keeps
// the parent turn busy while the parent .jsonl briefly goes stale — CTL-662).
async function transcriptAgeMs(sessionId, now) {
  if (!sessionId) return null;
  const file = await resolveTranscript(sessionId);
  if (!file) return null;
  const mtime = async (p) => { try { return (await stat(p)).mtimeMs; } catch { return 0; } };
  let newest = await mtime(file);
  const subDir = join(dirname(file), sessionId, "subagents");
  try {
    const subs = (await readdir(subDir)).filter((f) => f.endsWith(".jsonl"));
    const ages = await Promise.all(subs.map((f) => mtime(join(subDir, f))));
    for (const a of ages) newest = Math.max(newest, a);
  } catch { /* no subagents dir */ }
  return newest ? Math.max(0, now - newest) : null;
}

// CTL-928 — classify a worker's top-level liveness from the DURABLE bg-job state
// FIRST, transcript age second. A signal file that says `running` is NOT proof of
// life (the 2026-06-09 evidence: 7 signals said running, the durable job states
// said 0 working). `jobState` is the worker's bg-job state.json read (or null),
// passed in (read at the edge) so this stays pure-ish and testable.
//
//   "dead"   — the bg job reached a terminal lifecycle (stopped/failed/done/
//              blocked) OR its job dir is gone. Definitive death — a transcript
//              touched 8 minutes ago does NOT resurrect it. EXCLUDED from
//              in-flight / consumed capacity by the caller.
//   "stuck"  — bg job still alive (or its liveness is unknowable) but a terminal
//              marker file is present, or the transcript has been silent ~30m
//              (likely zombie/abandoned, not yet reaped).
//   "active" — alive and recently generating / legitimately event-waiting.
//
// `bgKnown` distinguishes "we positively read a bg-job state" (then a dead verdict
// is trustworthy) from "no bg_job_id resolvable" (legacy/just-dispatched worker —
// fall back to transcript age rather than fabricate death, matching the daemon's
// classifyWorker "unknown" handling).
export async function deriveActiveState(ticket, phase, ageMs, jobState, bgKnown) {
  // Durable death wins over everything — but only when we actually read a bg-job
  // state (bgKnown). Without a resolvable bg_job_id we cannot prove death, so we
  // do NOT mark a live `claude agents` worker dead on a missing id alone.
  if (bgKnown && isBgJobDead(jobState)) return "dead";
  const dir = join(WORKERS_DIR, ticket);
  if ((await exists(join(dir, ".terminal-done.applied"))) || (await exists(join(dir, ".worktree-removed")))) return "stuck";
  // monitor-merge / monitor-deploy / pr legitimately sit in long event-waits
  // (CI, merge, deploy) — staleness alone isn't stuck for them.
  const waitHeavy = phase === "monitor-merge" || phase === "monitor-deploy" || phase === "pr";
  if (!waitHeavy && ageMs != null && ageMs > STUCK_MS) return "stuck";
  return "active";
}

// isWorkerDead — CTL-928 single predicate the in-flight/capacity buckets use to
// decide whether a live `claude agents` worker is actually a corpse. True iff its
// derived activeState is "dead". A dead worker is excluded from ticketIds,
// inFlight, freeSlots, and the "active" config count.
export function isWorkerDead(worker) {
  return worker?.activeState === "dead";
}

// deriveCapacity — CTL-928 PURE capacity summary over the assembled worker set,
// so the freeSlots/inFlight fix is unit-testable without shelling out. Dead
// bg-workers are EXCLUDED from inFlight and freeSlots (they no longer hold a
// maxParallel slot) and surfaced as their own `dead` count. `workers` is the
// full BoardWorker[] (live + dead); `maxParallel` the configured ceiling.
export function deriveCapacity(workers, maxParallel) {
  const all = Array.isArray(workers) ? workers : [];
  const live = all.filter((w) => !isWorkerDead(w));
  return {
    maxParallel,
    inFlight: live.length,
    freeSlots: Math.max(0, maxParallel - live.length),
    active: live.filter((w) => w.activeState === "active").length,
    working: live.filter((w) => w.working).length,
    stuck: live.filter((w) => w.activeState === "stuck").length,
    dead: all.filter((w) => isWorkerDead(w)).length,
  };
}

// laneFor — CTL-928 single source of truth for which board lane a non-queued
// ticket belongs to, so every non-terminal ticket lands in EXACTLY one lane and
// none is silently dropped. PURE + exported for unit tests.
//   "live"           — a live (non-dead) worker is attached. workerStatus is set
//                      AND its activeState is not "dead".
//   "recent-done"    — no live worker AND the ticket's current phase is the
//                      synthetic pipeline-done phase (monitor-deploy/teardown
//                      terminal, per deriveCurrentPhase). Genuinely finished.
//   "between-phases" — no live worker AND a terminal INTERMEDIATE phase (triage/
//                      research/plan/verify/review… done, or a dead worker whose
//                      phase never reached pipeline-done). Idle, awaiting its next
//                      dispatch — visible, not dropped (the invisible-ticket bug).
// A ticket with a non-terminal status and no live worker (a dead-but-running
// signal) also lands in between-phases — it is in-flight-on-paper but idle in
// reality, and must be surfaced rather than vanish.
export function laneFor(ticket) {
  const hasLiveWorker = ticket.workerStatus !== null && ticket.activeState !== "dead";
  if (hasLiveWorker) return "live";
  if (ticket.phase === PIPELINE_DONE_PHASE) return "recent-done";
  return "between-phases";
}

// ── derive a ticket's current phase + status from its signal files ──────────
// Takes the pre-read phase signals (PHASE_ORDER-aligned) to avoid re-reading.
// Exported (like buildPhaseSummary) so it is unit-testable (CTL-745).
export function deriveCurrentPhase(phaseSigs) {
  let lastTerminal = null;
  let lastTerminalIndex = -1;
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    const sig = phaseSigs[i];
    if (!sig) continue;
    const phase = PHASE_ORDER[i];
    const status = sig.status || "unknown";
    if (!TERMINAL.has(status)) {
      return { phase, status, model: sig.model || null, startedAt: sig.startedAt, updatedAt: sig.updatedAt };
    }
    lastTerminal = { phase, status, model: sig.model || null, startedAt: sig.startedAt, updatedAt: sig.updatedAt };
    lastTerminalIndex = i;
  }
  // No phase has written a signal file yet → pre-pipeline. Surface the first
  // column (Research), never Done (CTL-745).
  if (!lastTerminal) return { phase: PHASE_ORDER[0], status: "unknown", model: null };
  // A failed/stalled phase always surfaces at its own column, wherever it sits.
  if (lastTerminal.status === "failed" || lastTerminal.status === "stalled") return lastTerminal;
  // CTL-745: the pipeline is genuinely "done" ONLY when its FINAL phase
  // (monitor-deploy) has reached a terminal status. The loop skips absent signal
  // files (`if (!sig) continue`), so reaching the end with a terminal mid-pipeline
  // phase (e.g. verify.done) does NOT mean the pipeline finished — the next
  // phase's signal file simply hasn't been written yet. Synthesizing "done" here
  // jumped the card to the Done column while the ticket was still at Validate.
  // Surface the real last phase instead so the column matches true progress.
  if (lastTerminalIndex === PHASE_ORDER.length - 1) {
    return { phase: "done", status: "done", model: lastTerminal.model };
  }
  return lastTerminal;
}

// ── per-entity node attribution (CTL-922 / BFF10) ────────────────────────────
// Every BoardTicket / BoardWorker / BoardQueueItem carries its owning
// host:{name,id} so the node-aware surfaces (BOARD3 host swimlanes, SURF1 worker
// node group, SURF2 queue node column) bind to a real field, and a per-entity
// `generation` so the fence-aware web mutations (BFF8 stop, HOME5 unblock) can
// pass a real value to isFenceCurrent without a live attachment fetch.
//
// SINGLE-HOST IDENTITY NO-OP: with one node, every entity resolves to that one
// host through this SAME code path — there is no separate cluster branch. A
// multi-node fleet simply yields different hosts per entity from the same
// derivation, with zero added latency or chrome.

// hostRefFromName — build a {name,id} HostRef from a bare host NAME, deriving the
// id as sha256(name)[:16] — the canonical host-id shape shared by the bash
// (lib/host-identity.sh), mjs (execution-core/lib/host-identity.mjs), and ts
// (lib/canonical-event-shared.ts::hostId) primitives, so a name resolved from
// the fence projection yields the identical id those producers stamp. null/empty
// name → null (no host attribution rather than a fabricated id).
export function hostRefFromName(name) {
  if (typeof name !== "string" || name.length === 0) return null;
  return { name, id: createHash("sha256").update(name).digest("hex").slice(0, 16) };
}

// deriveHost — resolve a {name,id} HostRef for an entity. Precedence:
//   1. the active phase signal's `host:{name,id}` (CTL-852, stamped at dispatch
//      by phase-agent-dispatch) — the live, full ref.
//   2. the durable fence projection owner_host (BFF11 / CTL-923), a host NAME —
//      its {name,id} is derived via hostRefFromName.
// Returns null when neither source names a host. `fence` is the linfo entry for
// the ticket ({ ownerHost } among other fields), already read from the durable
// cache — NEVER a live attachment fetch.
export function deriveHost(phaseSigs, fence = {}) {
  // Walk phase signals using the SAME precedence as deriveCurrentPhase (the
  // active non-terminal phase first, else the latest terminal phase that has a
  // host) so the host tracks the entity's current owner.
  const sigHost = currentSignalHost(phaseSigs);
  if (sigHost && typeof sigHost.name === "string" && sigHost.name.length > 0) {
    return {
      name: sigHost.name,
      // the dispatch signal already carries the canonical id; only derive it if
      // a malformed signal somehow omitted it.
      id:
        typeof sigHost.id === "string" && sigHost.id.length > 0
          ? sigHost.id
          : (hostRefFromName(sigHost.name)?.id ?? null),
    };
  }
  return hostRefFromName(fence?.ownerHost ?? null);
}

// currentSignalHost — the `host` object off the phase signal that deriveCurrentPhase
// would surface (active non-terminal phase, else the most-recent terminal one
// that carries a host). Internal helper — pure, no I/O.
function currentSignalHost(phaseSigs) {
  let lastTerminalHost = null;
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    const sig = phaseSigs[i];
    if (!sig) continue;
    const status = sig.status || "unknown";
    if (!TERMINAL.has(status)) return sig.host ?? null; // active phase wins
    if (sig.host) lastTerminalHost = sig.host;
  }
  return lastTerminalHost;
}

// deriveGeneration — the fence generation for an entity. Precedence: the durable
// fence projection generation (BFF11 / CTL-923, the value the web mutations pass
// to isFenceCurrent) first, then the phase signal `generation` (stamped by
// phase-agent-dispatch). null when neither carries it. A literal 0 is a valid
// generation and must NOT be coerced to null (hence the typeof guard).
export function deriveGeneration(phaseSigs, fence = {}) {
  if (typeof fence?.generation === "number") return fence.generation;
  for (let i = 0; i < PHASE_ORDER.length; i++) {
    const sig = phaseSigs[i];
    if (!sig) continue;
    const status = sig.status || "unknown";
    if (!TERMINAL.has(status)) {
      return typeof sig.generation === "number" ? sig.generation : null;
    }
  }
  // No active phase signal — fall back to the latest signal that carries one.
  for (let i = PHASE_ORDER.length - 1; i >= 0; i--) {
    const sig = phaseSigs[i];
    if (sig && typeof sig.generation === "number") return sig.generation;
  }
  return null;
}

// CTL-754: per-phase timing for the board progression strip. Pure + exported so
// it is unit-testable (assembleBoard itself is not — WORKERS_DIR is a homedir
// const and it shells out to `claude agents`). `now` is passed in for the same
// reason. Terminal phases without a completedAt yield null (unknown), not a
// now-anchored runaway duration.
export function buildPhaseSummary(phaseSigs, now) {
  return phaseSigs
    .map((sig, i) => {
      if (!sig || !sig.startedAt) return null;
      const start = Date.parse(sig.startedAt);
      if (!Number.isFinite(start)) return null;
      let end = null;
      if (sig.completedAt) {
        const c = Date.parse(sig.completedAt);
        end = Number.isFinite(c) ? c : null;
      } else if (!TERMINAL.has(sig.status)) {
        end = now;
      }
      // A clock-skewed or re-walk-rewritten completedAt earlier than startedAt
      // would yield a NEGATIVE duration, which fmtDuration renders as an empty
      // string — visually identical to a healthy phase, laundering corrupt
      // timing as clean. Collapse end < start to null (the existing "unknown"
      // convention) so it is not silently swallowed (CTL-754).
      const durationMs = end != null && end >= start ? end - start : null;
      // Surface raw timestamps; normalize absent/unparseable completedAt to null
      // so consumers get a clean string-or-null signal (CTL-734).
      const rawCompleted = sig.completedAt ?? null;
      const completedAt =
        rawCompleted != null && Number.isFinite(Date.parse(rawCompleted))
          ? rawCompleted
          : null;
      return {
        phase: PHASE_ORDER[i],
        status: sig.status,
        durationMs,
        startedAt: sig.startedAt ?? null,
        completedAt,
        // CTL-888 (BFF6) P5: surface the per-phase model. sig.model is already
        // read into deriveCurrentPhase's intermediate but was dropped here — the
        // ticket spine + gantt render ◆sonnet/◆opus per node off this field.
        // Normalize absent to null so consumers get a clean string-or-null signal.
        model: sig.model ?? null,
      };
    })
    .filter(Boolean);
}

function ticketUpdatedAt(phaseSigs) {
  let max = "";
  for (const sig of phaseSigs) {
    const u = sig?.updatedAt || sig?.completedAt || "";
    if (u > max) max = u;
  }
  return max;
}

function ticketTitle(ticket, triage, eligibleIndex) {
  if (triage && (triage.title || triage.summary)) return triage.title || triage.summary;
  if (eligibleIndex[ticket]?.title) return eligibleIndex[ticket].title;
  return ticket;
}
const ticketType = (triage) => triage?.classification || triage?.type || "task";
// CTL-755: the scraped dependency ids triage recorded (flat string[] or rich
// [{id}] — readTriageDependencies in the scheduler tolerates both, so we do too).
// Surfaced as the held card's `blockers` so a `blocked` chip can name WHAT it is
// waiting on, without the board taking on a second (event-log) data source.
const ticketBlockers = (triage) =>
  (Array.isArray(triage?.dependencies) ? triage.dependencies : [])
    .map((d) => (typeof d === "string" ? d : d?.id))
    .filter(Boolean);
// triage's coarse size estimate (xs/small/medium/large/xl) — present once a
// ticket has been triaged; the closest thing to a Linear estimate for CTL.
const ticketScope = (triage) => triage?.estimated_scope || null;

function prFor(prSigs) {
  for (const sig of prSigs) {
    if (sig?.pr?.number) return sig.pr.number;
  }
  return null;
}

// ── Linear enrichment: priority / estimate / project / labels / relations /
// assignee, read EXCLUSIVELY from the broker's durable caches (CTL-883).
//
// This used to shell out to `linearis issues list --team <T>` on a 60s TTL —
// every refresh counted against Linear's 2500/hr quota and could synchronously
// block the assemble. That bypass is GONE. Enrichment now comes from
// filter-state.db → ticket_state (the broker's webhook write-through) plus the
// scheduler's eligible projections, via lib/linear-cache-reader.mjs::
// readLinearCache. No request path triggers a synchronous Linear call, and the
// Linear circuit breaker is honored by construction (nothing is spawned).
async function linearInfo() {
  return readLinearCache();
}

// ── cost rollup per ticket (one grouped sqlite query) ───────────────────────
async function costByTicket() {
  const map = {};
  if (!(await exists(DB))) return map;
  try {
    const sql =
      "SELECT s.ticket_key, ROUND(COALESCE(SUM(m.cost_usd),0),2), " +
      "COALESCE(SUM(m.input_tokens+m.output_tokens),0) " +
      "FROM sessions s JOIN session_metrics m ON m.session_id=s.session_id " +
      "WHERE s.ticket_key IS NOT NULL GROUP BY s.ticket_key;";
    const { stdout } = await execFileP("sqlite3", ["-separator", "\t", DB, sql], {
      encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const [tk, cost, tokens] = line.split("\t");
      map[tk] = { costUSD: Number(cost) || 0, tokens: Number(tokens) || 0 };
    }
  } catch { /* sqlite missing — costs default to 0 */ }
  return map;
}

// ── cost + turns rollup per ticket per phase ─────────────────────────────────
async function costByPhase() {
  const map = {};
  if (!(await exists(DB))) return map;
  try {
    const sql =
      "SELECT s.ticket_key, s.skill_name, ROUND(COALESCE(SUM(m.cost_usd),0),4), " +
      "COALESCE(SUM(m.input_tokens+m.output_tokens),0), COALESCE(SUM(m.num_turns),0) " +
      "FROM sessions s JOIN session_metrics m ON m.session_id=s.session_id " +
      "WHERE s.ticket_key IS NOT NULL AND s.skill_name LIKE 'phase-%' " +
      "GROUP BY s.ticket_key, s.skill_name;";
    const { stdout } = await execFileP("sqlite3", ["-separator", "\t", DB, sql], {
      encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const [tk, skill, cost, tokens, turns] = line.split("\t");
      const phase = skill.replace(/^phase-/, "");
      if (!map[tk]) map[tk] = {};
      map[tk][phase] = {
        costUSD: Number(cost) || 0,
        tokens: Number(tokens) || 0,
        turns: Number(turns) || 0,
      };
    }
  } catch { /* sqlite missing or schema pre-migration */ }
  return map;
}

// ── CC-UUID → catalyst sess_ id map (CTL-888 / BFF6 P7) ─────────────────────
// Two disjoint id spaces ride the worker: the CC-UUID (`claude agents --json
// .sessionId`, keys Prometheus/Loki claude-code streams) and the catalyst
// `sess_…` id (keys the catalyst.session/phase-agent heartbeat streams). The
// catalyst id lives only in catalyst.db `sessions.session_id`, joinable to the
// CC-UUID we already hold via `sessions.claude_session_id`. Build the map once
// so the worker assembly can surface BOTH ids. Fail-open: a missing db / column
// yields an empty map and `catalystSessionId` stays null (never fabricated).
async function catalystSessionByCcUuid() {
  const map = {};
  if (!(await exists(DB))) return map;
  try {
    const sql =
      "SELECT claude_session_id, session_id FROM sessions " +
      "WHERE claude_session_id IS NOT NULL AND claude_session_id <> '';";
    const { stdout } = await execFileP("sqlite3", ["-separator", "\t", DB, sql], {
      encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const [ccUuid, sessId] = line.split("\t");
      // Last write wins — a CC-UUID maps to a single catalyst session.
      if (ccUuid && sessId) map[ccUuid] = sessId;
    }
  } catch { /* sqlite missing or pre-CTL-374 schema (no claude_session_id) */ }
  return map;
}

// ── ranked eligible queue (mirrors scheduler-rank.mjs compareTickets) ───────
const PRIORITY_RANK = (p) => (p && p >= 1 && p <= 4 ? p : 5); // 1=urgent..4=low, 0/none→5
function compareQueued(a, b) {
  const dp = PRIORITY_RANK(a.priority) - PRIORITY_RANK(b.priority);
  if (dp !== 0) return dp;                       // priority asc (urgent first)
  const ca = a.createdAt || "", cb = b.createdAt || "";
  if (ca !== cb) return ca < cb ? -1 : 1;        // FIFO
  return String(a.id).localeCompare(String(b.id));
}

async function loadEligible() {
  const out = [];
  if (!(await exists(ELIGIBLE_DIR))) return out;
  let files;
  try { files = await readdir(ELIGIBLE_DIR); } catch { return out; }
  const raws = await Promise.all(
    files.filter((f) => f.endsWith(".json")).map((f) => readJSON(join(ELIGIBLE_DIR, f))),
  );
  for (const raw of raws) {
    const arr = Array.isArray(raw) ? raw : raw?.tickets || [];
    for (const t of arr) {
      const id = t.identifier || t.id;
      if (!id) continue;
      out.push({
        id, title: t.title || id, priority: t.priority ?? 0,
        createdAt: t.createdAt || "", state: t.state || null,
        repo: repoFor(id), team: teamFor(id),
      });
    }
  }
  return out;
}

async function maxParallel() {
  const [l2, l1] = await Promise.all([
    readJSON(join(HOME, ".config", "catalyst", "config.json")),
    readJSON(join(process.cwd(), ".catalyst", "config.json")),
  ]);
  const pick = (c) => c?.catalyst?.orchestration?.executionCore?.maxParallel
    ?? c?.orchestration?.executionCore?.maxParallel;
  return pick(l2) ?? pick(l1) ?? 6;
}

// Read a ticket's worker-dir artifacts once (phase signals + triage + PR signals).
async function readTicketArtifacts(id) {
  const dir = join(WORKERS_DIR, id);
  if (!(await exists(dir))) return { phaseSigs: [], triage: null, prSigs: [] };
  const [phaseSigs, triage, prSigs] = await Promise.all([
    Promise.all(PHASE_ORDER.map((p) => readJSON(join(dir, `phase-${p}.json`)))),
    readJSON(join(dir, "triage.json")),
    Promise.all(["phase-pr.json", "phase-monitor-merge.json", "phase-monitor-deploy.json"]
      .map((f) => readJSON(join(dir, f)))),
  ]);
  return { phaseSigs, triage, prSigs };
}

// CTL-922 (BFF10): read a single worker's own phase signal, positioned into a
// PHASE_ORDER-aligned sparse array so deriveHost / deriveGeneration walk it the
// same way they walk a full ticket's signals. A live worker's phase is
// non-terminal, so its host/generation surface as the active phase. Returns []
// (no host attribution) when the signal is absent — never blocks.
async function readWorkerPhaseSignals(ticket, phase) {
  const sig = await readJSON(join(WORKERS_DIR, ticket, `phase-${phase}.json`));
  if (!sig) return [];
  const i = PHASE_ORDER.indexOf(phase);
  if (i < 0) return [];
  const sigs = PHASE_ORDER.map(() => null);
  sigs[i] = sig;
  return sigs;
}

// ── main assembly ───────────────────────────────────────────────────────────
export async function assembleBoard() {
  const [agents, costs, phaseCostsByTicket, eligible, linfo, mp, catalystSessByUuid] = await Promise.all([
    liveAgents(), costByTicket(), costByPhase(), loadEligible(), linearInfo(), maxParallel(),
    catalystSessionByCcUuid(),
  ]);
  const eligibleIndex = Object.fromEntries(eligible.map((e) => [e.id, e]));

  // workers (live background agents that map to a ticket:phase)
  const now = Date.now();
  const parsed = agents
    .filter((a) => a.kind === "background")
    .map((a) => ({ a, p: parseAgentName(a.name) }))
    .filter(({ p }) => p);
  const workers = await Promise.all(parsed.map(async ({ a, p }) => {
    const runtimeMs = a.startedAt ? now - a.startedAt : null;
    // null (not 0) when there is no metrics row — distinguishes "no data" from "free".
    const cost = costs[p.ticket]?.costUSD ?? null;
    const lastActiveMs = await transcriptAgeMs(a.sessionId, now);
    // CTL-928: resolve the worker's DURABLE bg-job state before classifying. The
    // bg_job_id lives on the phase signal; the state lives under ~/.claude/jobs.
    // A null bgJobId means we cannot prove death (bgKnown=false) → fall back to
    // transcript age rather than fabricate a dead verdict.
    const bgJobId = await workerBgJobId(p.ticket, p.phase);
    const jobState = bgJobId ? await readBgJobState(bgJobId) : null;
    const bgKnown = bgJobId != null;
    const activeState = await deriveActiveState(p.ticket, p.phase, lastActiveMs, jobState, bgKnown);
    // A dead bg-job is not "working" however fresh its transcript looks.
    const working = activeState !== "dead" && lastActiveMs != null && lastActiveMs < WORKING_MS; // detail-level only
    // CTL-922 (BFF10): node attribution. host:{name,id} from the worker's own
    // phase signal (CTL-852, dispatch-stamped) falling back to the durable fence
    // projection owner_host (BFF11); generation from the fence projection first,
    // then the signal. SINGLE-HOST: every worker resolves to the one node via
    // this same path — no separate cluster branch, no live attachment fetch.
    const workerSigs = await readWorkerPhaseSignals(p.ticket, p.phase);
    const fence = linfo[p.ticket] ?? {};
    return {
      name: a.name, ticket: p.ticket, tickets: [p.ticket], phase: p.phase,
      status: a.status || "idle", activeState, working, lastActiveMs,
      repo: repoFor(p.ticket), team: teamFor(p.ticket),
      runtimeMs, costUSD: cost, sessionId: a.sessionId,
      // CTL-888 (BFF6) P6: exact wall-clock start (epoch ms from `claude agents
      // --json .startedAt`, the same value runtimeMs derives from) so the worker
      // header can render precise elapsed instead of a floored runtimeMs.
      startedAt: typeof a.startedAt === "number" ? a.startedAt : null,
      // CTL-888 (BFF6) P7: the OS pid (read by `claude agents --json` but
      // previously dropped) drives the worker-rail PID row.
      pid: typeof a.pid === "number" ? a.pid : null,
      // CTL-888 (BFF6) P7: the catalyst `sess_…` id alongside the CC-UUID
      // sessionId — surfaces both id spaces (Loki catalyst.session heartbeat
      // joins on this one). null when the db has no row for this CC-UUID.
      catalystSessionId: catalystSessByUuid[a.sessionId] ?? null,
      // CTL-928: the durable bg-job id this worker's liveness was derived from
      // (from the phase signal). null when no signal carried one — surfaced so the
      // worker rail and the dead-worker capacity logic share one provenance.
      bgJobId,
      // CTL-922 (BFF10): owning host + fence generation (see above).
      host: deriveHost(workerSigs, fence),
      generation: deriveGeneration(workerSigs, fence),
    };
  }));
  // CTL-928: a worker whose durable bg job is dead is NOT in flight. Partition
  // the `claude agents` workers into the live set (real consumed capacity) and the
  // dead set (corpses still listed by `claude agents` / lingering job dirs). Only
  // the live set feeds inFlight, freeSlots, ticketIds, and the "active" count.
  const liveWorkers = workers.filter((w) => !isWorkerDead(w));
  const inFlightTickets = new Map(liveWorkers.map((w) =>
    [w.ticket, { phase: w.phase, status: w.status, activeState: w.activeState, working: w.working, lastActiveMs: w.lastActiveMs }]));

  // tickets = in-flight (have a LIVE worker dir / live agent) ∪ eligible(queued).
  // CTL-928: a workers/<T>/ dir whose latest signal is a terminal INTERMEDIATE
  // phase with NO live worker is between-phases — it still gets a card (read via
  // its dir below), but it must NOT count toward in-flight capacity, so we exclude
  // dead-bg worker TICKETS from the in-flight `ticketIds` (used only for the
  // queue's notInFlight exclusion). Worker dirs remain a card source via tickets.
  let workerDirs = [];
  if (await exists(WORKERS_DIR)) {
    try { workerDirs = (await readdir(WORKERS_DIR)).filter((d) => /^[A-Z]+-\d+$/.test(d)); } catch { /* none */ }
  }
  // Every card we render (live workers, dead-worker dirs, plain worker dirs) — the
  // union of card sources, so a between-phases ticket still gets a BoardTicket.
  const cardTicketIds = new Set([...workers.map((w) => w.ticket), ...workerDirs]);

  let tickets = await Promise.all([...cardTicketIds].map(async (id) => {
    const { phaseSigs, triage, prSigs } = await readTicketArtifacts(id);
    const cur = deriveCurrentPhase(phaseSigs);
    const phaseSummary = buildPhaseSummary(phaseSigs, now);
    const live = inFlightTickets.get(id);
    return {
      id, title: ticketTitle(id, triage, eligibleIndex), type: ticketType(triage),
      repo: repoFor(id), team: teamFor(id),
      phase: cur.phase, status: cur.status, model: cur.model,
      linearState: PHASE_TO_LINEAR[cur.phase] || "Research",
      workerStatus: live?.status || null,
      activeState: live?.activeState || null, working: live?.working || false,
      lastActiveMs: live?.lastActiveMs ?? null,
      priority: linfo[id]?.priority ?? 0,
      estimate: linfo[id]?.estimate ?? null, scope: ticketScope(triage),
      project: linfo[id]?.project ?? null,
      // CTL-755 held indicator: "blocked" | "waiting" | null, read from the
      // ticket's Linear labels (the scheduler's admission gate writes them).
      // `blockers` names the dependencies a `blocked` hold is waiting on (only
      // meaningful when held === "blocked"); empty otherwise.
      held: heldFor(linfo[id]?.labels),
      blockers: ticketBlockers(triage),
      // CTL-901 (HOME3): per-row "how long has this needed me / been running"
      // durations, sourced from DURABLE read-model timestamps only — never
      // fabricated. `heldSince` is the applied-at of the held (blocked/waiting)
      // labels, projected into ticket_state by the broker (BFF11 / CTL-923) and
      // surfaced through linear-cache-reader; it is the honest "how long has it
      // been waiting on you" anchor. null when the durable cache has no stamp
      // (an older filter-state.db, or a not-yet-observed hold) → the UI renders
      // the duration cell as unavailable rather than inventing one. Only
      // meaningful while `held` is set; cleared to null on pickup/unblock.
      heldSince: linfo[id]?.heldSince ?? null,
      // The wall-clock start of the ticket's CURRENT phase (deriveCurrentPhase
      // already reads it off the live/last phase signal) — the "how long has it
      // been running / in its current state" anchor for the running set. null
      // when the surfaced phase carried no startedAt (pre-pipeline / corrupt
      // signal) → again rendered unavailable, never now-anchored to a guess.
      currentPhaseSince: cur.startedAt ?? null,
      costUSD: costs[id]?.costUSD ?? null, tokens: costs[id]?.tokens ?? null,
      turns: phaseCostsByTicket[id]
        ? Object.values(phaseCostsByTicket[id]).reduce((s, p) => s + p.turns, 0)
        : null,
      phaseCosts: phaseCostsByTicket[id] ?? null,
      phaseSummary,
      pr: prFor(prSigs),
      updatedAt: ticketUpdatedAt(phaseSigs),
      // CTL-922 (BFF10): node attribution. host:{name,id} from the ticket's phase
      // signals (CTL-852, dispatch-stamped) falling back to the durable fence
      // projection owner_host (BFF11); generation from the fence projection first,
      // then the signal. SINGLE-HOST: resolves to the one node via this same path,
      // no cluster branch, no live attachment fetch.
      host: deriveHost(phaseSigs, linfo[id] ?? {}),
      generation: deriveGeneration(phaseSigs, linfo[id] ?? {}),
    };
  }));

  // CTL-928 lane assembly — every non-queued ticket lands in EXACTLY one lane via
  // laneFor (the single source of truth), so a dead-but-running ticket is never
  // silently dropped and a terminal-intermediate ticket is never mis-bucketed into
  // recent-done. A "between-phases" bucket (the old `moving`) is bounded by recency
  // so a fat workers dir can't render hundreds of cards.
  //   live           — a LIVE worker is attached (dead workers fell out of
  //                    inFlightTickets above, so their tickets are NOT live here).
  //   between-phases — terminal-intermediate / dead-but-running, no live worker:
  //                    idle awaiting its next dispatch. THE FORMERLY-INVISIBLE lane.
  //   recent-done    — genuinely pipeline-done (phase === "done"), a short tail.
  const byRecent = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
  const liveTickets = tickets.filter((t) => laneFor(t) === "live");
  const betweenPhases = tickets
    .filter((t) => laneFor(t) === "between-phases")
    .sort(byRecent)
    .slice(0, 30);
  const recentDone = tickets
    .filter((t) => laneFor(t) === "recent-done")
    .sort(byRecent)
    .slice(0, 12);
  // eligible queue tickets → thin Todo-column board cards (CTL-767). A ticket with
  // ANY worker dir is already surfaced as live / between-phases above, so it is
  // excluded here (cardTicketIds) — it is accounted for, not duplicated.
  const notInFlight = eligible.filter((e) => !cardTicketIds.has(e.id));
  const queuedTickets = notInFlight.map((e) => synthesizeQueuedTicket(e, linfo));
  tickets = [...liveTickets, ...betweenPhases, ...recentDone, ...queuedTickets];

  // priority queue: eligible (not yet in-flight), globally ranked (Queue tab)
  const queue = await Promise.all(notInFlight
    .sort(compareQueued)
    .map(async (e, i) => {
      const { triage } = await readTicketArtifacts(e.id);
      return {
        // `...e` already carries `team` (loadEligible stamps teamFor(id)) — the
        // BoardQueueItem type now declares it so the SURF2 node column / lane
        // grouping can read it (CTL-922 / BFF10).
        ...e, rank: i + 1,
        priority: linfo[e.id]?.priority ?? e.priority ?? 0,
        estimate: linfo[e.id]?.estimate ?? null, scope: ticketScope(triage),
        project: linfo[e.id]?.project ?? e.project ?? null,
        // CTL-922 (BFF10): owning host from the durable fence projection (BFF11);
        // a queued ticket has no phase signal, so [] forces the fence fallback.
        // null when no fence attachment has been observed — never fabricated.
        host: deriveHost([], linfo[e.id] ?? {}),
      };
    }));

  const repos = [...new Set([...workers, ...tickets].map((x) => x.repo))].sort();

  return {
    generatedAt: new Date().toISOString(),
    // CTL-928: capacity reflects LIVE workers only. A dead bg-job no longer holds a
    // maxParallel slot, so inFlight + freeSlots tell the true dispatch picture (e.g.
    // 6 listed, 3 dead → inFlight 3, freeSlots 3). `dead` is surfaced as its own
    // count so the operator sees the corpses without them consuming capacity. The
    // computation lives in the PURE deriveCapacity (unit-tested) — DRY.
    config: deriveCapacity(workers, mp),
    repos,
    workers: workers.sort((a, b) => (a.runtimeMs ?? 0) - (b.runtimeMs ?? 0)),
    tickets,
    queue,
  };
}

// CLI: `bun lib/board-data.mjs` prints the payload (for testing).
if (import.meta.main || process.argv[1]?.endsWith("board-data.mjs")) {
  assembleBoard().then((b) => console.log(JSON.stringify(b, null, 2)));
}
