// stall-janitor.mjs — CTL-1004 terminal-state leftover collapser.
//
// The orchestrator accumulates two classes of terminal-state leftovers that the
// event-driven reaper never names:
//   J1 (orphaned worktrees): teardown=done + .terminal-done.applied, the worktree
//       still on disk, no live session inside it, clean tree, CTL-791 evidence —
//       but the session already exited, so the 600s timer's UNTARGETED
//       orphans.reap-requested never names it. The janitor emits a TARGETED
//       orphans.reap-requested{ticket, worktree_path, bg_job_id}; the REAPER owns
//       removal (the targeted removal path + CTL-791 evidence gates).
//   J2 (ghost sessions): a terminal signal present >=600s with an idle background
//       session for the same subject. The janitor's kill seam (injected
//       recordKillIntent) BOTH issues the stop via killBgJob AND records a
//       kill-INTENT pinned to that bgJobId — mirroring recovery.mjs intentAwareKill.
//       The intent is recorded so the reconciler can VERIFY the session left the
//       agents listing next tick (and the CTL-936 retry bookkeeping stays
//       consistent), but the JANITOR — not the reconciler — performs the stop
//       (the reconciler is a postcondition verifier, never an executor).
//
// DOCTRINE (rules DERIVE, executors ACT; shadow-then-gate):
//   * The janitor only collapses already-terminal, UNAMBIGUOUS states. It never
//     calls deriveAdvancement, resolves conflicts, or infers liveness.
//   * J1 makes NO external writes — it emits a TARGETED reap event and lets the
//     REAPER (executor) remove the worktree. J2, by contrast, IS the executor for
//     the ghost-session stop: its kill seam issues killBgJob directly (the
//     reconciler only VERIFIES the stop landed, it never performs one). CTL-863
//     multi-host fences live in the reaper.
//   * SHADOW-FIRST: in "shadow" it emits janitor.would.* events and mutates
//     nothing (no reap event, no kill, no intent); in "enforce" it emits the real
//     targeted reap and issues the real ghost-session kill (+ pinned intent); in
//     "off" the whole pass is skipped (no census, no events).
//
// Split mirrors the CTL-729 watchdog: a PURE decision (classifyOrphanWorktree /
// classifyGhostSession — all evidence injected, no IO) + an action driver
// (runStallJanitorPass — every side-effect seam injected).

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { log } from "./config.mjs";
import { parseWorktreeForBranch } from "./worktree.mjs";
import { cleanPorcelain } from "./worktree-safety.mjs";
// CTL-1005 J3: prior-phase artifact completeness reuses the SAME work-done probes
// (existence + non-truncation) the reclaim sweep already trusts, and the NEXT_PHASE
// table (inverted → prior-phase) so the stalled phase maps to the artifact it waited
// on. Single source of truth — no duplicated phase order / glob patterns.
import { WORK_DONE_PROBES } from "./work-done-probes.mjs";
import { NEXT_PHASE } from "../lib/workflow-descriptor.mjs";
// CTL-1004 / CTL-1005 / CTL-1056: the janitor's emit vocabulary lives in a
// dependency-free leaf that reap-intent.mjs ALSO imports to seed its closed
// REAP_INTENT_TYPES. Referencing JANITOR_EVENT (instead of bare string literals)
// at every shadow/enforce emit site binds the producer to the same source of
// truth — a new emit type is unusable until it is added to the shared list,
// which the vocabulary then registers automatically.
import { JANITOR_EVENT_TYPES } from "./janitor-event-types.mjs";

// Named accessors over the frozen list — one per janitor emit type. Indexing the
// frozen array keeps the strings in ONE place; a typo here is a load error, not a
// silent live drop.
const JANITOR_EVENT = Object.freeze({
  worktreeDeferred: JANITOR_EVENT_TYPES[0], // "janitor.worktree.deferred"
  wouldDefer: JANITOR_EVENT_TYPES[1], // "janitor.would.defer"
  wouldReapRequest: JANITOR_EVENT_TYPES[2], // "janitor.would.reap-request"
  wouldKillIntent: JANITOR_EVENT_TYPES[3], // "janitor.would.kill-intent"
  stallCleared: JANITOR_EVENT_TYPES[4], // "janitor.stall.cleared"
  wouldClear: JANITOR_EVENT_TYPES[5], // "janitor.would.clear"
  signalsGcd: JANITOR_EVENT_TYPES[6], // "janitor.signals.gc"
  wouldGc: JANITOR_EVENT_TYPES[7], // "janitor.would.gc"
});

