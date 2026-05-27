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
import { parseArgs, ArgError } from "./args.mjs";
import { ghPrList } from "./worktrees.mjs";

const SCOPES = new Set(["local", "remote", "both"]);

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
  const plannedRows = [];
  const skippedRows = [];
  for (const row of rows) {
    if (planned >= max) {
      skippedRows.push({ name: row.name, reason: "max-reached" });
      continue;
    }
    if (!allowed.has(row.classification)) {
      // Unmerged classes without --force, plus WORKTREE_BACKED/ACTIVE, are
      // intentionally untouched — surface the machine reason for --json.
      const reason = FORCE_CLASSES.includes(row.classification)
        ? "force-required"
        : "not-prunable";
      skippedRows.push({ name: row.name, reason });
      continue;
    }

    // Which side does this class delete from?
    const side =
      row.classification === "MERGED_REMOTE" || row.classification === "STALE_REMOTE"
        ? "remote"
        : row.classification === "MERGED_LOCAL" || row.classification === "ORPHAN_LOCAL"
          ? "local"
          : null; // CLOSED_NO_MERGE: delete whichever side(s) exist
    const sides = side ? [side] : [row.scope === "remote" ? "remote" : "local"];

    for (const s of sides) {
      if (scope !== "both" && scope !== s) {
        skippedRows.push({ name: row.name, reason: "out-of-scope" });
        continue;
      }
      planned++;
      plannedRows.push({ name: row.name, scope: s, classification: row.classification });
      if (!live) {
        log(`[dry-run] would delete ${s} branch ${row.name} (${row.classification})`);
        continue;
      }
      if (s === "remote") await deleteRemoteBranch(row.name);
      else await deleteLocalBranch(row.name);
      deleted++;
    }
  }
  return { planned, deleted, plannedRows, skippedRows };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

// The strict spec the shared parser validates against. Unknown flags and
// non-numeric --max/--stale-days throw ArgError instead of silently reverting
// to a default or NaN-ing a guard (devex findings #1, #2).
const BRANCHES_SPEC = {
  booleans: ["json", "yes", "dry-run", "force"],
  numbers: ["max", "stale-days"],
  strings: ["scope"],
};

/**
 * parseBranchArgs — strict flag parser for the branches subcommands. Delegates
 * validation to the shared `parseArgs(argv, spec)` (rejects unknown flags and
 * non-numeric numbers), then maps the kebab-case result onto the option names
 * cmdList/runBranchesPrune consume: --dry-run→dryRun, --stale-days→staleDays.
 * Also validates --scope ∈ {local,remote,both}; an out-of-range value would
 * silently neuter the prune side-filter, so it throws ArgError.
 *
 * @throws {ArgError} on an unknown flag, a missing value, a non-numeric number,
 *                    or a --scope outside {local,remote,both}.
 */
export function parseBranchArgs(argv) {
  const raw = parseArgs(argv, BRANCHES_SPEC);
  const out = {};
  if (raw.json !== undefined) out.json = raw.json;
  if (raw.yes !== undefined) out.yes = raw.yes;
  if (raw["dry-run"] !== undefined) out.dryRun = raw["dry-run"];
  if (raw.force !== undefined) out.force = raw.force;
  if (raw.scope !== undefined) {
    if (!SCOPES.has(raw.scope)) {
      throw new ArgError(`flag --scope expects one of local|remote|both, got '${raw.scope}'`);
    }
    out.scope = raw.scope;
  }
  if (raw.max !== undefined) out.max = raw.max;
  if (raw["stale-days"] !== undefined) out.staleDays = raw["stale-days"];
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
  const { planned, deleted, plannedRows, skippedRows } = await runBranchesPrune({ ...opts, rows });
  const isDryRun = !(opts.yes && !opts.dryRun);
  if (opts.json) {
    // One structured object so a headless agent can inspect the destructive
    // plan before acting: `branches prune --dry-run --json | jq '.planned'`.
    process.stdout.write(
      `${JSON.stringify({
        dryRun: isDryRun,
        planned: plannedRows,
        skipped: skippedRows,
        deleted,
      })}\n`
    );
    return 0;
  }
  const verb = isDryRun ? "planned (dry-run)" : "deleted";
  process.stderr.write(`branches prune: ${deleted || planned} ${verb}\n`);
  return 0;
}

function usage() {
  process.stderr.write(
    "Usage: catalyst-execution-core branches {list|prune} [flags]\n" +
      "  list  [--json] [--scope local|remote|both] [--stale-days N]\n" +
      "  prune [--yes] [--dry-run] [--json] [--scope ...] [--force] [--max N]\n"
  );
}

async function main(argv) {
  const sub = argv[0];
  const opts = parseBranchArgs(argv.slice(1));
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
      process.stderr.write(`branches: ${err.message}\n`);
      process.exit(1);
    });
}
