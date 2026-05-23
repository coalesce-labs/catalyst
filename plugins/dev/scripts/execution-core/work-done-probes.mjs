// work-done-probes.mjs — per-phase "is the work committed already?" probes for the
// CTL-574 reclaim sweep. Pure given the injected runGit; spawns nothing of its own
// at module load.
//
// The registry maps phase name → probe function. Phases without an entry are
// not-applicable to commit-state reclaim (research/plan have artifact-on-disk
// shapes that can be added later; verify/review have no filesystem artifact).

import { spawnSync } from "node:child_process";
import { parseWorktreeForBranch } from "./worktree.mjs";

// defaultRunGit — `git <args>` with stdout/stderr captured. Returns
// { code, stdout, stderr }; never throws.
export function defaultRunGit(args, { spawn = spawnSync } = {}) {
  const res = spawn("git", args, { encoding: "utf8" });
  if (res.error) return { code: 127, stdout: "", stderr: res.error.message };
  return { code: res.status ?? 0, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

// implementProbe — commits-ahead>0 vs origin/main + clean tree on the worktree
// bound to refs/heads/<ticket>. The worktree path is resolved from `git worktree
// list --porcelain` (not reconstructed from projectKey config) so it's correct
// regardless of any per-team config drift — same precedent as teardownWorktree.
// Returns false on any git failure (safe default — missing worktree, stale ref,
// permission error, etc.).
function implementProbe({ ticket, repoRoot } = {}, { runGit = defaultRunGit } = {}) {
  if (!ticket || !repoRoot) return false;

  const list = runGit(["-C", repoRoot, "worktree", "list", "--porcelain"]);
  if (list.code !== 0) return false;
  const worktreePath = parseWorktreeForBranch(list.stdout, ticket);
  if (!worktreePath) return false;

  const ahead = runGit(["-C", worktreePath, "rev-list", "--count", "origin/main..HEAD"]);
  if (ahead.code !== 0) return false;
  if (Number(ahead.stdout.trim() || "0") <= 0) return false;

  const status = runGit(["-C", worktreePath, "status", "--porcelain"]);
  if (status.code !== 0) return false;
  return status.stdout.trim() === "";
}

// WORK_DONE_PROBES — phase → probe. Adding a probe is the entire opt-in for a
// phase to participate in the CTL-574 reclaim sweep. Phases without an entry
// remain CTL-587's responsibility (auto-revival).
export const WORK_DONE_PROBES = {
  implement: implementProbe,
};

// hasProbe — true when the given phase has a registered probe. Used by the
// reclaim function to classify a `dead` worker as 'not-applicable' when the
// phase has no work-done probe yet.
export function hasProbe(phase) {
  return Object.prototype.hasOwnProperty.call(WORK_DONE_PROBES, phase);
}