// classifyOrphanWorktree (J1) — PURE. Given the fully-resolved evidence for one
// terminal-Done ticket's worktree, decide the disposition:
//   "reap-orphan" — emit a targeted orphans.reap-requested (reaper removes it).
//   "defer"       — a dirty tree: emit janitor.worktree.deferred{reason:dirty},
//                   remove nothing, queue nothing.
//   "skip"        — anything ambiguous, not-yet-terminal, already-reaped, or live.
//
// ctx fields:
//   teardownDone, terminalDoneApplied   — positive done evidence (both required).
//   worktreeOnDisk                       — git worktree list shows it.
//   liveSessionInWorktree                — a live session has its cwd inside it.
//   inFlight                             — the ticket still holds a worker slot.
//   treeClean                            — `git status --porcelain` is clean (sans noise).
//   evidenceOk                           — the CTL-791 positive-done evidence gate passes.
//   alreadyReaped                        — .terminal-reap-teardown present for the ticket.
export function classifyOrphanWorktree(ctx = {}) {
  // NEVER touch a live worker — these are the safety fences, checked first.
  if (ctx.liveSessionInWorktree) return { action: "skip", reason: "live-session-in-worktree" };
  if (ctx.inFlight) return { action: "skip", reason: "in-flight" };

  // Positive-done evidence required (mirrors CTL-791: never act without it).
  if (!ctx.teardownDone) return { action: "skip", reason: "not-teardown-done" };
  if (!ctx.terminalDoneApplied) return { action: "skip", reason: "no-terminal-done-marker" };

  // Already reaped (.terminal-reap-teardown present) → do not re-queue.
  if (ctx.alreadyReaped) return { action: "skip", reason: "already-reaped" };

  // Nothing on disk → nothing to reap (the already-reaped / never-created case).
  if (!ctx.worktreeOnDisk) return { action: "skip", reason: "no-worktree-on-disk" };

  // A dirty tree is DEFERRED (never removed, never queued) — the reaper's
  // CTL-791 gate would refuse it anyway, but the janitor defers loudly first.
  if (!ctx.treeClean) return { action: "defer", reason: "dirty" };

  // CTL-791 positive-done evidence gate must pass (never force a removal).
  if (!ctx.evidenceOk) return { action: "skip", reason: "evidence-gate-failed" };

  return { action: "reap-orphan", reason: "terminal-orphan-worktree" };
}

// classifyGhostSession (J2) — PURE. Given one terminal subject + its lingering
// session, decide whether to record a kill-intent.
//   "kill-intent" — a terminal signal present >=terminalIdleMs with an IDLE
//                   BACKGROUND session pinned to a real bgJobId.
//   "skip"        — not-yet-terminal-long-enough, interactive/unknown kind,
//                   non-idle (possibly live), or no bgJobId to pin.
export function classifyGhostSession(ctx = {}) {
  const terminalIdleMs = Number.isFinite(ctx.terminalIdleMs) ? ctx.terminalIdleMs : 600_000;
  if (!ctx.bgJobId) return { action: "skip", reason: "no-bg-job-id" };
  // NEVER touch a human session, and never an ambiguous (unknown/null) kind.
  if (ctx.sessionKind !== "background") return { action: "skip", reason: "non-background-or-interactive" };
  // Only an explicitly-idle session is a ghost — a busy/active/unknown status
  // could still be doing work (the conservative direction).
  if (ctx.sessionStatus !== "idle") return { action: "skip", reason: "not-idle" };
  // The terminal signal must have been present long enough.
  if (!(Number(ctx.terminalForMs) >= terminalIdleMs)) return { action: "skip", reason: "terminal-too-recent" };
  return { action: "kill-intent", reason: "post-teardown-idle-ghost" };
}

// classifyStallClear (J3, CTL-1005) — PURE. Given a `prior-artifact-retry-exhausted`
// stall + its fully-resolved evidence, decide whether to auto-clear it ONCE so the
// scheduler can re-dispatch. The defect being fixed: escalateDispatchExhausted
// writes a synthetic `stalled` signal when the dispatch retry ceiling is hit
// because the PRIOR-phase artifact was missing, then never re-checks whether the
// artifact later arrived — the ticket freezes to needs-human permanently.
//   "clear" — the prior artifact is now present AND complete (non-truncated), the
//             Linear state is non-terminal, no live session owns the worktree,
//             we have not already cleared this phase once this worker-dir lifetime,
//             the stall was caused by prior-artifact-missing (exit code 2), and
//             the prior-phase done signal still survives.
//   "skip"  — anything else. Every gate fails CLOSED (stay frozen) — a borderline
//             case is left for operator review, never force-unstuck.
//
// ctx fields:
//   stalledReason          — must be exactly "prior-artifact-retry-exhausted".
//   linearTerminal         — the ticket's Linear state is terminal/merged.
//   liveSessionInWorktree  — a live session has its cwd inside the worktree.
//   artifactPresent        — the named prior-phase artifact exists.
//   artifactComplete       — …AND is non-truncated (existence alone is not enough;
//                            re-walk artifact-validation precedent).
//   alreadyCleared         — a .janitor-cleared-<phase>.applied marker is present.
//   dispatchFailureCode    — CTL-1045 Bug 2: exit code that exhausted retries.
//                            Only 2 (prior_artifact_missing) is clearable.
//   priorDoneSignalPresent — CTL-1045 Bug 3: the prior-phase done signal survives;
//                            without it a clear empties the worker dir → pipeline drop.

// Exit code 2 is the phase-agent-dispatch structural refusal for a missing prior
// artifact (PERMANENT_FAILURE_CODES in scheduler.mjs). It is the ONLY benign cause
// that J3 is safe to auto-clear; any other code means re-dispatch would repeat the
// same failure class.
const PRIOR_ARTIFACT_MISSING_EXIT_CODE = 2;

