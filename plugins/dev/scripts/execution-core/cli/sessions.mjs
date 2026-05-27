// sessions.mjs — `catalyst-execution-core sessions {list,show,prune}` (CTL-649
// Phase 5). The first operator-facing audit surface.
//
//   list  [--json] [--ticket X] [--phase Y]   read path — inventory + classify
//   show  <ticket>                            single-ticket detail
//   prune [--yes] [--dry-run] [--max N]       write path — emit reap intents
//         [--include-idle] [--categories L]
//         [--include-interactive] [--min-idle-seconds N]
//
// Read path joins:
//   • `claude agents --json`  — authoritative live source (status idle/busy)
//   • worker signals          — workers/<T>/phase-<P>.json across all runs
//   • a single `ps` snapshot  — RSS attribution (root + descendants)
//   • Linear cache (optional) — workflow state per ticket
//
// Write path emits `phase.abort.reap-requested` per prunable row and lets the
// Phase-4 reaper inside the daemon do the work. NEVER calls `claude stop`
// directly — single executor seam. Self-protection ($CLAUDE_CODE_SESSION_ID)
// is mandatory: the CLI runs inside a claude session and must never reap it.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shortIdFromSessionId, isSelfSession } from "../claude-ids.mjs";
import { readWorkerSignals, TERMINAL } from "../signal-reader.mjs";
import { emitReapIntent } from "../reap-intent.mjs";
import { getRunsRoot, getExecutionCoreDir, getEventLogPath } from "../config.mjs";
import { lastSeenMsForSession, findTranscript, defaultProjectsDir } from "../session-recency.mjs";
import { scanEventsChunked } from "../event-tail.mjs";
import { classifyWaitState, isWaitingState } from "../wait-state-classifier.mjs";
import { createTranscriptTracker } from "../transcript-tail.mjs";
import { parseArgs, ArgError } from "./args.mjs";

const CLAUDE_BIN = process.env.CATALYST_DISPATCH_CLAUDE_BIN || "claude";

// Categories prune acts on by default — mirrors ~/bin/claude-prune-bg.sh.
// IDLE is opt-in (a live, intact, idle worker may simply be between turns).
const DEFAULT_PRUNE_CATEGORIES = ["DONE", "ORPHAN", "DUPLICATE"];

// ─── Pure: classification ────────────────────────────────────────────────────

/**
 * classifyRow — the priority chain DONE → ORPHAN → IDLE → UNKNOWN → KEEP.
 * Pure: no I/O. DUPLICATE is applied separately (it needs sibling context).
 *
 * @param {object} a
 * @param {?object} a.worker   worker signal ({status}) or null if not indexed
 * @param {boolean} a.cwdExists whether the session's cwd still exists on disk
 * @param {object}  a.session  the live `claude agents` entry ({status})
 */
export function classifyRow({ worker, cwdExists, session }) {
  if (worker && TERMINAL.has(worker.status)) return "DONE";
  if (!cwdExists) return "ORPHAN";
  if (worker && session?.status === "idle") return "IDLE";
  if (!worker) return "UNKNOWN";
  return "KEEP";
}

/**
 * applyDuplicates — within each ticket|phase group, the newest startedAt is the
 * canonical worker; older KEEP/IDLE siblings are re-marked DUPLICATE. DONE and
 * ORPHAN rows keep their stronger classification (they have their own remedy).
 * Mutates and returns the rows.
 */
export function applyDuplicates(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.ticket}|${r.phase}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const newest = group.reduce((a, b) => ((b.startedAt ?? 0) > (a.startedAt ?? 0) ? b : a));
    for (const r of group) {
      if (r === newest) continue;
      if (r.classification === "KEEP" || r.classification === "IDLE") {
        r.classification = "DUPLICATE";
      }
    }
  }
  return rows;
}

// ─── Pure: RSS attribution ───────────────────────────────────────────────────

/**
 * parsePsSnapshot — turn `ps -axo pid=,ppid=,rss=` lines into a lookup of
 * self-RSS and a parent→children adjacency map. One snapshot per CLI run; the
 * per-session shell-out approach is ~5s at 161 sessions vs ~50ms here.
 */
