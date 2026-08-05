// unstuck-escalate-seam.mjs — CTL-1641 production escalate seam for the
// unstuck-sweep Pass 0u driver (unstuck-sweep.mjs:runUnstuckSweepPass).
//
// The escalate branch fires only in mode:'enforce' on candidates whose stall
// reason maps to no mechanical fix (remediate-cap / unknown / empty-branch).
// This seam turns that decision into operator-visible state: it applies the
// needs-human label FIRST (the operator's needs-attention surface), then posts
// an authored Linear comment SECOND. The two side effects are independent — a
// comment failure never blocks the label — and each failure is returned in
// `errors[]` so the driver can report it (never swallow it). Pure-cored: every
// IO is an injected dep with a real default. Enforce is an operator decision
// per ADR-023; wiring this seam does NOT flip the mode gate.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { log as defaultLog } from "./config.mjs";
import { authorEscalationComment } from "./unstuck-sweep-escalation.mjs";
import { captureDeepDiveEvidence } from "./unstuck-sweep-evidence.mjs";
import { labelNeedsHumanUnlessBeliefOwner } from "./label-guard.mjs";

function defaultRunGit(args) {
  return spawnSync("git", args, { encoding: "utf8" });
}

// defaultReadSignal — read workers/<ticket>/phase-<phase>.json, return null on error.
function defaultReadSignal(orchDir, ticket, phase) {
  if (!orchDir || !ticket || !phase) return null;
  try {
    const p = join(orchDir, "workers", ticket, `phase-${phase}.json`);
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// makeDefaultCommitsAhead — computes commits ahead of origin/main for a worktree.
// Returns null on any error (authorEscalationComment treats null → reason-based dispatch).
function makeDefaultCommitsAhead(runGit) {
  return (worktreePath) => {
    if (!worktreePath) return null;
    const res = runGit(["-C", worktreePath, "rev-list", "--count", "origin/main..HEAD"]);
    if (res?.error || (res?.status ?? 1) !== 0) return null;
    const n = parseInt(String(res.stdout ?? "").trim(), 10);
    return Number.isFinite(n) ? n : null;
  };
}

export function buildUnstuckEscalateSeam(deps = {}) {
  const {
    orchDir,
    writeStatus,                     // { applyLabel, removeLabel } — for the label primitive
    env = process.env,
    log = defaultLog,
    runGit = defaultRunGit,
    resolveWorktreePath = () => null,
    queryPR = () => null,
    // Seams (overridable in tests). Production binds the three below from the
    // primitives above.
    captureEvidence,                 // (subject) → evidence envelope
    commitsAhead,                    // (worktreePath) → number|null
    applyNeedsHuman,                 // (ticket) → boolean (confirmed-applied)
    postComment,                     // (ticket, body) → truthy on success (throws/false on failure)
  } = deps;

  const _capture = captureEvidence ?? ((subject) =>
    captureDeepDiveEvidence(subject, {
      readSignal: (ticket, phase) => defaultReadSignal(orchDir, ticket, phase),
      runGitPorcelain: (wt) => {
        if (!wt) return null;
        const r = runGit(["-C", wt, "status", "--porcelain"]);
        return r?.error || (r?.status ?? 1) !== 0 ? null : (r.stdout ?? "");
      },
      queryPR,
      listRemediateEvents: () => [],   // CTL-1641: real scanner is out of scope (stub)
    }));

  const _commitsAhead = commitsAhead ?? makeDefaultCommitsAhead(runGit);

  const _applyLabel = applyNeedsHuman ?? ((ticket) =>
    labelNeedsHumanUnlessBeliefOwner(orchDir, ticket, writeStatus, {
      env, site: "unstuck-escalate", log,
    }));

  const _post = postComment ?? ((ticket, body) => {
    const helperPath = join(
      process.env.PLUGIN_ROOT ?? process.cwd(),
      "scripts/lib/linear-comment-post.sh"
    );
    const r = spawnSync(helperPath, [ticket, body], { encoding: "utf8", timeout: 10_000 });
    return Boolean(r && r.status === 0);
  });

  return function escalate(candidate, decision) {
    const ticket = candidate?.ticket;
    const phase = candidate?.phase;
    const reason = candidate?.evidence?.reason ?? decision?.category;
    const errors = [];

    // 1. Evidence (best-effort — a failure degrades to a generic write-up).
    let evidence = { ticket, phase, reason };
    try {
      const captured = _capture(`${ticket}/${phase}`) ?? {};
      const worktreePath = captured?.signalJson?.worktreePath ?? resolveWorktreePath(ticket);
      let ahead = null;
      try { ahead = _commitsAhead(worktreePath); } catch { ahead = null; }
      evidence = { ...captured, ticket, phase, reason, commitsAhead: ahead };
    } catch (err) {
      log.warn({ ticket, err: err?.message }, "unstuck-escalate: evidence capture failed — generic comment (CTL-1641)");
    }

    const body = authorEscalationComment(evidence);

    // 2. Label FIRST — the operator's needs-attention surface. Independent of the comment.
    let labelApplied = false;
    try {
      labelApplied = Boolean(_applyLabel(ticket));
    } catch (err) {
      errors.push({ sideEffect: "label", err: err?.message ?? String(err) });
    }

    // 3. Comment SECOND — independent; a failure never unwinds the label.
    let commentPosted = false;
    try {
      commentPosted = Boolean(_post(ticket, body));
      if (!commentPosted) errors.push({ sideEffect: "comment", err: "post returned falsy" });
    } catch (err) {
      errors.push({ sideEffect: "comment", err: err?.message ?? String(err) });
    }

    return { ticket, phase, labelApplied, commentPosted, errors };
  };
}
