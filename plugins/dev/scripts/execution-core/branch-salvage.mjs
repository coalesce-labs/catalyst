import { spawnSync } from "node:child_process";

// CAT-11 (review): this probe runs SYNCHRONOUSLY inside the scheduler tick
// (buildBoardContext → getBranchSalvage → git ls-remote, a network spawn), so its
// cap is load-bearing in a way the open-PR gate's is not. open-pr-gate.mjs treats an
// explicit 0 as "disabled / no timeout"; inheriting that here would let one operator
// knob turn a hung remote (auth prompt, dead network) into a wedged tick. Take the
// gate's value only when it is a POSITIVE number, else fall back to the default.
const SALVAGE_TIMEOUT_MS = (() => {
  const raw = process.env.CATALYST_OPEN_PR_GATE_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === "") return 15_000;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
})();

// CAT-11 (review): execution-core pushes orphaned work to `refs/heads/<TICKET>`, NOT
// to Linear's `branchName` slug — dispatch.mjs passes `expectedBranch: ticket`,
// worktree.mjs invokes `create-worktree.sh <TICKET> main`, and CTL-1640 seeds from
// `origin/<TICKET>`. Probing only the Linear slug returned `{remoteBranchExists:false,
// commitsAhead:0}` for exactly the orphan population this feature exists to rescue,
// firing recovery-pass RUBRIC FOUR's "nothing to rescue" ESCALATE clause. Probe the
// ticket-key ref FIRST, then fall back to any other candidate (an interactively
// created branch still follows Linear's naming), and report which one answered.
function candidateBranches(ticket, branchName) {
  const ordered = [];
  for (const candidate of [ticket, branchName]) {
    const name = candidate == null ? "" : String(candidate).trim();
    if (name && !ordered.includes(name)) ordered.push(name);
  }
  return ordered;
}

export function probeBranchSalvage(ticket, {
  branchName,
  repoRoot,
  baseBranch = "main",
  run = spawnSync,
} = {}) {
  const candidates = candidateBranches(ticket, branchName);
  if (candidates.length === 0) return { unverifiable: true, reason: "branch-underivable" };
  if (!repoRoot) return { unverifiable: true, reason: "repo-underivable" };
  const options = { cwd: repoRoot, encoding: "utf8", timeout: SALVAGE_TIMEOUT_MS };
  try {
    let found = null;
    for (const candidate of candidates) {
      const remote = run("git", ["ls-remote", "--heads", "origin", candidate], options);
      // A failed probe is UNVERIFIABLE, not absence: returning "no branch" here would
      // let a transient network/auth failure read as "nothing to rescue".
      if (remote?.status !== 0) {
        return {
          remoteBranchExists: undefined, commitsAhead: null,
          branchName: candidate, candidates, unverifiable: true, reason: "ls-remote-failed",
        };
      }
      if (String(remote.stdout ?? "").trim()) { found = candidate; break; }
    }
    if (!found) {
      return { remoteBranchExists: false, commitsAhead: 0, branchName: candidates[0], candidates };
    }
    // CAT-11 (review): `rev-list origin/<base>..origin/<branch>` reads LOCAL
    // remote-tracking refs. The daemon's clone has usually never fetched a branch
    // pushed from a worktree (or from another host), so fetch the single ref first —
    // the same explicit refspec create-worktree.sh:304 uses — before counting.
    run("git", ["fetch", "--no-tags", "--quiet", "origin",
      `+refs/heads/${found}:refs/remotes/origin/${found}`], options);
    const count = run("git", ["rev-list", "--count", `origin/${baseBranch}..origin/${found}`], options);
    if (count?.status !== 0) {
      return { remoteBranchExists: true, commitsAhead: null, branchName: found, candidates,
        reason: "rev-list-failed" };
    }
    const commitsAhead = Number.parseInt(String(count.stdout ?? "").trim(), 10);
    return {
      remoteBranchExists: true,
      commitsAhead: Number.isFinite(commitsAhead) ? commitsAhead : null,
      branchName: found,
      candidates,
    };
  } catch (error) {
    return {
      remoteBranchExists: undefined,
      commitsAhead: null,
      branchName: candidates[0],
      candidates,
      unverifiable: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
