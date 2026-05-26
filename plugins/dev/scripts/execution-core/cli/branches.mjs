// branches.mjs — `catalyst-execution-core branches {list,prune}` (CTL-649
// Phase 7).
//
//   list  [--json] [--scope local|remote|both] [--stale-days N]
//   prune [--yes] [--dry-run] [--scope ...] [--force] [--max N]
//
// A bare branch has no claude-session aspect, so prune deletes refs DIRECTLY
// (git branch -D / git push origin --delete) — NOT through the reaper. The
// reaper is for sessions and worktrees; routing a ref delete through it would
// be ceremony with no executor to swap at the cloud seam.
//
// Safety: WORKTREE_BACKED branches are never deleted (the worktree owns them —
// use `worktrees prune`). Unmerged locals require --force.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ghPrList } from "./worktrees.mjs";

const DEFAULT_STALE_DAYS = Number(process.env.CATALYST_BRANCH_STALE_DAYS) || 30;
const ABANDONED_DEFAULT = ["MERGED_LOCAL", "MERGED_REMOTE"];
// Unmerged classes a --force prune may also remove.
const FORCE_CLASSES = ["ORPHAN_LOCAL", "STALE_REMOTE", "CLOSED_NO_MERGE"];

// ─── Pure: classification ────────────────────────────────────────────────────

/**
 * classify — branch disposition. Priority:
 *   WORKTREE_BACKED (a worktree has it checked out — defer to worktrees prune)
 *   → CLOSED_NO_MERGE → MERGED_REMOTE → MERGED_LOCAL → ORPHAN_LOCAL
 *   → STALE_REMOTE → ACTIVE (safe default).
 */
export function classify({
  worktreePath = null,
  scope = "both",
  prState = "none",
  mergedIntoMain = false,
  remoteExists = false,
  ageDays = 0,
  staleDays = DEFAULT_STALE_DAYS,
} = {}) {
  if (worktreePath) return "WORKTREE_BACKED";
  if (prState === "closed") return "CLOSED_NO_MERGE";
  if (prState === "merged") {
    return scope === "local" ? "MERGED_LOCAL" : "MERGED_REMOTE";
  }
  if (scope === "local" && mergedIntoMain) return "MERGED_LOCAL";
  if (scope === "local" && prState === "none" && !remoteExists) return "ORPHAN_LOCAL";
  if (scope === "remote" && prState === "none" && ageDays > staleDays) return "STALE_REMOTE";
  return "ACTIVE";
}

// ─── I/O sources ─────────────────────────────────────────────────────────────