export function parsePsSnapshot(lines) {
  const selfRss = new Map();
  const children = new Map();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rss = Number(parts[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(rss)) continue;
    selfRss.set(pid, rss);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  return { selfRss, children };
}

/**
 * rssTotalForPid — self RSS plus the RSS of every descendant (DFS). `claude
 * --bg` spawns MCP servers, a pty helper, and child processes; root-only RSS
 * underweights the leak ~5×. Returns 0 for an unknown pid.
 */
export function rssTotalForPid(snapshot, pid) {
  const { selfRss, children } = snapshot;
  if (!selfRss.has(pid)) return 0;
  let total = 0;
  const stack = [pid];
  const seen = new Set();
  while (stack.length) {
    const p = stack.pop();
    if (seen.has(p)) continue;
    seen.add(p);
    total += selfRss.get(p) ?? 0;
    for (const c of children.get(p) ?? []) stack.push(c);
  }
  return total;
}

// ─── Pure: name parsing ──────────────────────────────────────────────────────

/**
 * parseSessionName — decode the structured name Phase 1 stamps at dispatch:
 *   o-<orchId>:<ticket>:<phase>:<attempt>
 * orchId itself never contains a colon (it is hyphen-joined). Returns null for
 * a legacy prompt-derived name ("phase monitor merge") or empty input.
 */
export function parseSessionName(name) {
  if (!name) return null;
  const parts = String(name).split(":");
  if (parts.length !== 4) return null;
  const [orchestratorId, ticket, phase, attemptRaw] = parts;
  if (!orchestratorId.startsWith("o-")) return null;
  const attempt = Number(attemptRaw);
  if (!Number.isInteger(attempt)) return null;
  return { orchestratorId, ticket, phase, attempt };
}

// ─── I/O: signal index ───────────────────────────────────────────────────────

/**
 * indexSignalsByBgJobId — index nested bg phase signals by their 8-char
 * bg_job_id short id so the CLI can join a live `claude agents` session onto
 * its worker signal. Reads TWO roots:
 *   • legacy runs/<orchId>/workers/...  — orchestratorId is the subdir name
 *   • the execution-core orchDir (no orchId layer) — orchestratorId comes from
 *     the signal's raw.orchestrator field
 * The execution-core dir is indexed last so a live signal wins any short-id
 * collision against a historical runs/ entry (CTL-674). Missing roots → skipped.
 */
export function indexSignalsByBgJobId(
  runsRoot = getRunsRoot(),
  execCoreDir = getExecutionCoreDir()
) {
  const index = new Map();

  const indexOrchDir = (orchDir, orchestratorIdFromDir) => {
    for (const sig of readWorkerSignals(orchDir)) {
      if (sig.liveness?.kind !== "bg" || !sig.liveness.value) continue;
      let shortId;
      try {
        shortId = shortIdFromSessionId(sig.liveness.value);
      } catch {
        continue;
      }
      index.set(shortId, {
        status: sig.status,
        ticket: sig.ticket,
        phase: sig.phase,
        orchestratorId: orchestratorIdFromDir ?? sig.raw?.orchestrator ?? null,
        worktreePath: sig.worktreePath,
      });
    }
  };

  // Legacy runs/<orchId> — orchestratorId is the subdir name.
  let orchDirs = [];
  try {
    orchDirs = readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    orchDirs = []; // no runs root → skip the legacy walk
  }
  for (const entry of orchDirs) {
    if (!entry.isDirectory()) continue;
    indexOrchDir(join(runsRoot, entry.name), entry.name);
  }

  // Execution-core single orchDir (no orchId layer) — indexed LAST so live
  // signals win short-id collisions; orchestratorId falls back to raw.orchestrator.
  indexOrchDir(execCoreDir, null);

  return index;
}

// ─── I/O: live agents + ps ───────────────────────────────────────────────────

// Exported (CTL-654) so the synchronous daemon boot-resume pass can resolve the
// live-agent inventory without the async buildRows join. Shells
// `claude agents --json` via execFileSync, so it is synchronous and safe inside
// startDaemon's synchronous boot ordering.
export function liveAgents() {
  try {
    const out = execFileSync(CLAUDE_BIN, ["agents", "--json"], { encoding: "utf8" });
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function psLinesSnapshot() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" });
    return out.split("\n");
  } catch {
    return [];
  }
}

// roundOrNull — coerce a recency reading to an integer ms so JSON output never
// leaks sub-millisecond float noise (devex finding #5: lastSeenMs showed
// `5531440.273925781`). Preserves null/undefined unchanged.
function roundOrNull(ms) {
  return ms == null ? null : Math.round(ms);
}

// ─── buildRows: the read-path join ───────────────────────────────────────────

/**
 * buildRows — join live sessions, worker signals, RSS, and Linear state into a
 * classified inventory. All side-effecting inputs are injectable so the suite
 * runs hermetically.
 */
export async function buildRows({
  agents = liveAgents,
  signalsByBgJobId = indexSignalsByBgJobId(),
  psLines = psLinesSnapshot(),
  cwdExists = (p) => existsSync(p),
  linearStateFor = () => null,
  lastSeen = lastSeenMsForSession,
  now = Date.now(),
} = {}) {
  const sessions = typeof agents === "function" ? agents() : agents;
  const snapshot = parsePsSnapshot(psLines);

  const rows = [];
  for (const s of sessions) {
    if (!s || !s.sessionId) continue;
    let shortId;
    try {
      shortId = shortIdFromSessionId(s.sessionId);
    } catch {
      continue;
    }
    const worker = signalsByBgJobId.get(shortId) ?? null;
    const parsedName = parseSessionName(s.name);
    const cwd = s.cwd ?? null;
    const ticket = worker?.ticket ?? parsedName?.ticket ?? null;
    const phase = worker?.phase ?? parsedName?.phase ?? null;
    const orchestratorId = worker?.orchestratorId ?? parsedName?.orchestratorId ?? null;
    const exists = cwd ? cwdExists(cwd) : false;
    const classification = classifyRow({ worker, cwdExists: exists, session: s });

    rows.push({
      sessionId: s.sessionId,
      shortId,
      pid: s.pid ?? null,
      name: s.name ?? null,
      cwd,
      kind: s.kind ?? null,
      orchestratorId,
      ticket,
      phase,
      attempt: parsedName?.attempt ?? null,
      classification,
      signalStatus: worker?.status ?? null,
      linearState: ticket ? linearStateFor(ticket) : null,
      startedAt: s.startedAt ?? null,
      // elapsedMs doubles as the AGE signal (wall-clock since dispatch); rendered
      // as AGE in the table. lastSeenMs is the RECENCY signal (since transcript
      // mtime) — a freshly-touched session is in use regardless of class/age.
      elapsedMs: s.startedAt ? now - s.startedAt : null,
      lastSeenMs: s.sessionId ? roundOrNull(lastSeen(s.sessionId, { now })) : null,
      rssKb: s.pid ? rssTotalForPid(snapshot, s.pid) : 0,
    });
  }
  applyDuplicates(rows);
  return rows;
}

/**
 * buildLiveSessionsByWorktree — group rows by their cwd (worktree path).
 * Consumed by Phase 6's worktrees CLI to decide which worktrees still have a
 * live session before removal.
 */
export function buildLiveSessionsByWorktree(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r.cwd) continue;
    if (!map.has(r.cwd)) map.set(r.cwd, []);
    map.get(r.cwd).push(r);
  }
  return map;
}