export function classifyStallClear(ctx = {}) {
  // Only the transient prior-artifact-retry-exhausted stall is auto-clearable.
  // A dispatch-circuit-breaker / phantom-ticket / any other stall is operator-owned.
  if (ctx.stalledReason !== "prior-artifact-retry-exhausted")
    return { action: "skip", reason: "not-retry-exhausted-reason" };
  // CTL-1045 Bug 2: only the benign prior-artifact-missing exhaustion is clearable.
  // A verify_failed (code 0) or crash (code ≠ 2) would re-dispatch into the same
  // failure; a legacy signal (code null) is operator-owned (conservative default).
  if (ctx.dispatchFailureCode !== PRIOR_ARTIFACT_MISSING_EXIT_CODE)
    return { action: "skip", reason: "non-artifact-dispatch-cause" };
  // NEVER unstick a terminal/merged Linear ticket (the pipeline is genuinely done).
  if (ctx.linearTerminal) return { action: "skip", reason: "linear-terminal" };
  // NEVER touch a live worker (the safety fence, mirrors J1).
  if (ctx.liveSessionInWorktree) return { action: "skip", reason: "live-session-in-worktree" };
  // One clear per ticket per phase per worker-dir lifetime — a re-stall after one
  // clear is left frozen for operator review (the Gherkin's re-stall scenario).
  if (ctx.alreadyCleared) return { action: "skip", reason: "already-cleared" };
  // The artifact must be PRESENT and COMPLETE — existence alone is not enough
  // (a truncated plan/research doc silently flowing downstream is a real failure
  // class; re-walk artifact-validation precedent).
  if (!ctx.artifactPresent) return { action: "skip", reason: "artifact-absent" };
  if (!ctx.artifactComplete) return { action: "skip", reason: "artifact-truncated" };
  // CTL-1045 Bug 3: never empty a worker dir — the prior-phase done signal must
  // survive the clear, else the next tick sees an empty signals map, isTicketInFlight
  // returns false, and deriveAdvancement finds no `done` to advance from → silent drop.
  if (!ctx.priorDoneSignalPresent) return { action: "skip", reason: "prior-done-signal-absent" };
  return { action: "clear", reason: "prior-artifact-now-complete" };
}

// classifyTerminalSignalGc (J4, CTL-1242) — PURE. Given a ticket that has been
// identified as terminal/merged, decide whether its workers/<T>/ signal dir can
// be GC'd this tick. Safety fences first, then positive "gc" verdict:
//   "gc"   — ticket is terminal/merged, no live session, not in-flight, not already GC'd.
//   "skip" — anything ambiguous, live, in-flight, or already removed.
//
// ctx fields:
//   linearTerminalOrMerged — ticket is terminal via Linear state OR merged PR.
//   liveSessionInWorktree  — a live session has its cwd inside the ticket's worktree.
//   inFlight               — the ticket has an active (non-terminal) phase worker.
//   alreadyGcd             — a .janitor-gc.applied marker is present in the worker dir,
//                            meaning a prior GC write started but the dir wasn't removed
//                            (e.g., EACCES). Prevents infinite retry.
export function classifyTerminalSignalGc(ctx = {}) {
  if (!ctx.linearTerminalOrMerged) return { action: "skip", reason: "not-terminal-or-merged" };
  if (ctx.liveSessionInWorktree) return { action: "skip", reason: "live-session-in-worktree" };
  if (ctx.inFlight) return { action: "skip", reason: "in-flight" };
  if (ctx.alreadyGcd) return { action: "skip", reason: "already-gc'd" };
  return { action: "gc", reason: "terminal-or-merged-no-live-session" };
}