function gitLines(args) {
  try {
    const out = execFileSync("git", args, { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function listLocalBranches() {
  return gitLines(["branch", "--format=%(refname:short)"]);
}

function listRemoteBranches() {
  // origin/<name> → <name>; skip the symbolic origin/HEAD.
  return gitLines(["branch", "-r", "--format=%(refname:short)"])
    .filter((b) => b.startsWith("origin/") && !b.includes("HEAD"))
    .map((b) => b.slice("origin/".length));
}

function listMergedLocal(base = "main") {
  return new Set(gitLines(["branch", "--merged", base, "--format=%(refname:short)"]));
}

function worktreeBranchSet() {
  const set = new Set();
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (line.startsWith("branch ")) {
        set.add(
          line
            .slice("branch ".length)
            .trim()
            .replace(/^refs\/heads\//, "")
        );
      }
    }
  } catch {
    /* git unavailable → empty */
  }
  return set;
}

function ageDaysForBranch(name) {
  // A remote-only branch has no local ref — fall back to origin/<name>. stderr
  // is dropped so a missing ref never prints `fatal: ambiguous argument`.
  for (const ref of [name, `origin/${name}`]) {
    try {
      const out = execFileSync("git", ["log", "-1", "--format=%ct", ref], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const ts = Number(out) * 1000;
      if (Number.isFinite(ts) && ts > 0) return (Date.now() - ts) / 86_400_000;
    } catch {
      /* try next ref form */
    }
  }
  return 0;
}

// ─── buildRows ───────────────────────────────────────────────────────────────

export async function buildRows({
  localBranches = listLocalBranches(),
  remoteBranches = listRemoteBranches(),
  worktreeBranches = worktreeBranchSet(),
  mergedLocal = listMergedLocal(),
  prs = ghPrList(),
  ageDaysFor = ageDaysForBranch,
  staleDays = DEFAULT_STALE_DAYS,
} = {}) {
  const localSet = new Set(localBranches);
  const remoteSet = new Set(remoteBranches);
  const names = new Set([...localBranches, ...remoteBranches]);

  const rows = [];
  for (const name of names) {
    const inLocal = localSet.has(name);
    const inRemote = remoteSet.has(name);
    const scope = inLocal && inRemote ? "both" : inLocal ? "local" : "remote";
    const worktreePath = worktreeBranches.has(name) ? name : null;
    const pr = prs.find((p) => p.headRefName === name);
    const mergedIntoMain = mergedLocal.has(name);
    const ageDays = ageDaysFor(name);
    const classification = classify({
      worktreePath,
      scope,
      prState: pr?.state ?? "none",
      mergedIntoMain,
      remoteExists: inRemote,
      ageDays,
      staleDays,
    });
    rows.push({
      name,
      scope,
      prState: pr?.state ?? "none",
      prNumber: pr?.number ?? null,
      mergedIntoMain,
      remoteExists: inRemote,
      worktreePath,
      ageDays,
      classification,
    });
  }
  return rows;
}

// ─── prune ───────────────────────────────────────────────────────────────────

async function defaultDeleteLocal(branch) {
  try {
    execFileSync("git", ["branch", "-D", branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function defaultDeleteRemote(branch) {
  try {
    execFileSync("git", ["push", "origin", "--delete", branch], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * runBranchesPrune — delete prunable branch refs directly. MERGED_{LOCAL,REMOTE}
 * are removed by default; the unmerged classes (ORPHAN_LOCAL, STALE_REMOTE,
 * CLOSED_NO_MERGE) need --force. scope restricts which side is acted on.
 * WORKTREE_BACKED and ACTIVE are never touched.
 */
export async function runBranchesPrune({
  rows,
  deleteLocalBranch = defaultDeleteLocal,
  deleteRemoteBranch = defaultDeleteRemote,
  log = (m) => process.stderr.write(`${m}\n`),
  yes = false,
  dryRun = false,
  force = false,
  scope = "both",
  max = 100,
} = {}) {
  const live = yes && !dryRun;
  const allowed = new Set(ABANDONED_DEFAULT);
  if (force) for (const c of FORCE_CLASSES) allowed.add(c);

  let planned = 0;
  let deleted = 0;
  for (const row of rows) {
    if (planned >= max) break;
    if (!allowed.has(row.classification)) continue;

    // Which side does this class delete from?
    const side =
      row.classification === "MERGED_REMOTE" || row.classification === "STALE_REMOTE"
        ? "remote"
        : row.classification === "MERGED_LOCAL" || row.classification === "ORPHAN_LOCAL"
          ? "local"
          : null; // CLOSED_NO_MERGE: delete whichever side(s) exist
    const sides = side ? [side] : [row.scope === "remote" ? "remote" : "local"];

    for (const s of sides) {
      if (scope !== "both" && scope !== s) continue;
      planned++;
      if (!live) {
        log(`[dry-run] would delete ${s} branch ${row.name} (${row.classification})`);
        continue;
      }
      if (s === "remote") await deleteRemoteBranch(row.name);
      else await deleteLocalBranch(row.name);
      deleted++;
    }
  }
  return { planned, deleted };
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
      case "--force":
        out.force = true;
        break;
      case "--scope":
        out.scope = argv[++i];
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
      `${r.classification.padEnd(16)} ${r.scope.padEnd(6)} PR:${String(r.prNumber ?? "-").padEnd(5)} ${r.name}\n`
    );
  }
  process.stdout.write(`total: ${rows.length} branches\n`);
  return 0;
}

async function cmdPrune(opts) {
  const rows = await buildRows({ staleDays: opts.staleDays ?? DEFAULT_STALE_DAYS });
  const { planned, deleted } = await runBranchesPrune({ ...opts, rows });
  const verb = opts.yes && !opts.dryRun ? "deleted" : "planned (dry-run)";
  process.stderr.write(`branches prune: ${deleted || planned} ${verb}\n`);
  return 0;
}

function usage() {
  process.stderr.write(
    "Usage: catalyst-execution-core branches {list|prune} [flags]\n" +
      "  list  [--json] [--scope local|remote|both] [--stale-days N]\n" +
      "  prune [--yes] [--dry-run] [--scope ...] [--force] [--max N]\n"
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
      process.stderr.write(`branches: ${err.message}\n`);
      process.exit(1);
    });
}