// ─── CTL-650: `waiting` — the wait-watcher reference consumer ─────────────────

/**
 * netWaitingSessions — reduce a stream of agent.waiting_on_user / agent.resumed
 * envelopes (append-ordered) to the sessions whose NET latest event is a
 * waiting event. Last-event-per-session wins, so a session that later resumed is
 * excluded. Returns Map<sessionId, payload>. Pure.
 */
export function netWaitingSessions(events) {
  const net = new Map(); // sessionId → { name, payload }
  for (const ev of events ?? []) {
    const name = ev?.attributes?.["event.name"];
    if (name !== "agent.waiting_on_user" && name !== "agent.resumed") continue;
    const payload = ev?.body?.payload ?? {};
    if (!payload.sessionId) continue;
    net.set(payload.sessionId, { name, payload });
  }
  const waiting = new Map();
  for (const [sessionId, { name, payload }] of net) {
    if (name === "agent.waiting_on_user") waiting.set(sessionId, payload);
  }
  return waiting;
}

/**
 * buildWaitingRows — the `waiting` read-path. Source of truth for "currently
 * waiting" is the net state of agent.waiting_on_user / agent.resumed events on
 * the bus; ticket/phase are joined from the signal index (the event payload
 * already carries them when the watcher saw the signal). When the bus has no
 * such events (daemon off / fresh log) it falls back to inline classification
 * over the live sessions. All side-effecting inputs are injectable.
 */
