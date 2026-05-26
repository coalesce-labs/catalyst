// tidy.mjs — `catalyst-execution-core tidy` (CTL-649 Phase 8).
//
// Composes the three resource prunes in the ONLY safe order and finishes with
// `git worktree prune` to clear stale admin records:
//
//   sessions → worktrees → branches → git worktree prune
//
// Ordering is load-bearing: removing a worktree before stopping its sessions
// produces ORPHANs (the original Component-5 leak, inverted). The umbrella
// enforces it; the standalone nouns let an operator do otherwise on purpose.
//
// A failing step aborts the chain — better to stop than to run worktree-prune
// after a half-done session sweep and manufacture fresh orphans. --dry-run and
// --yes propagate to every step.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRows as buildSessionRows, runPrune as runSessionsPrune } from "./sessions.mjs";
import { buildRows as buildWorktreeRows, runWorktreesPrune } from "./worktrees.mjs";
import { buildRows as buildBranchRows, runBranchesPrune } from "./branches.mjs";

async function defaultCmdSessions(opts) {
  const rows = await buildSessionRows({});
  return runSessionsPrune({ ...opts, rows });
}

async function defaultCmdWorktrees(opts) {
  const rows = await buildWorktreeRows({});
  return runWorktreesPrune({ ...opts, rows });
}

async function defaultCmdBranches(opts) {
  const rows = await buildBranchRows({});
  return runBranchesPrune({ ...opts, rows });
}

async function defaultCmdGitWorktreePrune() {
  try {
    execFileSync("git", ["worktree", "prune"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    /* best-effort admin-record cleanup */
  }
}

/**
 * runTidy — run the four steps in order, aborting on the first failure. Returns
 * { completed: string[], failedAt: string|null }. Never throws — a step error
 * is captured so an operator sees a clean "aborted at <step>" rather than a
 * stack trace. git worktree prune is skipped under --dry-run.
 */
export async function runTidy({
  cmdSessions = defaultCmdSessions,
  cmdWorktrees = defaultCmdWorktrees,
  cmdBranches = defaultCmdBranches,
  cmdGitWorktreePrune = defaultCmdGitWorktreePrune,
  log = (m) => process.stderr.write(`${m}\n`),
  dryRun = false,
  yes = false,
  ...rest
} = {}) {
  const propagated = { ...rest, dryRun, yes };
  const completed = [];

  const pruneSteps = [
    ["sessions", cmdSessions],
    ["worktrees", cmdWorktrees],
    ["branches", cmdBranches],
  ];
  for (const [name, fn] of pruneSteps) {
    try {
      await fn(propagated);
      completed.push(name);
    } catch (err) {
      log(`tidy: aborted at ${name} — ${err.message}`);
      return { completed, failedAt: name };
    }
  }

  // git worktree prune only mutates admin records; pointless (and a real
  // mutation) under dry-run, so gate it.
  if (!dryRun) {
    try {
      await cmdGitWorktreePrune(propagated);
      completed.push("git-wt-prune");
    } catch (err) {
      log(`tidy: aborted at git-wt-prune — ${err.message}`);
      return { completed, failedAt: "git-wt-prune" };
    }
  }

  return { completed, failedAt: null };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--yes":
        out.yes = true;
        break;
      case "--dry-run":
        out.dryRun = true;
        break;
      case "--include-idle":
        out.includeIdle = true;
        break;
      case "--include-stale":
        out.includeStale = true;
        break;
      case "--force":
        out.force = true;
        break;
      case "--max":
        out.max = Number(argv[++i]);
        break;
      default:
        break;
    }
  }
  return out;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const { completed, failedAt } = await runTidy(opts);
  const verb = opts.yes && !opts.dryRun ? "tidied" : "planned (dry-run)";
  process.stderr.write(`tidy: ${verb} — steps: ${completed.join(", ") || "none"}\n`);
  return failedAt ? 1 : 0;
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
      process.stderr.write(`tidy: ${err.message}\n`);
      process.exit(1);
    });
}
