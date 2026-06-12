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

import { spawnSync } from "node:child_process";
import { filterMachineLocalDirt, REBASE_NOISE_PATHS } from "./dirty-tree-classifier.mjs";

// normalizeTicketKey — lowercase, strip leading zeros for comparison.
// Normalizes 'CTL-1025' and 'ctl-1025' to the same key for prefix matching.
function normalizeTicketKey(key) {
  if (!key) return "";
  return key.toLowerCase().replace(/(\w+-)0+(\d)/, "$1$2");
}

// buildTicketKeyRegex — whole-token matcher for a ticket key. Returns a RegExp
// that matches the key as a bounded token (\b<prefix>-0*<num>\b), tolerant of
// leading zeros in the subject, case-insensitive. Replaces the prior substring
// `subjectNorm.includes(ticketNorm)` test, which prefix-matched short keys onto
// longer ones (CTL-1 matched CTL-10) and matched the key anywhere in the body
// (a foreign `CTL-999: revert CTL-1025 fix` or the default git-revert subject
// `Revert "CTL-1025: ..."` false-accepted). Gate 2 is the SOLE ownership guard,
// so a false-accept could force-push a branch carrying foreign commits (CTL-1064).
// Returns null when the key is unparseable → caller falls back to exact-token.
function buildTicketKeyRegex(ticket) {
  const m = String(ticket ?? "").match(/^([A-Za-z][A-Za-z0-9]*)-0*(\d+)$/);
  if (!m) return null;
  const [, prefix, num] = m;
  return new RegExp(`\\b${prefix}-0*${num}\\b`, "i");
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
  const ticketRe = buildTicketKeyRegex(ticket);
  const ticketNorm = normalizeTicketKey(ticket);
  for (const subject of commitSubjects) {
    const matches = ticketRe
      ? ticketRe.test(String(subject))
      // Fallback for an unparseable key: exact normalized-token equality rather
      // than substring (still avoids the CTL-1/CTL-10 prefix false-accept).
      : normalizeTicketKey(subject).split(/\b/).some((t) => t === ticketNorm);
    if (!matches) {
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

      // Default git seam uses the top-level ESM import (this package is
      // type:module — an in-body `require("node:child_process")` is undefined
      // under node and threw, working only via bun's CJS shim) (CTL-1064).
      const git = runGit ?? ((args, cwd) =>
        spawnSync("git", args, { encoding: "utf8", cwd: cwd ?? process.cwd() }));

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