export async function buildWaitingRows({
  events,
  eventLogPath = getEventLogPath(),
  signalsByBgJobId = indexSignalsByBgJobId(),
  agents = liveAgents,
  findTranscriptFn = findTranscript,
  makeTracker = (p) => createTranscriptTracker({ path: p }),
  projectsDir = defaultProjectsDir(),
} = {}) {
  // Read the bus unless events were injected (tests pass [] to force fallback).
  let evs = events;
  if (evs === undefined) {
    evs = [];
    scanEventsChunked({ path: eventLogPath, onEvent: (e) => evs.push(e) });
  }

  // Trust the bus whenever it carries ANY wait/resume event — an empty net set
  // then legitimately means "nobody is waiting" (return []). Only fall back to
  // inline classification when the bus has no such events at all (daemon off /
  // fresh log), NOT when every waiter has since resumed.
  const sawWaitEvents = evs.some((e) => {
    const n = e?.attributes?.["event.name"];
    return n === "agent.waiting_on_user" || n === "agent.resumed";
  });
  const waitingMap = netWaitingSessions(evs);
  if (sawWaitEvents) {
    const rows = [];
    for (const [sessionId, payload] of waitingMap) {
      let shortId = payload.shortId ?? null;
      if (!shortId) {
        try {
          shortId = shortIdFromSessionId(sessionId);
        } catch {
          shortId = null;
        }
      }
      const meta = (shortId && signalsByBgJobId.get(shortId)) || {};
      rows.push({
        sessionId,
        shortId,
        ticket: payload.ticket ?? meta.ticket ?? null,
        phase: payload.phase ?? meta.phase ?? null,
        waitState: payload.waitState ?? null,
        waitingText: payload.waitingText ?? null,
        cwd: payload.cwd ?? meta.worktreePath ?? null,
      });
    }
    return rows;
  }

  // Fallback: no events on the bus — classify the live sessions inline.
  const sessions = typeof agents === "function" ? agents() : agents;
  const rows = [];
  for (const s of sessions ?? []) {
    if (!s || !s.sessionId) continue;
    const path = findTranscriptFn(s.sessionId, projectsDir);
    let snap = { hasTranscript: false };
    if (path) {
      const tracker = makeTracker(path);
      tracker.poll();
      snap = tracker.snapshot();
    }
    const { state, waitingText } = classifyWaitState({ ...snap, status: s.status });
    if (!isWaitingState(state)) continue;
    let shortId = null;
    try {
      shortId = shortIdFromSessionId(s.sessionId);
    } catch {
      shortId = null;
    }
    const meta = (shortId && signalsByBgJobId.get(shortId)) || {};
    rows.push({
      sessionId: s.sessionId,
      shortId,
      ticket: meta.ticket ?? null,
      phase: meta.phase ?? null,
      waitState: state,
      waitingText: waitingText ?? null,
      cwd: s.cwd ?? meta.worktreePath ?? null,
    });
  }
  return rows;
}

