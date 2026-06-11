// ticket-runs.mjs — surface every phase-agent execution as a real RUN entity
// (CTL-886, BFF4 — the design's named keystone P2 + its companion P3).
//
// The structural gap this closes: BoardPayload carries `phaseSummary`
// (per-phase timing, NO worker identity — board-data.d.mts BoardPhaseTiming) and
// `BoardWorker` (board-data.mjs liveAgents → `kind==="background"` only, i.e.
// LIVE bg agents). A phase that finished 2h ago has a `phase-*.json` signal on
// disk but NO BoardWorker. The RUNS rail, per-phase PR detail, the DEPLOY card,
// finished-run worker pages, and the finished-run peek all need a run→worker
// identity that does not exist today.
//
// This module reads every
//   ~/catalyst/execution-core/workers/<TICKET>/phase-*.json
// signal as a queryable RUN RECORD (model, bg_job_id, attempt, generation,
// status, startedAt/completedAt, host{name,id}, pr{} when present). FINISHED runs
// (no live BoardWorker) are included, not just live ones — that is the whole
// point. A companion entry serves ONE phase signal VERBATIM for the worker
// header / timestamps / SIGNAL panel.
//
// READ-ONLY, durable-cache-only: pure file reads of resident signals + a single
// grouped catalyst.db join for per-phase cost. NO live Linear / GitHub call is
// ever made per request — PR + deploy detail ride free off the signals the
// phase-pr / phase-monitor-merge / phase-monitor-deploy agents already wrote.
//
// Cost/tokens/turns are JOINED, never invented onto the signal: phase signals
// carry no cost field (verified), so per-run cost comes from the telemetry /
// catalyst.db join (board-data.mjs::costByPhase). A run with no telemetry row
// gets `cost: null`, never a fabricated zero stamped on the signal.

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PHASE_ORDER } from "./board-data.mjs";
import { hostName, hostId } from "./canonical-event-shared.ts";

const execFileP = promisify(execFile);

const HOME = homedir();
const DEFAULT_WORKERS_DIR = join(HOME, "catalyst", "execution-core", "workers");
const DEFAULT_DB = join(HOME, "catalyst", "catalyst.db");

