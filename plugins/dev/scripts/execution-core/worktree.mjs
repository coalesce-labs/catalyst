// worktree.mjs — execution-core git-worktree lifecycle (CTL-582).
//
// One worktree per ticket at ~/catalyst/wt/<projectKey>/<TICKET>, created on
// first dispatch and reused across all 9 phases. This module is the D9 worktree
// seam: create + teardown both flow through it, so a cloud executor swaps the
// worktree model at one place.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// create-worktree.sh sits one directory up from execution-core/.
const CREATE_WORKTREE_BIN = fileURLToPath(
  new URL("../create-worktree.sh", import.meta.url),
);

// createWorktree — run create-worktree.sh with cwd === repoRoot so the script
// resolves projectKey / worktreeDir from that repo's .catalyst/config.json.
// `--reuse-existing` makes it idempotent: the second…ninth phase of a ticket
// short-circuit to the existing worktree. Returns { code, worktreePath, stderr }
// — never throws. `worktreePath` is parsed from the trailing WORKTREE_PATH=
// line create-worktree.sh always prints on success.
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
