// unstuck-escalate-seam.mjs — CTL-1641 production escalate seam for the
// unstuck-sweep Pass 0u driver (unstuck-sweep.mjs:runUnstuckSweepPass).
//
// The escalate branch fires only in mode:'enforce' on candidates whose stall
// reason maps to no mechanical fix (remediate-cap / unknown / empty-branch).
// This seam turns that decision into operator-visible state: it applies the
// needs-human label, and (CTL-1871 COORD-29) atomically co-posts an ASK comment
// via the gate.  Pure-cored: every IO is an injected dep with a real default.
// Enforce is an operator decision per ADR-023; wiring this seam does NOT flip
// the mode gate.

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { log as defaultLog } from "./config.mjs";
import { authorEscalationComment } from "./unstuck-sweep-escalation.mjs";
import { captureDeepDiveEvidence } from "./unstuck-sweep-evidence.mjs";
import { labelNeedsHumanUnlessBeliefOwner } from "./label-guard.mjs";
import { coerceExplanation } from "./escalation-explanation.mjs";

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
    // Seams (overridable in tests). Production binds the two below from the
    // primitives above.
    captureEvidence,                 // (subject) → evidence envelope
    commitsAhead,                    // (worktreePath) → number|null
    applyNeedsHuman,                 // (ticket, explanation) → { applied, error? }|boolean
    // CTL-1871 COORD-29: injectable ASK-comment poster seam, threaded into the
    // label gate so tests never touch the network. Production: null (gate uses
    // postLinearCommentAsSpawnResult via its own default).
    postAskComment = null,
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

  // CTL-1641 (Codex #3005 P2): the DEFAULT label binding returns a structured
  // { applied, error? } so escalate() can surface a GENUINE non-confirming write
  // (applyLabel ran but did not land — rate-limited / verify-failed / missing-label)
  // as a `label` side-effect error, while leaving benign belief-owner deferral and
  // an already-applied marker no-op error-free. onOutcome carries the distinction
  // that labelNeedsHumanUnlessBeliefOwner's boolean return erases. An INJECTED
  // applyNeedsHuman still returns a bare boolean (a stub can't distinguish, so its
  // `false` stays benign — see the belief-owner test) and escalate() handles both.
  //
  // CTL-1871 COORD-29: the binding now accepts an explanation and threads it + the
  // postAskComment seam into the gate.  The comment is posted BY THE GATE (atomic
  // with the label); this seam no longer posts a separate comment.
  const _applyLabel = applyNeedsHuman ?? ((ticket, explanation) => {
    let outcome = { deferred: false, applied: false, ran: false, reason: null };
    labelNeedsHumanUnlessBeliefOwner(orchDir, ticket, writeStatus, {
      env, site: "unstuck-escalate", log,
      explanation,
      postAskComment: postAskComment ?? null,
      onOutcome: (o) => { outcome = o; },
    });
    if (outcome.applied) return { applied: true };
    // Attempted (applyLabel ran) but did not confirm, and not a belief-owner deferral →
    // a real failed escalation surface. A marker no-op (ran:false) or deferral is benign.
    if (!outcome.deferred && outcome.ran) {
      return {
        applied: false,
        error: `needs-human label write did not confirm (reason: ${outcome.reason ?? "unknown"})`,
      };
    }
    return { applied: false };
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

    // 2. CTL-1871 COORD-29: build a coerced explanation that carries call_to_action =
    //    the authored body (one-lined inside labelNeedsHumanUnlessBeliefOwner via the
    //    ASK formatter) and problem = the stall fingerprint.  The gate owns posting the
    //    ASK comment atomically with the label; this seam no longer posts separately.
    const explanation = coerceExplanation({
      call_to_action: body,
      problem: `${ticket}/${phase}: stalled (${reason ?? "unknown"})`,
    });

    // 3. Label — the gate now also posts the ASK comment (enforce: withholds label on
    //    comment failure; shadow/off: posts best-effort / skips then labels regardless).
    //    The seam may return a bare boolean (injected stub) or structured { applied, error? }
    //    (the default binding). CTL-1641 (Codex #3005 P2): non-confirming writes surface
    //    via `error`; benign deferral / already-applied no-ops stay error-free.
    let labelApplied = false;
    try {
      const lr = _applyLabel(ticket, explanation);
      if (lr && typeof lr === "object") {
        labelApplied = lr.applied === true;
        if (lr.error) errors.push({ sideEffect: "label", err: lr.error });
      } else {
        labelApplied = Boolean(lr);
      }
    } catch (err) {
      errors.push({ sideEffect: "label", err: err?.message ?? String(err) });
    }

    // commentPosted mirrors labelApplied — the gate is atomic, so if the label
    // landed the comment either landed first or was skipped (off mode).
    return { ticket, phase, labelApplied, commentPosted: labelApplied, errors };
  };
}