// ─── prune: the write path ───────────────────────────────────────────────────

/**
 * runPrune — emit one `phase.abort.reap-requested` per prunable row. Dry-run is
 * the default (no --yes ⇒ nothing emitted). Self-session is always skipped.
 *
 * Returns `{ planned, emitted, plannedRows, skippedRows }`. `plannedRows` carry
 * the fields a JSON consumer needs to inspect the destructive plan before
 * acting (`sessions prune --dry-run --json | jq '.planned'`); `skippedRows`
 * record each protection that fired with a stable machine `reason`
 * (self-session / interactive / recently-active / not-in-category). The human
 * log output (when `--json` is absent) is emitted here as before, byte-for-byte;
 * the JSON rendering lives in `cmdPrune`.
 */
export async function runPrune({
  rows,
  emit = emitReapIntent,
  log = (m) => process.stderr.write(`${m}\n`),
  yes = false,
  dryRun = false,
  max = 20,
  includeIdle = false,
  includeInteractive = false,
  minIdleMs = 15 * 60 * 1000,
  categories,
  json = false,
  env = process.env,
} = {}) {
  const active = new Set(categories ?? DEFAULT_PRUNE_CATEGORIES);
  if (includeIdle) active.add("IDLE");

  // When --json is requested the structured object is the sole stdout payload;
  // suppress the per-row human log lines so they don't corrupt the JSON stream.
  const humanLog = json ? () => {} : log;

  const live = yes && !dryRun;
  let planned = 0;
  let emitted = 0;
  const plannedRows = [];
  const skippedRows = [];
  for (const row of rows) {
    // Cap on planned (not emitted) so --max bounds the dry-run plan too, and
    // is consistent with worktrees/branches prune.
    if (planned >= max) break;
    if (isSelfSession(row.sessionId, env)) {
      humanLog(`skipping self-session ${row.shortId} (controlling session)`);
      skippedRows.push({ shortId: row.shortId, reason: "self-session" });
      continue;
    }
    // Interactive sessions are the operator's own terminal windows. The
    // self-guard only protects the ONE controlling session ($CLAUDE_CODE_SESSION_ID);
    // a prune/timer must never reap the operator's other live windows. These two
    // guards run in BOTH dry-run and live so the plan reflects a real prune.
    if (row.kind === "interactive" && !includeInteractive) {
      humanLog(`skipping ${row.shortId} [protected: interactive]`);
      skippedRows.push({ shortId: row.shortId, reason: "interactive" });
      continue;
    }
    // A transcript touched within minIdleMs means the session is in use right
    // now, regardless of its idle/orphan classification.
    if (row.lastSeenMs != null && row.lastSeenMs < minIdleMs) {
      humanLog(
        `skipping ${row.shortId} [protected: recently active, last_seen ${Math.round(
          row.lastSeenMs / 1000
        )}s]`
      );
      skippedRows.push({ shortId: row.shortId, reason: "recently-active" });
      continue;
    }
    if (!active.has(row.classification)) {
      skippedRows.push({ shortId: row.shortId, reason: "not-in-category" });
      continue;
    }

    planned++;
    plannedRows.push({
      shortId: row.shortId,
      classification: row.classification,
      ticket: row.ticket ?? null,
      phase: row.phase ?? null,
      cwd: row.cwd ?? null,
    });
    if (!live) {
      humanLog(`[dry-run] would reap ${row.shortId} (${row.classification}) ${row.cwd ?? ""}`);
      continue;
    }
    await emit("phase.abort.reap-requested", {
      ticket: row.ticket,
      phase: row.phase,
      bgJobId: row.shortId,
      worktreePath: row.cwd,
      reason: `sessions-prune-${row.classification.toLowerCase()}`,
    });
    emitted++;
  }
  return { planned, emitted, plannedRows, skippedRows };
}

// ─── arg parsing ─────────────────────────────────────────────────────────────

