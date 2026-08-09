import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

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

// CAT-11 (Codex P1 round 1): the remote probe alone can never produce the
// `worktreeUnpushed === false` that classifyRevivalRoute REQUIRES before it will
// pick the dispatchable `resume-from-remote` route. In production nothing supplied
// that field, so every discovered branch classified as non-dispatchable
// `unknown-salvage` and RUBRIC FOUR's rescue path was unreachable — the passing
// unit test only worked because it injected `worktreeUnpushed: false` by hand.
// Supply the LOCAL half of the evidence here so production produces it too:
//   - no worktree path derivable  → undefined (unknown; unchanged hold behaviour)
//   - path derivable, ABSENT      → false (no local worktree ⇒ no unpushed local work)
//   - path present, probe clean   → whether any local commit is on no remote
//   - path present, probe FAILED  → undefined (never assert "no unpushed" on a failure)
export function probeWorktreeUnpushed(worktreePath, { run = spawnSync, timeoutMs } = {}) {
  const path = worktreePath == null ? "" : String(worktreePath).trim();
  if (!path) return undefined;
  if (!existsSync(path)) return false;
  try {
    const r = run("git", ["rev-list", "--count", "--branches", "--not", "--remotes"],
      { cwd: path, encoding: "utf8", timeout: timeoutMs ?? SALVAGE_TIMEOUT_MS });
    if (r?.status !== 0) return undefined;
    const n = Number.parseInt(String(r.stdout ?? "").trim(), 10);
    return Number.isFinite(n) ? n > 0 : undefined;
  } catch {
    return undefined;
  }
}

// CAT-11 (Codex P1 round 1): resolve the ticket's LOCAL worktree from git itself
// rather than guessing a path convention. `git worktree list --porcelain` is the
// authoritative answer to "does this host still hold a worktree for this branch",
// and its ABSENCE is exactly the orphan cohort RUBRIC FOUR exists to rescue — that
// absence is what lets probeWorktreeUnpushed return a definite `false`.
// Returns: a path when one is checked out, "" when definitively none, null on failure.
export function resolveWorktreePath(candidates, { repoRoot, run = spawnSync, timeoutMs } = {}) {
  if (!repoRoot) return null;
  try {
    const r = run("git", ["worktree", "list", "--porcelain"],
      { cwd: repoRoot, encoding: "utf8", timeout: timeoutMs ?? SALVAGE_TIMEOUT_MS });
    if (r?.status !== 0) return null;
    const wanted = new Set((candidates ?? []).map((c) => `refs/heads/${c}`));
    let current = null;
    for (const line of String(r.stdout ?? "").split("\n")) {
      if (line.startsWith("worktree ")) current = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch ") && wanted.has(line.slice("branch ".length).trim())) {
        return current;
      }
    }
    return "";
  } catch {
    return null;
  }
}

export function probeBranchSalvage(ticket, {
  branchName,
  repoRoot,
  // CAT-11 (Codex P2 round 1): the enrolled repository's base branch is not always
  // `main`. Against a `master`/`develop` repo the hardcoded default made rev-list
  // either fail (commitsAhead: null) or count against the wrong history, so genuine
  // orphaned commits never satisfied RUBRIC FOUR's `commitsAhead >= 1` trigger.
  baseBranch = "main",
  worktreePath,
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
    // Prefer an explicitly supplied path (tests / callers that already know it);
    // otherwise ask git. A null resolution stays UNKNOWN (undefined), never `false`.
    let localPath = worktreePath;
    if (localPath === undefined) localPath = resolveWorktreePath(candidates, { repoRoot, run });
    // null → probe failed (UNKNOWN). "" → git is certain no worktree is checked out
    // for this branch, which is a definite "no unpushed local work" (false).
    const worktreeUnpushed = localPath === null ? undefined
      : localPath === "" ? false
      : probeWorktreeUnpushed(localPath, { run });
    if (!found) {
      return { remoteBranchExists: false, commitsAhead: 0, branchName: candidates[0], candidates,
        worktreeUnpushed };
    }
    // CAT-11 (review): `rev-list origin/<base>..origin/<branch>` reads LOCAL
    // remote-tracking refs. The daemon's clone has usually never fetched a branch
    // pushed from a worktree (or from another host), so fetch the single ref first —
    // the same explicit refspec create-worktree.sh:304 uses — before counting.
    const fetched = run("git", ["fetch", "--no-tags", "--quiet", "origin",
      `+refs/heads/${found}:refs/remotes/origin/${found}`], options);
    // CAT-11 (Codex P2 round 1): do NOT ignore this status. When the fetch times out
    // or fails auth while a STALE `origin/<found>` tracking ref already exists, the
    // rev-list below still succeeds — against stale local data — and publishes a
    // verifiable-looking commitsAhead that can report already-merged work as
    // rescuable, or miss newer orphaned commits. A failed fetch means the count is
    // UNVERIFIABLE, not merely approximate.
    if (fetched?.status !== 0) {
      return { remoteBranchExists: true, commitsAhead: null, branchName: found, candidates,
        worktreeUnpushed, unverifiable: true, reason: "fetch-failed" };
    }
    const count = run("git", ["rev-list", "--count", `origin/${baseBranch}..origin/${found}`], options);
    if (count?.status !== 0) {
      return { remoteBranchExists: true, commitsAhead: null, branchName: found, candidates,
        worktreeUnpushed, reason: "rev-list-failed" };
    }
    const commitsAhead = Number.parseInt(String(count.stdout ?? "").trim(), 10);
    return {
      remoteBranchExists: true,
      commitsAhead: Number.isFinite(commitsAhead) ? commitsAhead : null,
      branchName: found,
      candidates,
      worktreeUnpushed,
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
