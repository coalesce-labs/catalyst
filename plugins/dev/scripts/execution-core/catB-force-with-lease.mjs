// catB-force-with-lease.mjs — CTL-1064 Category B pure classifier.
//
// Classifies a source_conflict_ctl708_unavailable stall as 'force-push' ONLY
// when the worktree already holds a clean rebase of the ticket's own commits on
// top of origin/main. Three-part safety gate (all must pass):
//   1. Noise-filtered porcelain is empty (no real dirt, via REBASE_NOISE_PATHS).
//   2. Every commit subject on HEAD..origin/main contains the ticket key (no foreign
//      commits; non-empty set).
//   3. HEAD is a strict descendant of origin/main (merge-base check).
//
// If any gate fails → skip with a reason code (never escalate from the classifier
// — the caller decides). The act seam (Phase 7 scheduler-side) runs the real
// git push --force-with-lease.
//
// All git probes are injected as evidence fields; the classifier is pure.

import { filterMachineLocalDirt, REBASE_NOISE_PATHS } from "./dirty-tree-classifier.mjs";

// normalizeTicketKey — lowercase, strip leading zeros for comparison.
// Normalizes 'CTL-1025' and 'ctl-1025' to the same key for prefix matching.
function normalizeTicketKey(key) {
  if (!key) return "";
  return key.toLowerCase().replace(/(\w+-)0+(\d)/, "$1$2");
}

// classifyCleanRebaseForcePush — PURE safety gate. No IO.
// evidence shape:
//   stalledReason        string    (must be 'source_conflict_ctl708_unavailable')
//   ticket               string    (the ticket id, e.g. 'CTL-1025')
//   porcelain            string|null   (null = unreadable → fail-safe skip)
//   commitSubjects       string[]  (subjects of commits on HEAD above origin/main)
//   headIsDescendant     bool      (git merge-base --is-ancestor origin/main HEAD)
//   liveSessionInWorktree bool
//   linearTerminal       bool
//   alreadyPushed        bool     (.unstuck-force-pushed-<phase>.applied present)
//
// Returns:
//   { action: 'force-push' }              — all gates passed
//   { action: 'skip', reason: <code> }    — gate failed
export function classifyCleanRebaseForcePush(evidence = {}) {
  const {
    stalledReason,
    ticket,
    porcelain,
    commitSubjects,
    headIsDescendant,
    liveSessionInWorktree,
    linearTerminal,
    alreadyPushed,
  } = evidence;

  if (stalledReason !== "source_conflict_ctl708_unavailable") {
    return { action: "skip", reason: "wrong-stall-reason" };
  }
  if (liveSessionInWorktree) {
    return { action: "skip", reason: "live-session-in-worktree" };
  }
  if (linearTerminal) {
    return { action: "skip", reason: "linear-terminal" };
  }
  if (alreadyPushed) {
    return { action: "skip", reason: "already-pushed" };
  }

  // Gate 1: noise-filtered porcelain must be empty.
  if (porcelain === null || porcelain === undefined) {
    return { action: "skip", reason: "dirty-worktree" };
  }
  const lines = porcelain.split("\n").filter((l) => l.trim().length > 0);
  const realDirt = filterMachineLocalDirt(lines);
  if (realDirt.length > 0) {
    return { action: "skip", reason: "dirty-worktree" };
  }

  // Gate 2: commits above origin/main must be non-empty and contain only this ticket.
  if (!Array.isArray(commitSubjects) || commitSubjects.length === 0) {
    return { action: "skip", reason: "empty-commits" };
  }
  const ticketNorm = normalizeTicketKey(ticket);
  for (const subject of commitSubjects) {
    const subjectNorm = normalizeTicketKey(subject);
    if (!subjectNorm.includes(ticketNorm)) {
      return { action: "skip", reason: "foreign-commits" };
    }
  }

  // Gate 3: HEAD must be a strict descendant of origin/main.
  if (!headIsDescendant) {
    return { action: "skip", reason: "not-descendant" };
  }

  return { action: "force-push" };
}

// collectForcePushCandidates — census with injected git seams.
// Collects stalled workers with source_conflict_ctl708_unavailable, runs the
// three-part git probe (porcelain, log, merge-base) via injected seams, and
// produces classifyCleanRebaseForcePush-compatible evidence objects.
// Per-candidate catch: a failing probe skips that candidate (no throw).
export function collectForcePushCandidates({
  candidates = [],      // [{ticket, phase, worktreePath, signal, workerDir}]
  runGit = null,        // (args, cwd?) → {status, stdout, stderr, error?}
} = {}) {
  const out = [];
  for (const c of candidates) {
    try {
      if (c.evidence?.reason !== "source_conflict_ctl708_unavailable") continue;
      if (!c.worktreePath) continue;

      const git = runGit ?? ((args, cwd) => {
        const { spawnSync } = require("node:child_process");
        return spawnSync("git", args, { encoding: "utf8", cwd: cwd ?? process.cwd() });
      });

      // Probe 1: porcelain — non-zero exit → null (skip gates handled by classifier)
      let porcelain = null;
      const pRes = git(["-C", c.worktreePath, "status", "--porcelain"]);
      if (!pRes.error && (pRes.status ?? 1) === 0) porcelain = pRes.stdout ?? "";

      // Probe 2: commit subjects above origin/main — non-zero exit → empty array
      let commitSubjects = [];
      const lRes = git(["-C", c.worktreePath, "log", "--no-merges", "--format=%s", "origin/main..HEAD"]);
      if (!lRes.error && (lRes.status ?? 1) === 0) {
        commitSubjects = (lRes.stdout ?? "").split("\n").filter((s) => s.trim().length > 0);
      }

      // Probe 3: HEAD is strict descendant of origin/main
      const mRes = git(["-C", c.worktreePath, "merge-base", "--is-ancestor", "origin/main", "HEAD"]);
      const headIsDescendant = !mRes.error && (mRes.status ?? 1) === 0;

      out.push({
        ...c,
        evidence: {
          ...c.evidence,
          porcelain,
          commitSubjects,
          headIsDescendant,
        },
      });
    } catch {
      // per-candidate error: skip, no throw
    }
  }
  return out;
}