// The strict spec the shared parser validates against. Unknown flags and
// non-numeric --max/--min-idle-seconds throw ArgError instead of silently
// reverting to a default or NaN-ing a safety guard (devex findings #1, #2).
const SESSIONS_SPEC = {
  booleans: ["json", "yes", "dry-run", "include-idle", "include-interactive"],
  numbers: ["max", "min-idle-seconds"],
  strings: ["ticket", "phase", "categories"],
};

/**
 * parseSessionArgs — strict flag parser for the sessions subcommands. Delegates
 * validation to the shared `parseArgs(argv, spec)` (rejects unknown flags and
 * non-numeric numbers), then maps the kebab-case result onto the option names
 * cmdList/cmdShow/runPrune consume: --dry-run→dryRun, --include-idle→includeIdle,
 * --include-interactive→includeInteractive, --min-idle-seconds→minIdleMs (×1000),
 * --categories→split on comma.
 *
 * @throws {ArgError} on an unknown flag, a missing value, or a non-numeric number.
 */
export function parseSessionArgs(argv) {
  const raw = parseArgs(argv, SESSIONS_SPEC);
  const out = {};
  if (raw.json !== undefined) out.json = raw.json;
  if (raw.yes !== undefined) out.yes = raw.yes;
  if (raw["dry-run"] !== undefined) out.dryRun = raw["dry-run"];
  if (raw["include-idle"] !== undefined) out.includeIdle = raw["include-idle"];
  if (raw["include-interactive"] !== undefined) {
    out.includeInteractive = raw["include-interactive"];
  }
  if (raw.max !== undefined) out.max = raw.max;
  if (raw["min-idle-seconds"] !== undefined) out.minIdleMs = raw["min-idle-seconds"] * 1000;
  if (raw.ticket !== undefined) out.ticket = raw.ticket;
  if (raw.phase !== undefined) out.phase = raw.phase;
  if (raw.categories !== undefined) out.categories = String(raw.categories).split(",");
  return out;
}

// ─── CLI commands ────────────────────────────────────────────────────────────

const CATEGORY_ORDER = ["KEEP", "DUPLICATE", "IDLE", "UNKNOWN", "ORPHAN", "DONE"];

/**
 * humanDuration — compact ms→"3s"/"5m"/"2h"/"4d" for the AGE/LAST_SEEN columns.
 * Returns "-" for null/undefined so an absent recency signal reads clearly.
 */