async function readJSON(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Single-host identity NO-OP default (CTL-886 single-node MVP). Newer signals
// carry `host:{name,id}` (CTL-852 phase-agent-dispatch); older on-disk signals
// predate it. When the signal omits host, default to THIS host's identity via the
// shared host-identity algorithm (canonical-event-shared.ts hostName/hostId,
// byte-identical to lib/host-identity.sh + execution-core/lib/host-identity.mjs).
// For a single-host deployment this is an exact identity no-op — every run is
// attributed to the one node, zero added latency. A real multi-node fan-in
// (BFF3) is out of scope; this keeps the RUNS rail node-aware (consistent with
// BFF2) without inventing a host the signal never recorded.
function resolveHost(sig) {
  const h = sig && typeof sig === "object" ? sig.host : null;
  if (h && typeof h === "object" && typeof h.name === "string" && h.name) {
    return { name: h.name, id: typeof h.id === "string" && h.id ? h.id : hostId({ override: h.name }) };
  }
  const name = hostName();
  return { name, id: hostId() };
}

// Derive this run's PR detail from its OWN signal, verbatim. The phase agents
// already wrote everything the UI needs:
//   • phase-pr.json          → pr.{number,url}
//   • phase-implement.json    → draftPr.{number,url,isDraft}  (early PR floor)
//   • phase-monitor-merge.json → pr.{number,mergedAt,ciStatus,mergeCommitSha}
//   • phase-monitor-deploy.json → pr/deploy detail for the DEPLOY card
// No GitHub call — the signal IS the source. Returns null when the phase carries
// no PR shape (most phases don't), so the UI can hide the PR cell rather than
// render an empty stub.
function prFromSignal(sig) {
  if (!sig || typeof sig !== "object") return null;
  if (sig.pr && typeof sig.pr === "object" && sig.pr.number != null) return sig.pr;
  if (sig.draftPr && typeof sig.draftPr === "object" && sig.draftPr.number != null) {
    return sig.draftPr;
  }
  return null;
}

function finiteDate(s) {
  if (typeof s !== "string" || !s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// durationMs for a run — completedAt − startedAt when both parse and the result
// is non-negative; null otherwise (mirrors buildPhaseSummary's "unknown" rather
// than laundering a clock-skewed negative as a clean zero). A run still in flight
// (no completedAt) yields null here — the live elapsed clock is the UI's job off
// the live BoardWorker, not a now-anchored runaway baked into a run record.
function runDurationMs(sig) {
  const start = finiteDate(sig?.startedAt);
  const end = finiteDate(sig?.completedAt);
  if (start == null || end == null) return null;
  return end >= start ? end - start : null;
}

// ── per-phase cost join (catalyst.db / telemetry) ───────────────────────────
// Grouped query lifted from board-data.mjs::costByPhase — sessions ⋈
// session_metrics, scoped to ONE ticket's `phase-%` skills. Returns
// { [phase]: {costUSD, tokens, turns} } or {} when the db is absent / has no
// rows. This is the ONLY place cost enters a run record; signals never carry it.
async function costByPhaseForTicket(ticket, dbPath) {
  const map = {};
  if (!ticket || !(await exists(dbPath))) return map;
  try {
    // Bind the ticket as a NAMED sqlite parameter (@t) rather than interpolating
    // it into the SQL — no injection surface regardless of the ticket string.
    // (`.param set` only supports named params, not positional `?`.)
    const sql =
      "SELECT s.skill_name, ROUND(COALESCE(SUM(m.cost_usd),0),4), " +
      "COALESCE(SUM(m.input_tokens+m.output_tokens),0), COALESCE(SUM(m.num_turns),0) " +
      "FROM sessions s JOIN session_metrics m ON m.session_id=s.session_id " +
      "WHERE s.ticket_key=@t AND s.skill_name LIKE 'phase-%' " +
      "GROUP BY s.skill_name;";
    const { stdout } = await execFileP(
      "sqlite3",
      ["-separator", "\t", "-cmd", `.param set @t ${JSON.stringify(ticket)}`, dbPath, sql],
      { encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
    );
    for (const line of stdout.trim().split("\n")) {
      if (!line) continue;
      const [skill, cost, tokens, turns] = line.split("\t");
      const phase = skill.replace(/^phase-/, "");
      map[phase] = {
        costUSD: Number(cost) || 0,
        tokens: Number(tokens) || 0,
        turns: Number(turns) || 0,
      };
    }
  } catch {
    /* sqlite missing or schema pre-migration — cost stays null per run */
  }
  return map;
}

// Build ONE run entity from a phase signal. `costRow` is the joined telemetry for
// this phase (or undefined → cost:null, never a fabricated 0). Carries the signal
// identity fields straight through (model, bg_job_id, attempt, generation,
// status, timestamps, orchestrator, worktreePath, sessionId), the resolved host,
// the verbatim PR shape, and the joined cost.
export function toRunEntity(phase, sig, costRow) {
  return {
    ticket: typeof sig.ticket === "string" ? sig.ticket : null,
    phase,
    status: typeof sig.status === "string" ? sig.status : "unknown",
    model: typeof sig.model === "string" ? sig.model : null,
    bg_job_id: sig.bg_job_id ?? null,
    attempt: typeof sig.attempt === "number" ? sig.attempt : null,
    generation: typeof sig.generation === "number" ? sig.generation : null,
    orchestrator: typeof sig.orchestrator === "string" ? sig.orchestrator : null,
    startedAt: typeof sig.startedAt === "string" ? sig.startedAt : null,
    completedAt: typeof sig.completedAt === "string" ? sig.completedAt : null,
    updatedAt: typeof sig.updatedAt === "string" ? sig.updatedAt : null,
    durationMs: runDurationMs(sig),
    host: resolveHost(sig),
    worktreePath: typeof sig.worktreePath === "string" ? sig.worktreePath : null,
    sessionId:
      typeof sig.catalystSessionId === "string"
        ? sig.catalystSessionId
        : typeof sig.sessionId === "string"
          ? sig.sessionId
          : null,
    pr: prFromSignal(sig),
    // Joined, never invented: undefined telemetry row → null (no fabricated 0).
    cost: costRow ?? null,
  };
}

// ── keystone: a ticket's full run history ───────────────────────────────────
// assembleTicketRuns(ticket) — one run entity per phase-*.json signal under the
// ticket's worker dir, in canonical PHASE_ORDER. Finished runs (no live
// BoardWorker) are included by construction — we read the signal files, not the
// live-agent list. Each run carries the joined per-phase cost. No live API.
export async function assembleTicketRuns(
  ticket,
  { workersDir = DEFAULT_WORKERS_DIR, dbPath = DEFAULT_DB } = {},
) {
  const dir = join(workersDir, ticket);
  if (!(await exists(dir))) return { ticket, runs: [] };
  const [sigs, costByPhase] = await Promise.all([
    Promise.all(
      PHASE_ORDER.map((p) => readJSON(join(dir, `phase-${p}.json`)).then((s) => [p, s])),
    ),
    costByPhaseForTicket(ticket, dbPath),
  ]);
  const runs = [];
  for (const [phase, sig] of sigs) {
    if (!sig || typeof sig !== "object") continue;
    runs.push(toRunEntity(phase, sig, costByPhase[phase]));
  }
  return { ticket, runs };
}

// ── companion P3: one run signal served VERBATIM ────────────────────────────
// readPhaseSignalVerbatim(ticket, phase) — the raw phase-<phase>.json contents,
// parsed but UNTRANSFORMED (model, bg_job_id, generation, status, timestamps,
// host, pr — exactly as the agent wrote them). Powers the worker header,
// PHASE TIMESTAMPS, and the SIGNAL panel. Returns null when the phase has no
// signal (so the route can 404 instead of serving an empty object).
export async function readPhaseSignalVerbatim(
  ticket,
  phase,
  { workersDir = DEFAULT_WORKERS_DIR } = {},
) {
  if (!ticket || !phase || !PHASE_ORDER.includes(phase)) return null;
  return readJSON(join(workersDir, ticket, `phase-${phase}.json`));
}
