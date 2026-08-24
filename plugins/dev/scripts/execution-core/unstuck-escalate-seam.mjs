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
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { log as defaultLog } from "./config.mjs";
import { authorEscalationComment } from "./unstuck-sweep-escalation.mjs";
import { captureDeepDiveEvidence } from "./unstuck-sweep-evidence.mjs";
import { labelNeedsHumanUnlessBeliefOwner } from "./label-guard.mjs";
import { escalationIsHumanFacing } from "./escalation-publish.mjs"; // CTL-2159
import { postLinearCommentAsSpawnResult } from "./linear-comment-write.mjs"; // CTL-1889 inc 2

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

// escalateCommentMarkerPath — CTL-1641 (Codex #3005 P2): per-(ticket,category,phase)
// idempotency marker for the authored escalation COMMENT. The needs-human LABEL is
// already once-guarded (labelOnce's .linear-label-needs-human marker), and the escalate
// branch deliberately has no intent gate, so without this a candidate that stays stuck
// (unknown / remediate-cap — cleared only by a human) would receive a fresh Linear
// comment on EVERY sweep interval. Mirrors the sibling act-path marker in
// unstuck-sweep.mjs:defaultPostUnstuckComment (.unstuck-comment-<cat>-<phase>.applied);
// a distinct prefix keeps the two paths' markers from colliding. Returns null when the
// path can't be formed (fail-open → post unconditionally, as before).
function escalateCommentMarkerPath(orchDir, ticket, category, phase) {
  if (!orchDir || !ticket || !phase) return null;
  return join(
    orchDir,
    "workers",
    ticket,
    `.unstuck-escalate-comment-${category ?? "unknown"}-${phase}.applied`
  );
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

// COMMENT_HELPER_DEFAULT — the app-actor Linear comment helper, resolved
// location-independently the way the sibling daemon modules do
// (recovery-emit.mjs:101-103, recovery-reasoning.mjs:61, recovery.mjs:665). The
// execution-core daemon that runs this seam never exports PLUGIN_ROOT and its
// cwd is the repo root (daemon.mjs), so the old `process.env.PLUGIN_ROOT ??
// process.cwd()` + "scripts/lib/..." resolution silently missed and the
// authored escalation comment never posted (CTL-1641 verify HIGH). From
// execution-core/ this URL resolves to plugins/dev/scripts/lib/linear-comment-post.sh
// regardless of cwd/env. The static URL resolution is import-time; the
// CATALYST_COMMENT_POST_HELPER override is read per-build from the factory's
// `env` (below) so it can't be frozen to the wrong value at import.
const COMMENT_HELPER_DEFAULT = fileURLToPath(
  new URL("../lib/linear-comment-post.sh", import.meta.url)
);

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

  // CTL-1641 (Codex #3005 P2): the DEFAULT label binding returns a structured
  // { applied, error? } so escalate() can surface a GENUINE non-confirming write
  // (applyLabel ran but did not land — rate-limited / verify-failed / missing-label)
  // as a `label` side-effect error, while leaving benign belief-owner deferral and
  // an already-applied marker no-op error-free. onOutcome carries the distinction
  // that labelNeedsHumanUnlessBeliefOwner's boolean return erases. An INJECTED
  // applyNeedsHuman still returns a bare boolean (a stub can't distinguish, so its
  // `false` stays benign — see the belief-owner test) and escalate() handles both.
  const _applyLabel = applyNeedsHuman ?? ((ticket, reason = null) => {
    let outcome = { deferred: false, applied: false, ran: false, reason: null };
    labelNeedsHumanUnlessBeliefOwner(orchDir, ticket, writeStatus, {
      env, site: "unstuck-escalate", log,
      // ⛔ CTL-2159: forward the sweep's reason. It was computed inside escalate()
      // while this closure was built at seam-construction time, so it was
      // structurally unreachable — and every unstuck-sweep escalation therefore
      // classified HELD via the no-reason rule. The closure now takes it as an
      // argument; an INJECTED applyNeedsHuman that ignores the extra arg is
      // unaffected.
      reason,
      onOutcome: (o) => { outcome = o; },
    });
    if (outcome.applied) return { applied: true, stallClass: outcome.stallClass ?? null };
    // Attempted (applyLabel ran) but did not confirm, and not a belief-owner deferral →
    // a real failed escalation surface. A marker no-op (ran:false) or deferral is benign.
    if (!outcome.deferred && outcome.ran) {
      return {
        applied: false,
        stallClass: outcome.stallClass ?? null,
        error: `needs-human label write did not confirm (reason: ${outcome.reason ?? "unknown"})`,
      };
    }
    return { applied: false, stallClass: outcome.stallClass ?? null };
  });

  const commentHelper = env.CATALYST_COMMENT_POST_HELPER ?? COMMENT_HELPER_DEFAULT;
  const _post = postComment ?? ((ticket, body) => {
    // CTL-1889 inc 2: cloud write proxy under enforce; the helper otherwise. The
    // per-build `commentHelper` (env-overridable, read per-build so it cannot be frozen
    // to the wrong value at import) stays the helper path.
    const r = postLinearCommentAsSpawnResult(ticket, body, {
      caller: "unstuck-escalate",
      runHelper: (t, b) => spawnSync(commentHelper, [t, b], { encoding: "utf8", timeout: 30_000 }),
    });
    return r.status === 0;
  });

  return function escalate(candidate, decision) {
    const ticket = candidate?.ticket;
    const phase = candidate?.phase;
    const category = decision?.category ?? candidate?.evidence?.reason ?? "unknown";
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
    //    The label seam may return either a bare boolean (injected stub) or a structured
    //    { applied, error? } (the default binding). CTL-1641 (Codex #3005 P2): a genuine
    //    non-confirming write surfaces via `error` so the sweep's escalateFailures counts
    //    it, while benign deferral / already-applied no-ops stay error-free.
    let labelApplied = false;
    let stallClass = null;
    try {
      const lr = _applyLabel(ticket, reason);
      if (lr && typeof lr === "object") {
        labelApplied = lr.applied === true;
        stallClass = lr.stallClass ?? null;
        if (lr.error) errors.push({ sideEffect: "label", err: lr.error });
      } else {
        labelApplied = Boolean(lr);
      }
    } catch (err) {
      errors.push({ sideEffect: "label", err: err?.message ?? String(err) });
    }

    // 3. Comment SECOND — independent; a failure never unwinds the label. CTL-1641
    //    (Codex #3005 P2): idempotent per (ticket, category, phase). Once a comment has
    //    posted for this stall, a later sweep on the still-stuck candidate must NOT
    //    re-post (the label is already once-guarded; the escalate branch has no intent
    //    gate). A pre-existing marker means "already delivered" → satisfied, not a re-post
    //    and not an error. The marker is written only after a CONFIRMED post; the worker
    //    dir must already exist (a real candidate's always does — fail-open otherwise).
    const commentMarker = escalateCommentMarkerPath(orchDir, ticket, category, phase);
    const workerDir = orchDir && ticket ? join(orchDir, "workers", ticket) : null;
    const markerGuardActive = Boolean(commentMarker && workerDir && existsSync(workerDir));

    // ⛔ CTL-2159 CLASS GATE — the last per-ticket Linear artifact on this path.
    //
    // This comment used to post on EVERY escalation, ungated. With the label
    // deleted it became the surviving contradiction of the epic's central
    // promise: "SYSTEM → ZERO per-ticket artifacts". A provider outage across N
    // tickets wrote N authored Linear comments into a 300-writes/day budget, for
    // a condition the ONE fleet alert (CTL-2156) already names and that resolves
    // itself.
    //
    // FAIL-OPEN, and deliberately narrow: only an EXPLICIT system/moot verdict
    // suppresses. HELD (a person must look) and ASK still comment — HELD's whole
    // meaning is visibility, and silencing it ships the plan's named worst
    // outcome. An unknown/absent class (an injected label stub, a belief-owner
    // deferral) also still comments: an absence of evidence is not a SYSTEM
    // verdict, and going quiet on one would be the silent regression.
    const classSuppressesComment =
      stallClass != null && !escalationIsHumanFacing(stallClass);
    let commentPosted = false;
    if (classSuppressesComment) {
      log.info(
        { ticket, phase, stallClass, reason },
        "unstuck-escalate: system/moot stall — no per-ticket comment (CTL-2159)"
      );
    } else if (markerGuardActive && existsSync(commentMarker)) {
      commentPosted = true; // already delivered this lifetime — no duplicate, no error
    } else {
      try {
        commentPosted = Boolean(_post(ticket, body));
        if (commentPosted) {
          if (markerGuardActive) {
            try {
              writeFileSync(commentMarker, "");
            } catch (err) {
              log.warn(
                { ticket, err: err?.message },
                "unstuck-escalate: comment idempotency marker write failed — continuing (CTL-1641)"
              );
            }
          }
        } else {
          errors.push({ sideEffect: "comment", err: "post returned falsy" });
        }
      } catch (err) {
        errors.push({ sideEffect: "comment", err: err?.message ?? String(err) });
      }
    }

    return { ticket, phase, labelApplied, commentPosted, stallClass, errors };
  };
}
