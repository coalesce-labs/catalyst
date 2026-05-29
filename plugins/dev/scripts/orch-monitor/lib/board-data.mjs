// board-data.mjs — assembles the live "Worker/Ticket board" payload (CTL-727).
//
// Single source of board state for the new monitor UI, built from the stateless
// execution-core surfaces (no long-running orchestrator required):
//   • `claude agents --json`                         → live workers + status
//   • ~/catalyst/execution-core/workers/<T>/phase-*.json → per-ticket phase/status
//   • ~/catalyst/execution-core/eligible/<TEAM>.json → ranked priority queue
//   • ~/catalyst/catalyst.db (sessions ⋈ session_metrics) → cost rollup per ticket
//
// Pure-ish: one exported assembleBoard() that shells out + reads disk and returns
// a plain JSON object. Reused by the Vite dev middleware today and a real HTTP
// route when we productize.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { findTranscript } from "../../execution-core/session-recency.mjs";

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
const TERMINAL = new Set([
  "done", "failed", "stalled", "skipped", "signal_corrupt", "superseded", "canceled",
]);

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

function readJSON(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

// ── live workers via `claude agents --json` ─────────────────────────────────
function liveAgents() {
  try {
    const out = execFileSync("claude", ["agents", "--json"], {
      encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(out);
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

// Newest transcript activity for a session = min age across the session's own
// transcript AND any sub-agent transcripts (a worker mid sub-agent fan-out keeps
// the parent turn busy while the parent .jsonl briefly goes stale — CTL-662).
function transcriptAgeMs(sessionId, now) {
  if (!sessionId) return null;
  const file = findTranscript(sessionId, join(HOME, ".claude", "projects"));
  if (!file) return null;
  const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
  let newest = mtime(file);
  const subDir = join(dirname(file), sessionId, "subagents");
  try {
    for (const f of readdirSync(subDir)) {
      if (f.endsWith(".jsonl")) newest = Math.max(newest, mtime(join(subDir, f)));
    }
  } catch { /* no subagents dir */ }
  return newest ? Math.max(0, now - newest) : null;
}

// Top-level state: a live worker is "active" (in its loop — generating OR actively
// waiting on sub-agents / CI / a merge). Only call out the exceptions: a
// finished-but-lingering process (terminal markers) or one dead for ~30m → "stuck".
function deriveActiveState(ticket, phase, ageMs) {
  const dir = join(WORKERS_DIR, ticket);
  if (existsSync(join(dir, ".terminal-done.applied")) || existsSync(join(dir, ".worktree-removed"))) return "stuck";
  // monitor-merge / monitor-deploy / pr legitimately sit in long event-waits
  // (CI, merge, deploy) — staleness alone isn't stuck for them.
  const waitHeavy = phase === "monitor-merge" || phase === "monitor-deploy" || phase === "pr";
  if (!waitHeavy && ageMs != null && ageMs > STUCK_MS) return "stuck";
  return "active";
}

// ── derive a ticket's current phase + status from its signal files ──────────
function deriveCurrentPhase(ticket) {
  const dir = join(WORKERS_DIR, ticket);
  if (!existsSync(dir)) return null;
  let lastTerminal = null;
  for (const phase of PHASE_ORDER) {
    const sig = readJSON(join(dir, `phase-${phase}.json`));
    if (!sig) continue;
    const status = sig.status || "unknown";
    if (!TERMINAL.has(status)) {
      return { phase, status, model: sig.model || null, startedAt: sig.startedAt, updatedAt: sig.updatedAt };
    }
    lastTerminal = { phase, status, model: sig.model || null, startedAt: sig.startedAt, updatedAt: sig.updatedAt };
  }
  // all phases terminal → if the last one failed/stalled surface that, else done
  if (lastTerminal && (lastTerminal.status === "failed" || lastTerminal.status === "stalled"))
    return lastTerminal;
  return { phase: "done", status: "done", model: lastTerminal?.model || null };
}

function ticketUpdatedAt(ticket) {
  const dir = join(WORKERS_DIR, ticket);
  if (!existsSync(dir)) return "";
  let max = "";
  for (const phase of PHASE_ORDER) {
    const sig = readJSON(join(dir, `phase-${phase}.json`));
    const u = sig?.updatedAt || sig?.completedAt || "";
    if (u > max) max = u;
  }
  return max;
}

function ticketTitle(ticket, eligibleIndex) {
  const tri = readJSON(join(WORKERS_DIR, ticket, "triage.json"));
  if (tri && (tri.title || tri.summary)) return tri.title || tri.summary;
  if (eligibleIndex[ticket]?.title) return eligibleIndex[ticket].title;
  return ticket;
}

function ticketType(ticket) {
  const tri = readJSON(join(WORKERS_DIR, ticket, "triage.json"));
  return tri?.classification || tri?.type || "task";
}

// triage's coarse size estimate (xs/small/medium/large/xl) — present once a
// ticket has been triaged; the closest thing to a Linear estimate for CTL.
function ticketScope(ticket) {
  const tri = readJSON(join(WORKERS_DIR, ticket, "triage.json"));
  return tri?.estimated_scope || null;
}

// ── Linear enrichment: priority / estimate / project, one cached list call per
// team (60s TTL) so in-flight + board tickets get priority without per-ticket
// API hits. Graceful: if linearis is unavailable, callers fall back to defaults.
let _linearCache = { ts: 0, byId: {} };
function linearInfo() {
  const now = Date.now();
  if (now - _linearCache.ts < 60_000) return _linearCache.byId;
  const byId = {};
  for (const team of ["CTL", "ADV"]) {
    try {
      const out = execFileSync("linearis", ["issues", "list", "--team", team, "--limit", "100"], {
        encoding: "utf8", timeout: 15000, maxBuffer: 16 * 1024 * 1024,
      });
      for (const n of JSON.parse(out)?.nodes || []) {
        if (!n.identifier) continue;
        byId[n.identifier] = {
          priority: typeof n.priority === "number" ? n.priority : 0,
          estimate: n.estimate ?? null,
          project: n.project?.name || (typeof n.project === "string" ? n.project : null),
        };
      }
    } catch { /* linearis unavailable — leave this team unenriched */ }
  }
  _linearCache = { ts: now, byId };
  return byId;
}

function prFor(ticket) {
  for (const p of ["phase-pr.json", "phase-monitor-merge.json", "phase-monitor-deploy.json"]) {
    const sig = readJSON(join(WORKERS_DIR, ticket, p));
    if (sig?.pr?.number) return sig.pr.number;
  }
  return null;
}

// ── cost rollup per ticket (one grouped sqlite query) ───────────────────────
function costByTicket() {
  const map = {};
  if (!existsSync(DB)) return map;
  try {
    const sql =
      "SELECT s.ticket_key, ROUND(COALESCE(SUM(m.cost_usd),0),2), " +
      "COALESCE(SUM(m.input_tokens+m.output_tokens),0) " +
      "FROM sessions s JOIN session_metrics m ON m.session_id=s.session_id " +
      "WHERE s.ticket_key IS NOT NULL GROUP BY s.ticket_key;";
    const out = execFileSync("sqlite3", ["-separator", "\t", DB, sql], {
      encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024,
    });
    for (const line of out.trim().split("\n")) {
      if (!line) continue;
      const [tk, cost, tokens] = line.split("\t");
      map[tk] = { costUSD: Number(cost) || 0, tokens: Number(tokens) || 0 };
    }
  } catch { /* sqlite missing — costs default to 0 */ }
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

function loadEligible() {
  const out = [];
  if (!existsSync(ELIGIBLE_DIR)) return out;
  for (const f of readdirSync(ELIGIBLE_DIR)) {
    if (!f.endsWith(".json")) continue;
    const raw = readJSON(join(ELIGIBLE_DIR, f));
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

function maxParallel() {
  const l2 = readJSON(join(HOME, ".config", "catalyst", "config.json"));
  const l1 = readJSON(join(process.cwd(), ".catalyst", "config.json"));
  const pick = (c) => c?.catalyst?.orchestration?.executionCore?.maxParallel
    ?? c?.orchestration?.executionCore?.maxParallel;
  return pick(l2) ?? pick(l1) ?? 6;
}

// ── main assembly ───────────────────────────────────────────────────────────
export function assembleBoard() {
  const agents = liveAgents();
  const costs = costByTicket();
  const eligible = loadEligible();
  const eligibleIndex = Object.fromEntries(eligible.map((e) => [e.id, e]));
  const linfo = linearInfo();

  // workers (live background agents that map to a ticket:phase)
  const workers = [];
  const inFlightTickets = new Map(); // ticket -> {status, phase, repo, ...}
  for (const a of agents) {
    if (a.kind !== "background") continue;
    const p = parseAgentName(a.name);
    if (!p) continue;
    const now = Date.now();
    const runtimeMs = a.startedAt ? now - a.startedAt : null;
    // null (not 0) when there is no metrics row — distinguishes "no data" from "free".
    const cost = costs[p.ticket]?.costUSD ?? null;
    const lastActiveMs = transcriptAgeMs(a.sessionId, now);
    const activeState = deriveActiveState(p.ticket, p.phase, lastActiveMs);
    const working = lastActiveMs != null && lastActiveMs < WORKING_MS; // detail-level only
    workers.push({
      name: a.name, ticket: p.ticket, tickets: [p.ticket], phase: p.phase,
      status: a.status || "idle", activeState, working, lastActiveMs,
      repo: repoFor(p.ticket), team: teamFor(p.ticket),
      runtimeMs, costUSD: cost, sessionId: a.sessionId,
    });
    inFlightTickets.set(p.ticket, { phase: p.phase, status: a.status, activeState, working, lastActiveMs });
  }

  // tickets = in-flight (have a worker dir / live agent) ∪ eligible(queued)
  const ticketIds = new Set([
    ...workers.map((w) => w.ticket),
    ...(existsSync(WORKERS_DIR) ? readdirSync(WORKERS_DIR).filter((d) =>
      existsSync(join(WORKERS_DIR, d)) && /^[A-Z]+-\d+$/.test(d)) : []),
  ]);

  let tickets = [];
  for (const id of ticketIds) {
    const cur = deriveCurrentPhase(id) || { phase: "done", status: "done", model: null };
    const live = inFlightTickets.get(id);
    tickets.push({
      id, title: ticketTitle(id, eligibleIndex), type: ticketType(id),
      repo: repoFor(id), team: teamFor(id),
      phase: cur.phase, status: cur.status, model: cur.model,
      linearState: PHASE_TO_LINEAR[cur.phase] || "Research",
      workerStatus: live?.status || null,
      activeState: live?.activeState || null, working: live?.working || false,
      lastActiveMs: live?.lastActiveMs ?? null,
      priority: linfo[id]?.priority ?? 0,
      estimate: linfo[id]?.estimate ?? null, scope: ticketScope(id),
      project: linfo[id]?.project ?? null,
      costUSD: costs[id]?.costUSD ?? null, tokens: costs[id]?.tokens ?? null,
      pr: prFor(id),
      updatedAt: ticketUpdatedAt(id),
    });
  }

  // Keep the board legible: live workers + recently-touched moving tickets +
  // a recent-done tail. A "moving" signal that's actually stale (dead worker,
  // old non-terminal signal) is bounded by recency so a fat workers dir can't
  // render hundreds of cards.
  const byRecent = (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt));
  const live = tickets.filter((t) => t.workerStatus !== null);
  const moving = tickets
    .filter((t) => t.workerStatus === null && t.status !== "done")
    .sort(byRecent)
    .slice(0, 30);
  const recentDone = tickets
    .filter((t) => t.workerStatus === null && t.status === "done")
    .sort(byRecent)
    .slice(0, 12);
  tickets = [...live, ...moving, ...recentDone];

  // priority queue: eligible (not yet in-flight), globally ranked
  const queue = eligible
    .filter((e) => !ticketIds.has(e.id))
    .sort(compareQueued)
    .map((e, i) => ({
      ...e, rank: i + 1,
      priority: linfo[e.id]?.priority ?? e.priority ?? 0,
      estimate: linfo[e.id]?.estimate ?? null, scope: ticketScope(e.id),
      project: linfo[e.id]?.project ?? e.project ?? null,
    }));

  const mp = maxParallel();
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
  console.log(JSON.stringify(assembleBoard(), null, 2));
}
