// worktrees.mjs — `catalyst-execution-core worktrees {list,prune}` (CTL-649
// Phase 6).
//
//   list  [--json] [--stale-days N]
//   prune [--yes] [--dry-run] [--max N] [--include-stale]
//
// Joins `git worktree list --porcelain`, `gh pr list --state all`, the live
// session inventory from Phase 5 (buildLiveSessionsByWorktree), and an optional
// Linear-state lookup. Prune emits — per row — a worktree.presweep.reap-requested
// (stop any straggler sessions) THEN a pr.merged.cleanup-requested (remove the
// worktree + local branch). Both flow through the Phase-4 reaper; this module
// never calls `claude stop` / `git worktree remove` / `git branch -D` directly.
//
// Linear-state enrichment is opt-in and injected — by default it is null, so
// the rate-limited `linearis` path is never hit from a list/prune. ABANDONED
// classification only fires when a caller supplies linearStateFor.

import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emitReapIntent } from "../reap-intent.mjs";
import { buildRows as buildSessionRows, buildLiveSessionsByWorktree } from "./sessions.mjs";

const GH_BIN = process.env.CATALYST_GH_BIN || "gh";
const DEFAULT_STALE_DAYS = Number(process.env.CATALYST_WORKTREE_STALE_DAYS) || 14;

// Worktree classes pruned by default. STALE is opt-in (--include-stale); LIVE
// and ACTIVE are never auto-pruned.
const DEFAULT_PRUNE_CLASSES = ["MERGED", "ABANDONED", "CLOSED_NO_MERGE"];
const ABANDONED_LINEAR_STATES = new Set(["Done", "Cancelled", "Canceled"]);

// ─── Pure: porcelain parse ───────────────────────────────────────────────────

/**
 * parseWorktreeList — split `git worktree list --porcelain` into one record per
 * worktree: { path, branch, head, detached, bare }. Blocks are blank-line
 * separated; each opens with `worktree <path>`.
 */
export function parseWorktreeList(porcelain) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  for (const line of (porcelain ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = {
        path: line.slice("worktree ".length).trim(),
        branch: null,
        head: null,
        detached: false,
        bare: false,
      };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length).trim();
    } else if (line.startsWith("branch ")) {
      cur.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "");
    } else if (line.trim() === "detached") {
      cur.detached = true;
    } else if (line.trim() === "bare") {
      cur.bare = true;
    }
  }
  flush();
  return out;
}

/**
 * ticketFromBranch — recover a TICKET-NNN identifier from a branch name, whether
 * the branch is the bare ticket (CTL-649) or a slug (ryan/ctl-649-orphan-leak).
 */
export function ticketFromBranch(branch) {
  if (!branch) return null;
  const m = /([A-Za-z]+-\d+)/.exec(branch);
  return m ? m[1].toUpperCase() : null;
}

// ─── Pure: classification ────────────────────────────────────────────────────

/**
 * classify — worktree disposition. Priority:
 *   LIVE (a session still cwd'd here) → MERGED → CLOSED_NO_MERGE → ACTIVE
 *   (open PR) → ABANDONED (Linear Done/Cancelled, no PR) → STALE (aged out) →
 *   ACTIVE (safe default for a fresh, in-progress worktree).
 */
export function classify({
  prState = "none",
  liveSessions = 0,
  linearState = null,
  ageDays = 0,
  staleDays = DEFAULT_STALE_DAYS,
} = {}) {
  if (liveSessions > 0) return "LIVE";
  if (prState === "merged") return "MERGED";
  if (prState === "closed") return "CLOSED_NO_MERGE";
  if (prState === "open") return "ACTIVE";
  if (linearState && ABANDONED_LINEAR_STATES.has(linearState)) return "ABANDONED";
  if (ageDays > staleDays) return "STALE";
  return "ACTIVE";
}

// ─── I/O sources ─────────────────────────────────────────────────────────────

function gitWorktreePorcelain() {
  try {
    return execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
  } catch {
    return "";
  }
}

/**
 * ghPrList — every PR (any state) as { number, headRefName, state } with state
 * lowercased to open|closed|merged. Empty on any gh failure (no auth, no remote).
 */
export function ghPrList() {
  try {
    const out = execFileSync(
      GH_BIN,
      ["pr", "list", "--state", "all", "--limit", "500", "--json", "number,headRefName,state"],
      { encoding: "utf8" }
    );
    const parsed = JSON.parse(out);
    return (Array.isArray(parsed) ? parsed : []).map((p) => ({
      number: p.number,
      headRefName: p.headRefName,
      state: String(p.state ?? "").toLowerCase(),
    }));
  } catch {
    return [];
  }
}

function mtimeMsFor(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return Date.now();
  }
}

// ─── buildRows ───────────────────────────────────────────────────────────────

/**
 * buildRows — classified worktree inventory. All side-effecting inputs are
 * injectable. By default it shells out to git/gh and reuses Phase 5's live
 * session rows; tests pass fixtures.
 */
