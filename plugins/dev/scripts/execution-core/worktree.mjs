// worktree.mjs — execution-core git-worktree lifecycle (CTL-582).
//
// One worktree per ticket at ~/catalyst/wt/<projectKey>/<TICKET>, created on
// first dispatch and reused across all 9 phases. This module is the D9 worktree
// seam: create + teardown both flow through it, so a cloud executor swaps the
// worktree model at one place.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// create-worktree.sh sits one directory up from execution-core/.
const CREATE_WORKTREE_BIN = fileURLToPath(new URL("../create-worktree.sh", import.meta.url));

// createWorktree — run create-worktree.sh with cwd === repoRoot so the script
// resolves projectKey / worktreeDir from that repo's .catalyst/config.json.
// `--reuse-existing` makes it idempotent: the second…ninth phase of a ticket
// short-circuit to the existing worktree. Returns { code, worktreePath, stderr }
// — never throws. `worktreePath` is parsed from the trailing WORKTREE_PATH=
// line create-worktree.sh prints on a successful create and on the
// --reuse-existing short-circuit.
export function createWorktree({ ticket, repoRoot }, { spawn = spawnSync } = {}) {
  const res = spawn(CREATE_WORKTREE_BIN, [ticket, "main", "--reuse-existing"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.error) return { code: 127, worktreePath: null, stderr: res.error.message };
  const m = /^WORKTREE_PATH=(.+)$/m.exec(res.stdout ?? "");
  return {
    code: res.status ?? 0,
    worktreePath: m ? m[1].trim() : null,
    stderr: res.stderr ?? "",
  };
}

// parseWorktreeForBranch — pure. Find the worktree path bound to branch
// refs/heads/<ticket> in `git worktree list --porcelain` output. The porcelain
// format is blank-line-separated blocks; each block opens with `worktree <path>`
// and (for a checked-out branch) carries a `branch refs/heads/<name>` line. The
// branch match is exact, so CTL-7 never matches CTL-70.
export function parseWorktreeForBranch(porcelain, ticket) {
  const want = `refs/heads/${ticket}`;
  let currentPath = null;
  for (const line of (porcelain ?? "").split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ") && line.slice("branch ".length).trim() === want) {
      return currentPath;
    }
  }
  return null;
}

// teardownWorktree — remove a ticket's worktree. The path is resolved from
// `git worktree list --porcelain` (the worktree on branch refs/heads/<ticket>)
// rather than reconstructed, so it is correct regardless of projectKey /
// worktreeDir config. Returns true when the worktree is gone — removed now, or
// already absent (the idempotent end state); false only when git could not
// list or could not remove. Never throws.
export function teardownWorktree({ repoRoot, ticket } = {}, { spawn = spawnSync } = {}) {
  if (!repoRoot || !ticket) return false;
  const list = spawn("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
    encoding: "utf8",
  });
  if (list.error || (list.status ?? 1) !== 0) return false; // cannot list — retry later
  const path = parseWorktreeForBranch(list.stdout ?? "", ticket);
  if (!path) return true; // no worktree for this ticket — already torn down
  const rm = spawn("git", ["-C", repoRoot, "worktree", "remove", "--force", path], {
    encoding: "utf8",
  });
  return !rm.error && (rm.status ?? 1) === 0;
}