// runStallJanitorPass — the action driver. Enumerates the terminal-Done orphan
// candidates + ghost-session candidates (injected census seams), classifies each,
// and either ACTS (enforce) or SHADOWS (would.*). Returns a per-tick report:
//   { reaped, wouldReap, killIntents, wouldKill, deferred }
//
// SYNCHRONOUS report-building, fire-and-forget emits. The whole report is built
// in a synchronous loop (the classifiers + intent recording are sync), so the
// scheduler tick — which is itself synchronous and returns a plain object — can
// drive this pass and read the report in the SAME tick (mirrors the CTL-729
// watchdog Pass 0w, which pushes to its result arrays synchronously while the
// kill itself is fire-and-forget). The `emit` seam may be async; its promise is
// fired-and-forgotten (`.catch`), never awaited, so a slow event-log append never
// stalls the loop. `mode` is "off" | "shadow" | "enforce". off → skip everything.
//
// Seams (all injected so the daemon tick stays the only place that touches real
// git / the event log / the intent db):
//   collectOrphanCandidates() → [orphanCtx]   (each carries the classify ctx +
//                                               ticket/worktreePath/bgJobId/branch)
//   collectGhostCandidates()  → [ghostCtx]    (classify ctx + ticket/phase/bgJobId)
//   emit(type, fields)        → Promise<bool>  the reap-intent / shadow emitter
//   recordKillIntent(intent)  → bool           the J2 kill seam: issues killBgJob
//                                               AND pins the kill-intent (mirrors
//                                               recovery.mjs intentAwareKill). Named
//                                               for the bookkeeping half; the stop
//                                               is the load-bearing act.
//   terminalIdleMs            → number         J2 threshold (default 600s)
//   collectStallClearCandidates() → [stallCtx] (J3 classify ctx + ticket/phase)
//   clearStall({ticket,phase})    → bool       J3 unstick seam: deletes the
//                                               synthetic stalled signal, clears
//                                               needs-human + the orphan-detected
//                                               marker, writes the once-marker, and
//                                               lets the scheduler re-dispatch.
export function runStallJanitorPass({
  mode = "shadow",
  terminalIdleMs = 600_000,
  collectOrphanCandidates = () => [],
  collectGhostCandidates = () => [],
  collectStallClearCandidates = () => [],
  // CTL-1242 J4: terminal/merged signal dir GC census + action seam.
  collectTerminalSignalGcCandidates = () => [],
  gcTerminalSignals = () => false,
  emit = async () => true,
  recordKillIntent = () => false,
  clearStall = () => false,
} = {}) {
  const report = {
    reaped: [], wouldReap: [], killIntents: [], wouldKill: [], deferred: [],
    stallsCleared: [], wouldClear: [],
    signalsGcd: [], wouldGc: [],
  };

  // off → skip the pass entirely: no census, no events, no intents.
  if (mode === "off") return report;
  const enforce = mode === "enforce";

  // fire-and-forget emit: never await (so a slow append can't stall the loop),
  // never let a rejection escape (a thrown/rejecting emitter is logged, not fatal).
  const fire = (type, fields, ticket) => {
    try {
      const p = emit(type, fields);
      if (p && typeof p.catch === "function") {
        p.catch((err) =>
          log.warn({ ticket, type, err: err?.message }, "stall-janitor: emit failed (CTL-1004)"),
        );
      }
    } catch (err) {
      // A SYNCHRONOUSLY-throwing emit seam (the isolation test) must not abort
      // the candidate loop — re-throw to the per-candidate catch below.
      throw err;
    }
  };

  // ---- J1: orphan worktrees → TARGETED orphans.reap-requested ----------------
  let orphanCandidates = [];
  try {
    orphanCandidates = collectOrphanCandidates() ?? [];
  } catch (err) {
    log.warn({ err: err?.message }, "stall-janitor: orphan census threw — skipping J1 (CTL-1004)");
    orphanCandidates = [];
  }
  for (const c of orphanCandidates) {
    try {
      const decision = classifyOrphanWorktree(c);
      if (decision.action === "skip") continue;

      if (decision.action === "defer") {
        fire(
          enforce ? JANITOR_EVENT.worktreeDeferred : JANITOR_EVENT.wouldDefer,
          { ticket: c.ticket, worktreePath: c.worktreePath, reason: decision.reason },
          c.ticket,
        );
        report.deferred.push({ ticket: c.ticket, reason: decision.reason });
        continue;
      }

      // reap-orphan — the janitor NEVER removes; it emits a TARGETED event that
      // names the specific worktree so the reaper's targeted removal + CTL-791
      // evidence path acts on THAT tree (not the blanket session sweep).
      const reapFields = {
        ticket: c.ticket,
        worktreePath: c.worktreePath,
        bgJobId: c.bgJobId,
        branch: c.branch,
        reason: "stall-janitor-orphan",
      };
      if (enforce) {
        fire("orphans.reap-requested", reapFields, c.ticket);
        report.reaped.push({ ticket: c.ticket, worktreePath: c.worktreePath });
      } else {
        fire(JANITOR_EVENT.wouldReapRequest, reapFields, c.ticket);
        report.wouldReap.push({ ticket: c.ticket, worktreePath: c.worktreePath });
      }
    } catch (err) {
      log.warn(
        { ticket: c?.ticket, err: err?.message },
        "stall-janitor: per-orphan step failed — continuing (CTL-1004)",
      );
    }
  }

  // ---- J2: ghost sessions → killBgJob + pinned kill-intent --------------------
  // In enforce the recordKillIntent seam BOTH stops the ghost (killBgJob) AND
  // records the intent (mirrors recovery.mjs intentAwareKill). The reconciler is
  // a verifier, not an executor — so the janitor itself must issue the stop.
  let ghostCandidates = [];
  try {
    ghostCandidates = collectGhostCandidates() ?? [];
  } catch (err) {
    log.warn({ err: err?.message }, "stall-janitor: ghost census threw — skipping J2 (CTL-1004)");
    ghostCandidates = [];
  }
  for (const c of ghostCandidates) {
    try {
      const decision = classifyGhostSession({ ...c, terminalIdleMs });
      if (decision.action !== "kill-intent") continue;
      const subject = `${c.ticket}/${c.phase}`;
      if (enforce) {
        // Issue the stop AND pin the intent to bgJobId (so resolvePostcondition
        // distinguishes the targeted session from a newly-revived worker on the
        // same subject slot) — both in one seam call, mirroring intentAwareKill.
        recordKillIntent({ subject, bgJobId: c.bgJobId, ticket: c.ticket, phase: c.phase });
        report.killIntents.push({ ticket: c.ticket, phase: c.phase, bgJobId: c.bgJobId });
      } else {
        fire(
          JANITOR_EVENT.wouldKillIntent,
          { ticket: c.ticket, phase: c.phase, bgJobId: c.bgJobId, reason: "post-teardown-idle-ghost" },
          c.ticket,
        );
        report.wouldKill.push({ ticket: c.ticket, phase: c.phase, bgJobId: c.bgJobId });
      }
    } catch (err) {
      log.warn(
        { ticket: c?.ticket, err: err?.message },
        "stall-janitor: per-ghost step failed — continuing (CTL-1004)",
      );
    }
  }

  // ---- J3: prior-artifact-retry-exhausted stalls → auto-clear ONCE (CTL-1005) -
  // A transient stall (escalateDispatchExhausted wrote a synthetic `stalled`
  // signal because the prior-phase artifact was missing) that froze to needs-human
  // even after the artifact later arrived. In enforce the clearStall seam deletes
  // the synthetic signal + clears needs-human / .orphan-detected / writes the
  // once-marker; the scheduler's normal path then re-dispatches next tick.
  let stallCandidates = [];
  try {
    stallCandidates = collectStallClearCandidates() ?? [];
  } catch (err) {
    log.warn({ err: err?.message }, "stall-janitor: stall-clear census threw — skipping J3 (CTL-1005)");
    stallCandidates = [];
  }
  for (const c of stallCandidates) {
    try {
      const decision = classifyStallClear(c);
      if (decision.action !== "clear") continue;
      if (enforce) {
        // The clear is the executor: delete the synthetic stalled signal, clear
        // needs-human + .orphan-detected.applied, write .janitor-cleared-<phase>
        // .applied (one clear per worker-dir lifetime), and let the scheduler re-dispatch.
        clearStall({ ticket: c.ticket, phase: c.phase });
        fire(
          JANITOR_EVENT.stallCleared,
          { ticket: c.ticket, phase: c.phase, artifact_verified: true, reason: decision.reason },
          c.ticket,
        );
        report.stallsCleared.push({ ticket: c.ticket, phase: c.phase });
      } else {
        fire(
          JANITOR_EVENT.wouldClear,
          { ticket: c.ticket, phase: c.phase, artifact_verified: true, reason: decision.reason },
          c.ticket,
        );
        report.wouldClear.push({ ticket: c.ticket, phase: c.phase });
      }
    } catch (err) {
      log.warn(
        { ticket: c?.ticket, err: err?.message },
        "stall-janitor: per-stall-clear step failed — continuing (CTL-1005)",
      );
    }
  }

  // ---- J4: terminal/merged signal dir GC → remove workers/<T>/ (CTL-1242) ---
  // A ticket that reached a terminal Linear state (Done/Canceled) or whose PR
  // merged without a teardown phase retains stale phase-*.json signal files
  // forever, keeping the ticket in dead/stale views and in listStartedTickets.
  // In enforce the gcTerminalSignals seam removes the entire workers/<T>/ dir;
  // in shadow it emits janitor.would.gc and mutates nothing.
  let gcCandidates = [];
  try {
    gcCandidates = collectTerminalSignalGcCandidates() ?? [];
  } catch (err) {
    log.warn({ err: err?.message }, "stall-janitor: gc census threw — skipping J4 (CTL-1242)");
    gcCandidates = [];
  }
  for (const c of gcCandidates) {
    try {
      const decision = classifyTerminalSignalGc(c);
      if (decision.action !== "gc") continue;
      if (enforce) {
        gcTerminalSignals({ ticket: c.ticket });
        fire(
          JANITOR_EVENT.signalsGcd,
          { ticket: c.ticket, reason: decision.reason },
          c.ticket,
        );
        report.signalsGcd.push({ ticket: c.ticket });
      } else {
        fire(
          JANITOR_EVENT.wouldGc,
          { ticket: c.ticket, reason: decision.reason },
          c.ticket,
        );
        report.wouldGc.push({ ticket: c.ticket });
      }
    } catch (err) {
      log.warn(
        { ticket: c?.ticket, err: err?.message },
        "stall-janitor: per-gc step failed — continuing (CTL-1242)",
      );
    }
  }

  return report;
}

