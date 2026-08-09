import { spawnSync } from "node:child_process";

const SALVAGE_TIMEOUT_MS = (() => {
  const raw = process.env.CATALYST_OPEN_PR_GATE_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === "") return 15_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 15_000;
})();

export function probeBranchSalvage(_ticket, {
  branchName,
  repoRoot,
  baseBranch = "main",
  run = spawnSync,
} = {}) {
  if (!branchName) return { unverifiable: true, reason: "branch-underivable" };
  if (!repoRoot) return { unverifiable: true, reason: "repo-underivable" };
  const options = { cwd: repoRoot, encoding: "utf8", timeout: SALVAGE_TIMEOUT_MS };
  try {
    const remote = run("git", ["ls-remote", "--heads", "origin", branchName], options);
    if (remote?.status !== 0) {
      return { remoteBranchExists: undefined, commitsAhead: null, branchName, unverifiable: true };
    }
    if (!String(remote.stdout ?? "").trim()) {
      return { remoteBranchExists: false, commitsAhead: 0, branchName };
    }
    const count = run("git", ["rev-list", "--count", `origin/${baseBranch}..origin/${branchName}`], options);
    if (count?.status !== 0) return { remoteBranchExists: true, commitsAhead: null, branchName };
    const commitsAhead = Number.parseInt(String(count.stdout ?? "").trim(), 10);
    return {
      remoteBranchExists: true,
      commitsAhead: Number.isFinite(commitsAhead) ? commitsAhead : null,
      branchName,
    };
  } catch (error) {
    return {
      remoteBranchExists: undefined,
      commitsAhead: null,
      branchName,
      unverifiable: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
