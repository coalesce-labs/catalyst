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
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const HOME = homedir();
const EC = join(HOME, "catalyst", "execution-core");
const WORKERS_DIR = join(EC, "workers");
const ELIGIBLE_DIR = join(EC, "eligible");
const DB = join(HOME, "catalyst", "catalyst.db");

// Canonical 9-phase pipeline order + which statuses are terminal for a phase.
export const PHASE_ORDER = [
  "triage", "research", "plan", "implement", "verify",
  "review", "pr", "monitor-merge", "monitor-deploy",
];
// Single source of truth for which phase statuses are terminal (no longer
// running). Exported so the UI's PhaseStrip terminal-status list can be guarded
// against drift (board-phase-drift.test.ts) instead of carrying a silent
// hand-copied duplicate (CTL-754).
export const TERMINAL = new Set([
  "done", "failed", "stalled", "skipped", "signal_corrupt", "superseded", "canceled",
]);

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
  triage: "Research", research: "Research", plan: "Plan", implement: "Implement",
  verify: "Validate", review: "Validate", pr: "PR", "monitor-merge": "PR",
  "monitor-deploy": "Done", done: "Done",
};

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
async function resolveTranscript(sessionId) {
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

// Top-level state: a live worker is "active" (in its loop — generating OR actively
// waiting on sub-agents / CI / a merge). Only call out the exceptions: a
// finished-but-lingering process (terminal markers) or one dead for ~30m → "stuck".
async function deriveActiveState(ticket, phase, ageMs) {
  const dir = join(WORKERS_DIR, ticket);
  if ((await exists(join(dir, ".terminal-done.applied"))) || (await exists(join(dir, ".worktree-removed")))) return "stuck";
  // monitor-merge / monitor-deploy / pr legitimately sit in long event-waits
  // (CI, merge, deploy) — staleness alone isn't stuck for them.
  const waitHeavy = phase === "monitor-merge" || phase === "monitor-deploy" || phase === "pr";
  if (!waitHeavy && ageMs != null && ageMs > STUCK_MS) return "stuck";
  return "active";
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
      return {
        phase: PHASE_ORDER[i],
        status: sig.status,
        durationMs,
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

// ── Linear enrichment: priority / estimate / project, one cached list call per
// team (60s TTL) so in-flight + board tickets get priority without per-ticket
// API hits. Graceful: if linearis is unavailable, callers fall back to defaults.
let _linearCache = { ts: 0, byId: {} };
async function linearInfo() {
  const now = Date.now();
  if (now - _linearCache.ts < 60_000) return _linearCache.byId;
  const byId = {};
  await Promise.all(["CTL", "ADV"].map(async (team) => {
    try {
      const { stdout } = await execFileP("linearis", ["issues", "list", "--team", team, "--limit", "100"], {
        encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024,
      });
      for (const n of JSON.parse(stdout)?.nodes || []) {
        if (!n.identifier) continue;
        byId[n.identifier] = {
          priority: typeof n.priority === "number" ? n.priority : 0,
          estimate: n.estimate ?? null,
          project: n.project?.name || (typeof n.project === "string" ? n.project : null),
          // CTL-755: label names for the held indicator (blocked/waiting). The
          // same cached list call already returns labels.nodes[].name, so this
          // costs zero extra Linear traffic.
          labels: (n.labels?.nodes ?? []).map((l) => l?.name).filter(Boolean),
        };
      }
    } catch { /* linearis unavailable — leave this team unenriched */ }
  }));
  _linearCache = { ts: now, byId };
  return byId;
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

// ── main assembly ───────────────────────────────────────────────────────────
export async function assembleBoard() {
  const [agents, costs, phaseCostsByTicket, eligible, linfo, mp] = await Promise.all([
    liveAgents(), costByTicket(), costByPhase(), loadEligible(), linearInfo(), maxParallel(),
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
    const activeState = await deriveActiveState(p.ticket, p.phase, lastActiveMs);
    const working = lastActiveMs != null && lastActiveMs < WORKING_MS; // detail-level only
    return {
      name: a.name, ticket: p.ticket, tickets: [p.ticket], phase: p.phase,
      status: a.status || "idle", activeState, working, lastActiveMs,
      repo: repoFor(p.ticket), team: teamFor(p.ticket),
      runtimeMs, costUSD: cost, sessionId: a.sessionId,
    };
  }));
  const inFlightTickets = new Map(workers.map((w) =>
    [w.ticket, { phase: w.phase, status: w.status, activeState: w.activeState, working: w.working, lastActiveMs: w.lastActiveMs }]));

  // tickets = in-flight (have a worker dir / live agent) ∪ eligible(queued)
  let workerDirs = [];
  if (await exists(WORKERS_DIR)) {
    try { workerDirs = (await readdir(WORKERS_DIR)).filter((d) => /^[A-Z]+-\d+$/.test(d)); } catch { /* none */ }
  }
  const ticketIds = new Set([...workers.map((w) => w.ticket), ...workerDirs]);

  let tickets = await Promise.all([...ticketIds].map(async (id) => {
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
      costUSD: costs[id]?.costUSD ?? null, tokens: costs[id]?.tokens ?? null,
      turns: phaseCostsByTicket[id]
        ? Object.values(phaseCostsByTicket[id]).reduce((s, p) => s + p.turns, 0)
        : null,
      phaseCosts: phaseCostsByTicket[id] ?? null,
      phaseSummary,
      pr: prFor(prSigs),
      updatedAt: ticketUpdatedAt(phaseSigs),
    };
  }));

  // Keep the board legible: live workers + recently-touched moving tickets +
  // a recent-done tail. A "moving" signal that's actually stale (dead worker,
  // old non-terminal signal) is bounded by recency so a fat workers dir can't
  // render hundreds of cards.
  const byRecent = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
  const liveTickets = tickets.filter((t) => t.workerStatus !== null);
  const moving = tickets
    .filter((t) => t.workerStatus === null && t.status !== "done")
    .sort(byRecent)
    .slice(0, 30);
  const recentDone = tickets
    .filter((t) => t.workerStatus === null && t.status === "done")
    .sort(byRecent)
    .slice(0, 12);
  tickets = [...liveTickets, ...moving, ...recentDone];

  // priority queue: eligible (not yet in-flight), globally ranked
  const queue = await Promise.all(eligible
    .filter((e) => !ticketIds.has(e.id))
    .sort(compareQueued)
    .map(async (e, i) => {
      const { triage } = await readTicketArtifacts(e.id);
      return {
        ...e, rank: i + 1,
        priority: linfo[e.id]?.priority ?? e.priority ?? 0,
        estimate: linfo[e.id]?.estimate ?? null, scope: ticketScope(triage),
        project: linfo[e.id]?.project ?? e.project ?? null,
      };
    }));

  const repos = [...new Set([...workers, ...tickets].map((x) => x.repo))].sort();

  return {
    generatedAt: new Date().toISOString(),
    config: {
      maxParallel: mp, inFlight: workers.length, freeSlots: Math.max(0, mp - workers.length),
      active: workers.filter((w) => w.activeState === "active").length,
      working: workers.filter((w) => w.working).length,
      stuck: workers.filter((w) => w.activeState === "stuck").length,
    },
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
