// dirty-tree-classifier.mjs — CTL-1064 Category A pure classifier.
//
// Classifies a rebase_refused_dirty_tree stall as 'clear-retry' when the
// worktree's porcelain dirt, filtered through REBASE_NOISE_PATHS and the
// deleted-node_modules predicate, is fully empty. Any remaining real dirt
// → 'escalate' (fail-closed). All IO injected; pure given the evidence.
//
// SYNC OBLIGATION: REBASE_NOISE_PATHS must be kept in sync with
// worktree-rebase.sh:38-42 (plugins/dev/scripts/lib/worktree-rebase.sh).
// The bash array is the canonical source; this JS mirror is the secondary.
// When you change one, change the other. A CI grep guards the comment.

import { cleanPorcelain } from "./worktree-safety.mjs";

// REBASE_NOISE_PATHS — JS mirror of WORKTREE_NOISE_PATHS in worktree-rebase.sh:38.
// These are the paths that diverge per-worktree and are stashed before a rebase,
// then popped after (CTL-990 / CTL-678 rationale in the bash source).
// SYNC: plugins/dev/scripts/lib/worktree-rebase.sh:38-42
export const REBASE_NOISE_PATHS = Object.freeze([
  ".catalyst/config.json",
  ".claude/config.json",
  ".claude/settings.json",
  ".trunk/actions",
  ".trunk/logs",
  ".trunk/notifications",
  ".trunk/out",
  ".trunk/tools",
]);

// isNodeModulesDeletion — returns true when a porcelain line represents a PURE
// deletion of node_modules/ (tracked deletion: 'D  node_modules' or
// ' D node_modules/...'). A modification (' M node_modules/...') is NOT treated
// as noise — only deletions of the directory or its contents qualify.
// Risk: a branch that legitimately removes node_modules from tracking would be
// auto-cleared; the recorded intent + R11/R12 backstop catches a re-stall.
export function isNodeModulesDeletion(line) {
  if (!line || line.length < 4) return false;
  // Status chars are at positions 0-1; path starts at position 3.
  const xy = line.slice(0, 2);
  // Must have at least one 'D' in the status column (deleted from index or worktree).
  // Exclude modifications (both chars are space or M/A/R/C/U).
  if (!xy.includes("D") && !xy.includes("d")) return false;
  // Reject if any non-D/space/? status — be strict about "pure deletion".
  const statusChars = xy.replace(/[ D?]/gi, "");
  if (statusChars.length > 0) return false;
  const path = line.slice(3).trim().replace(/^"|"$/g, "");
  return path === "node_modules" || path.startsWith("node_modules/");
}

// filterMachineLocalDirt — returns the porcelain lines that are NOT in
// REBASE_NOISE_PATHS and NOT deleted node_modules. Non-empty result means
// real work is present that the rebase stash would not absorb.
export function filterMachineLocalDirt(lines) {
  return lines.filter((line) => {
    if (!line || !line.trim()) return false;
    // Use cleanPorcelain's filter for the canonical noise paths.
    if (cleanPorcelain(line, REBASE_NOISE_PATHS).length === 0) return false;
    // Additional: deleted node_modules is machine-local-safe.
    if (isNodeModulesDeletion(line)) return false;
    return true;
  });
}

// classifyDirtyTreeRecoverable — PURE. Returns:
//   { action: 'clear-retry' } — all dirt is machine-local noise; safe to auto-clear.
//   { action: 'escalate', reason }  — real dirt present; human decision required.
//   { action: 'skip', reason }      — wrong stall reason, live session, terminal,
//                                     already cleared, or unreadable porcelain.
//
// evidence shape:
//   stalledReason         string   (must be 'rebase_refused_dirty_tree')
//   porcelain             string|null   (`git status --porcelain` output; null = unreadable)
//   liveSessionInWorktree bool
//   linearTerminal        bool
//   alreadyCleared        bool     (.unstuck-cleared-<phase>.applied present)
export function classifyDirtyTreeRecoverable(evidence = {}) {
  const { stalledReason, porcelain, liveSessionInWorktree, linearTerminal, alreadyCleared } = evidence;

  if (stalledReason !== "rebase_refused_dirty_tree") {
    return { action: "skip", reason: "wrong-stall-reason" };
  }
  if (liveSessionInWorktree) {
    return { action: "skip", reason: "live-session-in-worktree" };
  }
  if (linearTerminal) {
    return { action: "skip", reason: "linear-terminal" };
  }
  if (alreadyCleared) {
    return { action: "skip", reason: "already-cleared" };
  }
  // Fail-closed: null/unreadable porcelain → escalate (never auto-act on unknown state).
  if (porcelain === null || porcelain === undefined) {
    return { action: "escalate", reason: "unreadable-porcelain" };
  }

  const lines = porcelain
    .split("\n")
    .filter((l) => l.trim().length > 0);

  const realDirt = filterMachineLocalDirt(lines);

  if (realDirt.length === 0) {
    return { action: "clear-retry" };
  }
  return { action: "escalate", reason: "real-dirt-present", dirt: realDirt };
}
