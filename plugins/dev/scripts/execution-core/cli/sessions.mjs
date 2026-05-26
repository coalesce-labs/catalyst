// sessions.mjs — `catalyst-execution-core sessions {list,show,prune}` (CTL-649
// Phase 5). The first operator-facing audit surface.
//
//   list  [--json] [--ticket X] [--phase Y]   read path — inventory + classify
//   show  <ticket>                            single-ticket detail
//   prune [--yes] [--dry-run] [--max N]       write path — emit reap intents
//         [--include-idle] [--categories L]
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
import { getRunsRoot } from "../config.mjs";

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
 * indexSignalsByBgJobId — walk every ~/catalyst/runs/<orchId>/workers tree and
 * index the nested phase signals by their 8-char bg_job_id, joining each onto
 * its orchestratorId. The CLI then looks up a live session's short id here to
 * recover worker status / ticket / phase. Missing runs root → empty map.
 */
export function indexSignalsByBgJobId(runsRoot = getRunsRoot()) {
  const index = new Map();
  let orchDirs;
  try {
    orchDirs = readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return index;
  }
  for (const entry of orchDirs) {
    if (!entry.isDirectory()) continue;
    const orchestratorId = entry.name;
    const orchDir = join(runsRoot, orchestratorId);
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
        orchestratorId,
        worktreePath: sig.worktreePath,
      });
    }
  }
  return index;
}

// ─── I/O: live agents + ps ───────────────────────────────────────────────────

function liveAgents() {
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
      elapsedMs: s.startedAt ? now - s.startedAt : null,
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

// ─── prune: the write path ───────────────────────────────────────────────────

/**
 * runPrune — emit one `phase.abort.reap-requested` per prunable row. Dry-run is
 * the default (no --yes ⇒ nothing emitted). Self-session is always skipped.
 * Returns { planned, emitted } counts.
 */
export async function runPrune({
  rows,
  emit = emitReapIntent,
  log = (m) => process.stderr.write(`${m}\n`),
  yes = false,
  dryRun = false,
  max = 20,
  includeIdle = false,
  categories,
  env = process.env,
} = {}) {
  const active = new Set(categories ?? DEFAULT_PRUNE_CATEGORIES);
  if (includeIdle) active.add("IDLE");

  const live = yes && !dryRun;
  let planned = 0;
  let emitted = 0;
  for (const row of rows) {
    // Cap on planned (not emitted) so --max bounds the dry-run plan too, and
    // is consistent with worktrees/branches prune.
    if (planned >= max) break;
    if (isSelfSession(row.sessionId, env)) {
      log(`skipping self-session ${row.shortId} (controlling session)`);
      continue;
    }
    if (!active.has(row.classification)) continue;

    planned++;
    if (!live) {
      log(`[dry-run] would reap ${row.shortId} (${row.classification}) ${row.cwd ?? ""}`);
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
  return { planned, emitted };
}

// ─── arg parsing ─────────────────────────────────────────────────────────────

/**
 * parseArgs — minimal flag parser for the sessions subcommands. Boolean flags
 * (--json/--yes/--dry-run/--include-idle) take no value; --max coerces to a
 * number; --categories splits on commas; everything else is a string value.
 */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--json":
        out.json = true;
        break;
      case "--yes":
        out.yes = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--include-idle":
        out.includeIdle = true;
        break;
      case "--max":
        out.max = Number(argv[++i]);
        break;
      case "--ticket":
        out.ticket = argv[++i];
        break;
      case "--phase":
        out.phase = argv[++i];
        break;
      case "--categories":
        out.categories = String(argv[++i]).split(",");
        break;
      default:
        break;
    }
  }
  return out;
}

// ─── CLI commands ────────────────────────────────────────────────────────────

const CATEGORY_ORDER = ["KEEP", "DUPLICATE", "IDLE", "UNKNOWN", "ORPHAN", "DONE"];

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
  const { planned, emitted } = await runPrune({ ...opts, rows });
  const verb = opts.yes && !opts.dryRun ? "reaped" : "planned (dry-run)";
  process.stderr.write(`sessions prune: ${emitted || planned} ${verb}\n`);
  return 0;
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
    process.stdout.write(
      `${r.classification.padEnd(9)} ${r.shortId}  ${String(r.ticket ?? "-").padEnd(10)} ` +
        `${String(r.phase ?? "-").padEnd(16)} ${String(rssMb).padStart(6)}MB  ${r.cwd ?? ""}\n`
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
    "Usage: catalyst-execution-core sessions {list|show|prune} [flags]\n" +
      "  list  [--json] [--ticket X] [--phase Y]\n" +
      "  show  <ticket>\n" +
      "  prune [--yes] [--dry-run] [--max N] [--include-idle] [--categories LIST]\n"
  );
}

async function main(argv) {
  const sub = argv[0];
  const opts = parseArgs(argv.slice(1));
  switch (sub) {
    case "list":
      return cmdList(opts);
    case "show":
      return cmdShow({ ticket: argv[1] });
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
      process.stderr.write(`sessions: ${err.message}\n`);
      process.exit(1);
    });
}
