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
//
// --json (CTL-649 devex finding) emits ONE structured object describing the
// whole plan — { dryRun, steps:[{step, ...result}], aborted, abortedAt } — so a
// headless agent can inspect the entire tidy in one shot instead of scraping
// four steps' human lines. json:true is threaded down to each sub-prune so they
// return their plannedRows/skippedRows rather than printing.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRows as buildSessionRows, runPrune as runSessionsPrune } from "./sessions.mjs";
import { buildRows as buildWorktreeRows, runWorktreesPrune } from "./worktrees.mjs";
import { buildRows as buildBranchRows, runBranchesPrune } from "./branches.mjs";
import { parseArgs, ArgError } from "./args.mjs";
import { resolveRepoRoot } from "./repo.mjs";

async function defaultCmdSessions(opts) {
  const rows = await buildSessionRows({});
  return runSessionsPrune({ ...opts, rows });
}

async function defaultCmdWorktrees(opts) {
  const rows = await buildWorktreeRows({ repoRoot: opts.repoRoot });
  return runWorktreesPrune({ ...opts, rows });
}

async function defaultCmdBranches(opts) {
  const rows = await buildBranchRows({ repoRoot: opts.repoRoot });
  return runBranchesPrune({ ...opts, rows });
}

async function defaultCmdGitWorktreePrune(opts = {}) {
  // Anchor cwd to a resolved repoRoot (CTL-675); keep the best-effort swallow —
  // this only mutates admin records and runs after worktrees+branches complete,
  // so outside-a-repo the chain has already aborted before this is reached.
  try {
    execFileSync("git", ["worktree", "prune"], {
      cwd: opts.repoRoot ?? resolveRepoRoot(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    /* best-effort admin-record cleanup */
  }
}

/**
 * runTidy — run the four steps in order, aborting on the first failure. Returns
 * { completed, failedAt, steps, aborted, abortedAt }:
 *   • completed  string[]    step names that ran without throwing
 *   • failedAt   string|null the step that threw (legacy field, kept for callers)
 *   • steps      array       one { step, ...stepResult } per step that ran; in
 *                            json mode each carries the sub-prune's structured
 *                            plannedRows/skippedRows (or { error } for the step
 *                            that threw / git-wt-prune which returns nothing)
 *   • aborted    boolean     true if a step threw
 *   • abortedAt  string|null the step name where the chain aborted (== failedAt)
 *
 * Never throws — a step error is captured so an operator sees a clean
 * "aborted at <step>" rather than a stack trace. git worktree prune is skipped
 * under --dry-run. json:true is propagated to every sub-prune.
 */
export async function runTidy({
  cmdSessions = defaultCmdSessions,
  cmdWorktrees = defaultCmdWorktrees,
  cmdBranches = defaultCmdBranches,
  cmdGitWorktreePrune = defaultCmdGitWorktreePrune,
  log = (m) => process.stderr.write(`${m}\n`),
  dryRun = false,
  yes = false,
  json = false,
  ...rest
} = {}) {
  const propagated = { ...rest, dryRun, yes, json };
  const completed = [];
  const steps = [];

  const pruneSteps = [
    ["sessions", cmdSessions],
    ["worktrees", cmdWorktrees],
    ["branches", cmdBranches],
  ];
  for (const [name, fn] of pruneSteps) {
    try {
      const result = await fn(propagated);
      completed.push(name);
      steps.push({ step: name, ...(result && typeof result === "object" ? result : {}) });
    } catch (err) {
      log(`tidy: aborted at ${name} — ${err.message}`);
      steps.push({ step: name, error: err.message });
      return { completed, failedAt: name, steps, aborted: true, abortedAt: name };
    }
  }

  // git worktree prune only mutates admin records; pointless (and a real
  // mutation) under dry-run, so gate it.
  if (!dryRun) {
    try {
      await cmdGitWorktreePrune(propagated);
      completed.push("git-wt-prune");
      steps.push({ step: "git-worktree-prune" });
    } catch (err) {
      log(`tidy: aborted at git-wt-prune — ${err.message}`);
      steps.push({ step: "git-worktree-prune", error: err.message });
      return { completed, failedAt: "git-wt-prune", steps, aborted: true, abortedAt: "git-wt-prune" };
    }
  }

  return { completed, failedAt: null, steps, aborted: false, abortedAt: null };
}

// ─── arg parsing ─────────────────────────────────────────────────────────────

// The strict spec the shared parser validates against. tidy is a superset of
// the three sub-prunes' flags — booleans + numbers covering sessions
// (--include-idle/--include-interactive/--min-idle-seconds), worktrees
// (--include-stale/--stale-days), and branches (--force). Unknown flags and
// non-numeric numbers throw ArgError instead of silently reverting to a default
// or NaN-ing a guard (devex findings #1, #2).
const TIDY_SPEC = {
  booleans: [
    "json",
    "yes",
    "dry-run",
    "include-idle",
    "include-interactive",
    "include-stale",
    "force",
  ],
  numbers: ["max", "min-idle-seconds", "stale-days"],
  strings: ["repo-root"],
};

/**
 * parseTidyArgs — strict flag parser for `tidy`. Delegates validation to the
 * shared `parseArgs(argv, spec)` (rejects unknown flags and non-numeric
 * numbers), then maps the kebab-case result onto the option names the
 * sub-prunes consume via runTidy's `...rest`: --dry-run→dryRun,
 * --include-idle→includeIdle, --include-interactive→includeInteractive,
 * --include-stale→includeStale, --min-idle-seconds→minIdleMs (×1000),
 * --stale-days→staleDays.
 *
 * @throws {ArgError} on an unknown flag, a missing value, or a non-numeric number.
 */
export function parseTidyArgs(argv) {
  const raw = parseArgs(argv, TIDY_SPEC);
  const out = {};
  if (raw.json !== undefined) out.json = raw.json;
  if (raw.yes !== undefined) out.yes = raw.yes;
  if (raw["dry-run"] !== undefined) out.dryRun = raw["dry-run"];
  if (raw["include-idle"] !== undefined) out.includeIdle = raw["include-idle"];
  if (raw["include-interactive"] !== undefined) {
    out.includeInteractive = raw["include-interactive"];
  }
  if (raw["include-stale"] !== undefined) out.includeStale = raw["include-stale"];
  if (raw.force !== undefined) out.force = raw.force;
  if (raw.max !== undefined) out.max = raw.max;
  if (raw["min-idle-seconds"] !== undefined) out.minIdleMs = raw["min-idle-seconds"] * 1000;
  if (raw["stale-days"] !== undefined) out.staleDays = raw["stale-days"];
  if (raw["repo-root"] !== undefined) out.repoRoot = raw["repo-root"];
  return out;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function usage() {
  process.stderr.write(
    "Usage: catalyst-execution-core tidy [flags]\n" +
      "  Runs sessions → worktrees → branches → git worktree prune in safe order.\n" +
      "  [--json] [--dry-run] [--yes] [--max N]\n" +
      "  [--include-idle] [--include-interactive] [--min-idle-seconds N]\n" +
      "  [--include-stale] [--stale-days N] [--force] [--repo-root <path>]\n" +
      "  Repo resolution: --repo-root → $CATALYST_REPO_ROOT → current repo → first registry project.\n"
  );
}

async function main(argv) {
  const opts = parseTidyArgs(argv);
  const result = await runTidy(opts);

  if (opts.json) {
    // One structured object describing the whole plan so a headless agent can
    // inspect every step at once: `tidy --dry-run --json | jq '.steps'`.
    const isDryRun = !(opts.yes && !opts.dryRun);
    process.stdout.write(
      `${JSON.stringify({
        dryRun: isDryRun,
        steps: result.steps,
        aborted: result.aborted,
        abortedAt: result.abortedAt,
      })}\n`
    );
    return result.aborted ? 1 : 0;
  }

  const { completed, failedAt } = result;
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
      process.stderr.write(`tidy: ${err.message}\n`);
      process.exit(1);
    });
}