// ===========================================================================
// PRODUCTION CENSUS BUILDERS (read-only, fail-safe) — the default seams the
// daemon tick wires into runStallJanitorPass. Every probe is read-only: a `git
// worktree list --porcelain`, a `git status --porcelain`, a marker stat, and the
// already-warm agents snapshot. Any throw degrades to "skip this candidate" — the
// janitor never escalates on missing data. Mirrors the watchdog's defaultProgressMark
// / defaultTranscriptAgeMs production-default pattern.
// ===========================================================================

function stripTrailingSlash(p) {
  return typeof p === "string" ? p.replace(/\/+$/, "") : p;
}

// cwdUnder — true when `cwd` is the worktree root or nested beneath it. Exact
// path-segment match so /a/CTL-7 never matches /a/CTL-70.
function cwdUnder(cwd, root) {
  if (!cwd || !root) return false;
  const c = stripTrailingSlash(cwd);
  const r = stripTrailingSlash(root);
  return c === r || c.startsWith(r + "/");
}

// defaultCollectOrphanCandidates — enumerate every ticket whose pipeline reached
// terminal Done (the .terminal-done.applied marker) and build the J1 classify ctx
// from read-only probes. `projects` supplies [{team, repoRoot}] for the worktree
// resolution; `agents` is the warm snapshot ([] when cold → liveSessionInWorktree
// defaults false, but inFlight still fences); `now`/git are injected for tests.
export function defaultCollectOrphanCandidates({
  orchDir,
  projects = [],
  agents = [],
  inFlightTickets = new Set(),
  runGit = (args) => spawnSync("git", args, { encoding: "utf8" }),
} = {}) {
  const out = [];
  let workerDirs;
  try {
    workerDirs = readdirSync(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return out; // no workers dir → nothing to census
  }
  // Pre-resolve each project's worktree list once (read-only).
  const worktreeListByRepo = new Map();
  function worktreeListFor(repoRoot) {
    if (!repoRoot) return "";
    if (worktreeListByRepo.has(repoRoot)) return worktreeListByRepo.get(repoRoot);
    let porcelain = "";
    try {
      const res = runGit(["-C", repoRoot, "worktree", "list", "--porcelain"]);
      if (!res.error && (res.status ?? 1) === 0) porcelain = res.stdout ?? "";
    } catch { /* unreadable → treat as no worktrees */ }
    worktreeListByRepo.set(repoRoot, porcelain);
    return porcelain;
  }

  for (const d of workerDirs) {
    if (!d.isDirectory()) continue;
    const ticket = d.name;
    try {
      const workerDir = join(orchDir, "workers", ticket);
      const teardownDone = existsSync(join(workerDir, ".terminal-done.applied"));
      if (!teardownDone) continue; // census ONLY terminal-Done tickets
      // .terminal-reap-teardown present ⇒ already reaped (do not re-queue).
      const alreadyReaped = existsSync(join(workerDir, ".terminal-reap-teardown"));
      // Resolve the worktree path across the registered projects.
      let worktreePath = null;
      for (const p of projects) {
        const path = parseWorktreeForBranch(worktreeListFor(p.repoRoot), ticket);
        if (path) { worktreePath = path; break; }
      }
      const worktreeOnDisk = !!worktreePath && existsSync(worktreePath);
      // Live session whose cwd sits inside the worktree (warm snapshot).
      const liveSessionInWorktree =
        worktreeOnDisk &&
        Array.isArray(agents) &&
        agents.some((a) => cwdUnder(a?.cwd, worktreePath));
      // Clean tree (sans machine-local noise) — only probed when on disk.
      let treeClean = false;
      if (worktreeOnDisk) {
        try {
          const st = runGit(["-C", worktreePath, "status", "--porcelain"]);
          if (!st.error && (st.status ?? 1) === 0) {
            treeClean = cleanPorcelain(st.stdout ?? "").length === 0;
          }
        } catch { treeClean = false; }
      }
      // Resolve bg_job_id from the most-recent terminal phase signal, best-effort.
      let bgJobId = null;
      try {
        for (const f of readdirSync(workerDir)) {
          const m = /^phase-(.+)\.json$/.exec(f);
          if (!m) continue;
          const raw = JSON.parse(readFileSync(join(workerDir, f), "utf8"));
          if (raw?.bg_job_id) bgJobId = raw.bg_job_id;
        }
      } catch { /* no signal / unreadable → null is fine */ }
      out.push({
        ticket,
        teardownDone: true,
        terminalDoneApplied: true,
        worktreePath,
        worktreeOnDisk,
        liveSessionInWorktree,
        inFlight: inFlightTickets.has(ticket),
        treeClean,
        // CTL-791 positive-done evidence: the .terminal-done.applied marker is the
        // pipeline's own confirmed-Done evidence; the reaper re-runs the FULL
        // assessWorktreeRemoval gate on the targeted event regardless, so the
        // janitor's gate stays a cheap pre-filter (marker present = evidence).
        evidenceOk: true,
        alreadyReaped,
        branch: ticket,
        bgJobId,
      });
    } catch (err) {
      log.warn({ ticket, err: err?.message }, "stall-janitor: orphan candidate probe threw — skipping (CTL-1004)");
    }
  }
  return out;
}

// defaultCollectGhostCandidates — find idle background sessions whose subject
// (ticket/phase) has a terminal signal present >=terminalIdleMs. Read-only: it
// correlates the warm agents snapshot to terminal phase signals on disk.
// `resolveTicketFromCwd` maps a session cwd to its ticket; `now`/`statSignal`
// are injected for tests.
export function defaultCollectGhostCandidates({
  orchDir,
  agents = [],
  terminalIdleMs = 600_000,
  now = Date.now,
  resolveTicketFromCwd = defaultTicketFromCwd,
  statSignalMtimeMs = defaultSignalMtimeMs,
} = {}) {
  const out = [];
  if (!Array.isArray(agents)) return out;
  const TERMINAL_STATUSES = new Set(["done", "failed", "stalled", "skipped", "aborted", "complete"]);
  for (const a of agents) {
    try {
      // Only idle BACKGROUND sessions are ghost candidates — the classifier
      // re-checks, but pre-filtering keeps the census cheap.
      if (a?.kind !== "background") continue;
      if (a?.status !== "idle") continue;
      if (!a?.cwd || !a?.sessionId) continue;
      const ticket = resolveTicketFromCwd(a.cwd);
      if (!ticket) continue;
      // Find a terminal phase signal for this ticket; pick its phase + mtime.
      const workerDir = join(orchDir, "workers", ticket);
      let files;
      try { files = readdirSync(workerDir); } catch { continue; }
      for (const f of files) {
        const m = /^phase-(.+)\.json$/.exec(f);
        if (!m) continue;
        let raw;
        try { raw = JSON.parse(readFileSync(join(workerDir, f), "utf8")); } catch { continue; }
        if (!TERMINAL_STATUSES.has(raw?.status)) continue;
        const mtimeMs = statSignalMtimeMs(join(workerDir, f));
        const terminalForMs = mtimeMs == null ? 0 : now() - mtimeMs;
        out.push({
          ticket,
          phase: m[1],
          bgJobId: a.sessionId,
          terminalForMs,
          sessionKind: a.kind,
          sessionStatus: a.status,
        });
        break; // one ghost intent per session
      }
    } catch (err) {
      log.warn({ err: err?.message }, "stall-janitor: ghost candidate probe threw — skipping (CTL-1004)");
    }
  }
  return out;
}

// defaultTicketFromCwd — derive the ticket id from a worktree cwd's last segment
// (~/catalyst/wt/<projectKey>/<TICKET>). Returns null for an unrecognizable path.
export function defaultTicketFromCwd(cwd) {
  if (!cwd) return null;
  const seg = stripTrailingSlash(cwd).split("/").pop();
  return /^[A-Z]+-\d+$/.test(seg ?? "") ? seg : null;
}

// defaultSignalMtimeMs — mtime of a phase signal file, or null when unreadable.
export function defaultSignalMtimeMs(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

// PRIOR_PHASE — phase → the phase whose artifact it waits on, derived by inverting
// NEXT_PHASE (the workflow descriptor's forward successor table). Single source of
// truth: when the pipeline order changes, this map follows automatically. The
// `prior-artifact-retry-exhausted` stall is written for the phase that COULD NOT
// launch because PRIOR_PHASE[phase]'s artifact was missing.
const PRIOR_PHASE = Object.freeze(
  Object.fromEntries(
    Object.entries(NEXT_PHASE)
      .filter(([, next]) => typeof next === "string")
      .map(([phase, next]) => [next, phase]),
  ),
);

// defaultPriorArtifactComplete — does the prior-phase artifact for a stalled phase
// exist AND read as COMPLETE (non-truncated)? Reuses the reclaim sweep's per-phase
// work-done probe (WORK_DONE_PROBES[priorPhase]) so completeness means exactly what
// it means everywhere else: MIN_ARTIFACT_BYTES + the schema's closing markers for a
// thoughts/ doc, a content-validated JSON for a worker-dir signal. Returns false on
// any unknown phase / missing probe / throwing seam (the safe default — stay frozen).
export function defaultPriorArtifactComplete({ ticket, phase, orchDir, repoRoot } = {}) {
  const prior = PRIOR_PHASE[phase];
  if (!prior) return false; // entry phase (no prior) or unknown — never auto-clear
  const probe = WORK_DONE_PROBES[prior];
  if (typeof probe !== "function") return false;
  try {
    return probe({ ticket, orchDir, repoRoot }) === true;
  } catch (err) {
    log.warn({ ticket, phase, prior, err: err?.message }, "stall-janitor: prior-artifact probe threw (CTL-1005)");
    return false;
  }
}

// defaultCollectStallClearCandidates — enumerate every ticket carrying a
// `prior-artifact-retry-exhausted` stall and build the J3 classify ctx from
// read-only probes. The artifact-completeness check (artifactPresent +
// artifactComplete) defaults to defaultPriorArtifactComplete (the reclaim
// work-done probe); Linear-terminal + worktree + live-session detection are
// injected seams (the daemon wires its warm agents snapshot + Linear cache).
// Any throw degrades to "skip this candidate" — the janitor never escalates on
// missing data. Mirrors defaultCollectOrphanCandidates' read-only discipline.
export function defaultCollectStallClearCandidates({
  orchDir,
  projects = [],
  agents = [],
  isLinearTerminal = () => false,
  // resolveWorktreePath(ticket) → the worktree path (or null). Default resolves it
  // from the registered projects' `git worktree list --porcelain` (read-only).
  resolveWorktreePath = undefined,
  // artifactPresent / artifactComplete(ctx) — injectable for tests. In production
  // both fold into the single work-done probe (present ⊆ complete): a complete
  // artifact is necessarily present, so the default derives presence from
  // completeness when a dedicated presence probe is not supplied.
  artifactComplete = undefined,
  artifactPresent = undefined,
  runGit = (args) => spawnSync("git", args, { encoding: "utf8" }),
} = {}) {
  const out = [];
  let workerDirs;
  try {
    workerDirs = readdirSync(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return out; // no workers dir → nothing to census
  }

  // Resolve a worktree path for a ticket across the registered projects (cached).
  const worktreeListByRepo = new Map();
  function defaultResolveWorktreePath(ticket) {
    for (const p of projects) {
      const repoRoot = p?.repoRoot;
      if (!repoRoot) continue;
      let porcelain = worktreeListByRepo.get(repoRoot);
      if (porcelain == null) {
        porcelain = "";
        try {
          const res = runGit(["-C", repoRoot, "worktree", "list", "--porcelain"]);
          if (!res.error && (res.status ?? 1) === 0) porcelain = res.stdout ?? "";
        } catch { /* unreadable → no worktrees */ }
        worktreeListByRepo.set(repoRoot, porcelain);
      }
      const path = parseWorktreeForBranch(porcelain, ticket);
      if (path) return path;
    }
    return null;
  }
  const resolvePath = resolveWorktreePath ?? defaultResolveWorktreePath;

  // repoRoot lookup for the work-done probe (it resolves the worktree itself).
  function repoRootFor(ticket) {
    const team = (ticket.match(/^([A-Z]+)-/) ?? [])[1];
    const p = projects.find((x) => x?.team === team);
    return p?.repoRoot ?? null;
  }

  for (const d of workerDirs) {
    if (!d.isDirectory()) continue;
    const ticket = d.name;
    try {
      const workerDir = join(orchDir, "workers", ticket);
      // Find a `stalled` phase signal carrying the J3-relevant reason.
      // Hoist stalledRaw so CTL-1045 Bug 2+3 can read its fields below.
      let stalledPhase = null;
      let stalledRaw = null;
      for (const f of readdirSync(workerDir)) {
        const m = /^phase-(.+)\.json$/.exec(f);
        if (!m) continue;
        let raw;
        try { raw = JSON.parse(readFileSync(join(workerDir, f), "utf8")); } catch { continue; }
        if (raw?.status === "stalled" && raw?.stalledReason === "prior-artifact-retry-exhausted") {
          stalledPhase = m[1];
          stalledRaw = raw;
          break;
        }
      }
      if (!stalledPhase) continue; // no J3-relevant stall on this ticket

      const worktreePath = resolvePath(ticket);
      const liveSessionInWorktree =
        !!worktreePath &&
        Array.isArray(agents) &&
        agents.some((a) => cwdUnder(a?.cwd, worktreePath));
      const alreadyCleared = existsSync(join(workerDir, `.janitor-cleared-${stalledPhase}.applied`));
      const linearTerminal = (() => {
        try { return isLinearTerminal(ticket) === true; } catch { return false; }
      })();

      // Artifact completeness: a complete artifact is necessarily present, so
      // presence defaults to completeness unless a dedicated presence probe is given.
      const probeCtx = { ticket, phase: stalledPhase, orchDir, repoRoot: repoRootFor(ticket) };
      const complete =
        (artifactComplete ?? defaultPriorArtifactComplete)(probeCtx) === true;
      const present = artifactPresent ? artifactPresent(probeCtx) === true : complete;

      // CTL-1045 Bug 2: read the persisted dispatch failure exit code from the signal.
      // A signal without the field (older signals) gets null → treated as non-clearable.
      const dispatchFailureCode =
        typeof stalledRaw?.dispatchFailureCode === "number" ? stalledRaw.dispatchFailureCode : null;

      // CTL-1045 Bug 3: verify the prior-phase done signal still exists.
      // Without it, clearing the stalled signal leaves an empty worker dir → silent
      // pipeline drop (isTicketInFlight sees no signals → deriveAdvancement finds no done).
      const priorPhaseForStall = PRIOR_PHASE[stalledPhase];
      let priorDoneSignalPresent = false;
      if (priorPhaseForStall) {
        try {
          const pj = JSON.parse(readFileSync(join(workerDir, `phase-${priorPhaseForStall}.json`), "utf8"));
          priorDoneSignalPresent = pj?.status === "done";
        } catch { priorDoneSignalPresent = false; }
      }

      out.push({
        ticket,
        phase: stalledPhase,
        stalledReason: "prior-artifact-retry-exhausted",
        linearTerminal,
        liveSessionInWorktree,
        artifactPresent: present,
        artifactComplete: complete,
        alreadyCleared,
        dispatchFailureCode,       // CTL-1045 Bug 2
        priorDoneSignalPresent,    // CTL-1045 Bug 3
        worktreePath,
      });
    } catch (err) {
      log.warn({ ticket, err: err?.message }, "stall-janitor: stall-clear candidate probe threw — skipping (CTL-1005)");
    }
  }
  return out;
}

// defaultGcTerminalSignals (CTL-1242 J4) — returns the J4 action seam: a
// function that removes the entire workers/<T>/ signal dir for a terminal
// ticket. Best-effort (never throws — a failed rmSync is caught and logged).
// Called by runStallJanitorPass in enforce mode after classifyTerminalSignalGc
// returns "gc". The dir removal clears the ticket from listStartedTickets
// and from all dead/stale views in the next tick.
export function defaultGcTerminalSignals(orchDir) {
  return ({ ticket }) => {
    try {
      rmSync(join(orchDir, "workers", ticket), { recursive: true, force: true });
      return true;
    } catch (err) {
      log.warn({ ticket, err: err?.message }, "stall-janitor: J4 gc rmSync failed — skipping (CTL-1242)");
      return false;
    }
  };
}

// defaultCollectTerminalSignalGcCandidates (CTL-1242 J4) — read-only census
// that builds a J4 classify ctx for every ticket with a workers/<T>/ dir.
// Probes: isLinearTerminalOrMerged (injected), liveSessionInWorktree (warm
// agents snapshot + optional worktree resolution), inFlight (inFlightTickets
// set), alreadyGcd (.janitor-gc.applied marker). Any throw per-candidate is
// caught and skipped — the janitor never escalates on unreadable probes.
export function defaultCollectTerminalSignalGcCandidates({
  orchDir,
  agents = [],
  inFlightTickets = new Set(),
  isLinearTerminalOrMerged = () => false,
  // resolveWorktreePath(ticket) → worktree path or null. Optional: when
  // omitted, liveSessionInWorktree is always false (conservative).
  resolveWorktreePath = () => null,
} = {}) {
  const out = [];
  let workerDirs;
  try {
    workerDirs = readdirSync(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return out;
  }

  for (const d of workerDirs) {
    if (!d.isDirectory()) continue;
    const ticket = d.name;
    try {
      const workerDir = join(orchDir, "workers", ticket);

      // Pre-filter: only include tickets that are provably terminal/merged.
      // Non-terminal tickets are never candidates for J4 GC.
      let terminalOrMerged = false;
      try { terminalOrMerged = isLinearTerminalOrMerged(ticket) === true; } catch { /* skip */ }
      if (!terminalOrMerged) continue;

      const worktreePath = (() => { try { return resolveWorktreePath(ticket); } catch { return null; } })();
      const liveSessionInWorktree =
        !!worktreePath &&
        Array.isArray(agents) &&
        agents.some((a) => cwdUnder(a?.cwd, worktreePath));

      const inFlight = inFlightTickets instanceof Set
        ? inFlightTickets.has(ticket)
        : false;

      const alreadyGcd = existsSync(join(workerDir, ".janitor-gc.applied"));

      out.push({ ticket, linearTerminalOrMerged: true, liveSessionInWorktree, inFlight, alreadyGcd });
    } catch (err) {
      log.warn({ ticket, err: err?.message }, "stall-janitor: J4 gc candidate probe threw — skipping (CTL-1242)");
    }
  }
  return out;
}