export async function buildRows({
  porcelain = gitWorktreePorcelain(),
  prs = ghPrList(),
  liveByWorktree,
  mtimeFor = mtimeMsFor,
  linearStateFor = () => null,
  now = Date.now(),
  staleDays = DEFAULT_STALE_DAYS,
} = {}) {
  let liveMap = liveByWorktree;
  if (!liveMap) {
    liveMap = buildLiveSessionsByWorktree(await buildSessionRows({}));
  }
  const worktrees = parseWorktreeList(porcelain);
  const rows = [];
  for (const wt of worktrees) {
    if (wt.bare) continue; // the bare repo is not a prunable worktree
    const ticket = ticketFromBranch(wt.branch);
    const pr = prs.find((p) => p.headRefName === wt.branch);
    const live = liveMap.get(wt.path) ?? [];
    const ageDays = (now - mtimeFor(wt.path)) / 86_400_000;
    const linearState = ticket ? linearStateFor(ticket) : null;
    const classification = classify({
      prState: pr?.state ?? "none",
      liveSessions: live.length,
      linearState,
      ageDays,
      staleDays,
    });
    rows.push({
      path: wt.path,
      branch: wt.branch,
      ticket,
      prNumber: pr?.number ?? null,
      prState: pr?.state ?? "none",
      liveSessions: live.length,
      linearState,
      ageDays,
      classification,
    });
  }
  return rows;
}

// ─── prune ───────────────────────────────────────────────────────────────────

/**
 * runWorktreesPrune — per prunable row, emit a presweep (stop straggler
 * sessions) followed by a cleanup (remove worktree + branch). Dry-run default.
 * STALE rows need includeStale; LIVE/ACTIVE are never pruned.
 */
export async function runWorktreesPrune({
  rows,
  emit = emitReapIntent,
  log = (m) => process.stderr.write(`${m}\n`),
  yes = false,
  dryRun = false,
  max = 50,
  includeStale = false,
} = {}) {
  const active = new Set(DEFAULT_PRUNE_CLASSES);
  if (includeStale) active.add("STALE");

  const live = yes && !dryRun;
  let planned = 0;
  let emitted = 0;
  for (const row of rows) {
    if (planned >= max) break;
    if (!active.has(row.classification)) continue;
    planned++;
    if (!live) {
      log(`[dry-run] would prune ${row.path} (${row.classification})`);
      continue;
    }
    // 1. Stop any straggler sessions still cwd'd under the worktree first —
    //    the reaper's cleanup handler also presweeps, but emitting it explicitly
    //    keeps the "sessions before worktree" ordering observable in the log.
    await emit("worktree.presweep.reap-requested", { worktreePath: row.path });
    // 2. Remove the worktree and its local branch. Force branch-deletion ONLY
    //    for MERGED rows — a confirmed GitHub merge is squash-safe, where local
    //    `git branch -d` would falsely refuse. For CLOSED_NO_MERGE / ABANDONED /
    //    STALE the branch may carry unmerged commits, so we leave force off and
    //    let the reaper's `-d` refuse rather than silently destroy them.
    await emit("pr.merged.cleanup-requested", {
      ticket: row.ticket,
      worktreePath: row.path,
      branch: row.branch,
      ...(row.classification === "MERGED" ? { force: true } : {}),
    });
    emitted++;
  }
  return { planned, emitted };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--json":
        out.json = true;
        break;
      case "--yes":
        out.yes = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--include-stale":
        out.includeStale = true;
        break;
      case "--max":
        out.max = Number(argv[++i]);
        break;
      case "--stale-days":
        out.staleDays = Number(argv[++i]);
        break;
      default:
        break;
    }
  }
  return out;
}

async function cmdList({ json, staleDays }) {
  const rows = await buildRows({ staleDays: staleDays ?? DEFAULT_STALE_DAYS });
  if (json) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return 0;
  }
  for (const r of rows) {
    process.stdout.write(
      `${r.classification.padEnd(16)} ${String(r.ticket ?? "-").padEnd(10)} ` +
        `PR:${String(r.prNumber ?? "-").padEnd(5)} live:${r.liveSessions}  ${r.path}\n`
    );
  }
  process.stdout.write(`total: ${rows.length} worktrees\n`);
  return 0;
}

async function cmdPrune(opts) {
  const rows = await buildRows({ staleDays: opts.staleDays ?? DEFAULT_STALE_DAYS });
  const { planned, emitted } = await runWorktreesPrune({ ...opts, rows });
  const verb = opts.yes && !opts.dryRun ? "pruned" : "planned (dry-run)";
  process.stderr.write(`worktrees prune: ${emitted || planned} ${verb}\n`);
  return 0;
}

function usage() {
  process.stderr.write(
    "Usage: catalyst-execution-core worktrees {list|prune} [flags]\n" +
      "  list  [--json] [--stale-days N]\n" +
      "  prune [--yes] [--dry-run] [--max N] [--include-stale]\n"
  );
}

async function main(argv) {
  const sub = argv[0];
  const opts = parseArgs(argv.slice(1));
  switch (sub) {
    case "list":
      return cmdList(opts);
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
      process.stderr.write(`worktrees: ${err.message}\n`);
      process.exit(1);
    });
}