function humanDuration(ms) {
  if (ms == null) return "-";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

async function cmdList({ json, ticket, phase }) {
  let rows = await buildRows();
  if (ticket) rows = rows.filter((r) => r.ticket === ticket);
  if (phase) rows = rows.filter((r) => r.phase === phase);
  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  printTable(rows);
  return 0;
}

async function cmdShow({ ticket }) {
  if (!ticket) {
    process.stderr.write("usage: sessions show <ticket>\n");
    return 1;
  }
  const rows = (await buildRows()).filter((r) => r.ticket === ticket);
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
  return 0;
}

async function cmdPrune(opts) {
  let rows = await buildRows();
  // Honor the same --ticket/--phase scoping as `list`/`show` — silently
  // ignoring scope flags on a destructive command is a footgun.
  if (opts.ticket) rows = rows.filter((r) => r.ticket === opts.ticket);
  if (opts.phase) rows = rows.filter((r) => r.phase === opts.phase);
  const { planned, emitted, plannedRows, skippedRows } = await runPrune({ ...opts, rows });
  const isDryRun = !(opts.yes && !opts.dryRun);
  if (opts.json) {
    // One structured object so a headless agent can inspect the destructive
    // plan before acting: `sessions prune --dry-run --json | jq '.planned'`.
    process.stdout.write(
      `${JSON.stringify({
        dryRun: isDryRun,
        planned: plannedRows,
        skipped: skippedRows,
        emitted,
      })}\n`
    );
    return 0;
  }
  const verb = isDryRun ? "planned (dry-run)" : "reaped";
  process.stderr.write(`sessions prune: ${emitted || planned} ${verb}\n`);
  return 0;
}

async function cmdWaiting({ json }) {
  const rows = await buildWaitingRows();
  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  printWaitingTable(rows);
  return 0;
}

// printWaitingTable — focused listing: shortId TICKET PHASE WAIT_STATE cwd, with
// the blocking text on a wrapped continuation line so a long question stays
// readable. Mirrors printTable's column-padding style.
function printWaitingTable(rows) {
  if (rows.length === 0) {
    process.stdout.write("No sessions are currently waiting on the user.\n");
    return;
  }
  for (const r of rows) {
    process.stdout.write(
      `${String(r.shortId ?? "-").padEnd(9)} ${String(r.ticket ?? "-").padEnd(10)} ` +
        `${String(r.phase ?? "-").padEnd(16)} ${String(r.waitState ?? "-").padEnd(15)} ` +
        `${r.cwd ?? ""}\n`,
    );
    if (r.waitingText) process.stdout.write(`            ↳ ${r.waitingText}\n`);
  }
  process.stdout.write(`──\ntotal: ${rows.length} waiting\n`);
}

function printTable(rows) {
  const byCat = new Map();
  let totalRss = 0;
  for (const r of rows) {
    byCat.set(r.classification, (byCat.get(r.classification) ?? 0) + 1);
    totalRss += r.rssKb ?? 0;
  }
  for (const r of rows) {
    const rssMb = ((r.rssKb ?? 0) / 1024).toFixed(0);
    const interactive = r.kind === "interactive" ? " [interactive]" : "";
    const kind = String(r.kind ?? "-").padEnd(11);
    const age = humanDuration(r.elapsedMs).padStart(5);
    const lastSeen = humanDuration(r.lastSeenMs).padStart(9);
    process.stdout.write(
      `${r.classification.padEnd(9)} ${r.shortId}  ${String(r.ticket ?? "-").padEnd(10)} ` +
        `${String(r.phase ?? "-").padEnd(16)} ${kind} ${age} ${lastSeen} ` +
        `${String(rssMb).padStart(6)}MB  ${r.cwd ?? ""}${interactive}\n`
    );
  }
  process.stdout.write("──\n");
  for (const cat of CATEGORY_ORDER) {
    if (byCat.has(cat)) process.stdout.write(`${cat}: ${byCat.get(cat)}  `);
  }
  process.stdout.write(
    `\ntotal: ${rows.length} sessions, ${(totalRss / 1024 / 1024).toFixed(1)} GB RSS\n`
  );
}

function usage() {
  process.stderr.write(
    "Usage: catalyst-execution-core sessions {list|show|waiting|prune} [flags]\n" +
      "  list    [--json] [--ticket X] [--phase Y]\n" +
      "  show    <ticket>\n" +
      "  waiting [--json]   list sessions currently blocked on the user (CTL-650)\n" +
      "  prune   [--yes] [--dry-run] [--max N] [--include-idle] [--include-interactive]\n" +
      "          [--min-idle-seconds N] [--categories LIST]\n"
  );
}

async function main(argv) {
  const sub = argv[0];
  const opts = parseSessionArgs(argv.slice(1));
  switch (sub) {
    case "list":
      return cmdList(opts);
    case "show":
      return cmdShow({ ticket: argv[1] });
    case "waiting":
      return cmdWaiting(opts);
    case "prune":
      return cmdPrune(opts);
    default:
      usage();
      return 1;
  }
}

const isEntry =
  import.meta.main === true ||
  (typeof import.meta.url === "string" &&
    process.argv[1] &&
    fileURLToPath(import.meta.url) === process.argv[1]);

if (isEntry) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code ?? 0))
    .catch((err) => {
      // A bad/unknown flag is operator error, not a crash: print the message
      // and usage, exit 2. Re-throw anything else so genuine bugs still surface
      // with a stack trace via the default uncaught-rejection path.
      if (err instanceof ArgError) {
        process.stderr.write(`error: ${err.message}\n`);
        usage();
        process.exit(2);
      }
      throw err;
    })
    .catch((err) => {
      process.stderr.write(`sessions: ${err.message}\n`);
      process.exit(1);
    });
}
