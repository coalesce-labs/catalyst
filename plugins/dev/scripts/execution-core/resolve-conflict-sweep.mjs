// resolve-conflict-sweep.mjs — #1461 deterministic resolvable-conflict sweep
// (ADR-028). Structurally mirrors stall-janitor.mjs / unstuck-sweep.mjs: a PURE
// classifier (no IO) + an action driver (Task 6/7/8) with every side-effect seam
// injected. Runs on stalled tickets DIRECTLY, independent of isTicketInFlight —
// deriveAdvancement excludes any "stalled" ticket from its sweep entirely, so
// this is a dedicated pass, not a deriveAdvancement detour (ADR-028 rationale).
//
// CONFIRMED FIELD-NAME BUG (see this plan's Global Constraints): the real
// producer (phase-agent-dispatch:1150-1157) writes this stall as
// `status:"stalled"` + `.failureReason`, NOT `.stalledReason` — despite every
// existing consumer of this exact reason string (unstuck-sweep.mjs,
// recovery-reasoning.mjs) checking `stalledReason`. This module checks BOTH
// fields defensively so it actually finds real candidates in production.

import { readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync, appendFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { isTicketKey } from "./ticket-key.mjs";
import { classifyMergeTree } from "./stale-pr-rescue.mjs";
import { log, getEventLogPath } from "./config.mjs";
import { RESOLVE_CONFLICT_SWEEP_EVENT_TYPES } from "./resolve-conflict-sweep-event-types.mjs";

export { RESOLVE_CONFLICT_SWEEP_EVENT_TYPES };

const _require = createRequire(import.meta.url);

export const RESOLVE_CONFLICT_STALL_REASON = "source_conflict_ctl708_unavailable";
export const RESOLVED_MARKER_REASON = "source_conflict_resolvable";
export const CAP_EXHAUSTED_REASON = "resolve-conflict-cycle-cap-exhausted";
export const RESOLVE_CONFLICT_CYCLE_CAP =
  Number(process.env.CATALYST_RESOLVE_CONFLICT_CYCLE_CAP) || 3;

// classifyResolveConflictCandidate — PURE. ctx fields:
//   stalledReasonMatches — the candidate's raw reason === RESOLVE_CONFLICT_STALL_REASON
//   alreadyResolving     — the candidate's raw reason === RESOLVED_MARKER_REASON
//                           (already marked + dispatched this cycle; awaiting completion)
//   cycleCount            — countResolveConflictAttempts({ticket}) — event-counted,
//                           durable; counts BOTH complete and failed dispatch
//                           attempts (#1461 Fix 2), so a repeatedly-FAILING run
//                           still reaches RESOLVE_CONFLICT_CYCLE_CAP and escalates
//   classification         — classifyMergeTree(...) result, or null if the merge-tree
//                            probe has not run yet / failed this tick
export function classifyResolveConflictCandidate(ctx = {}) {
  const { stalledReasonMatches, alreadyResolving, cycleCount = 0, classification } = ctx;
  if (!stalledReasonMatches && !alreadyResolving) {
    return { action: "skip", reason: "not-our-stall" };
  }
  if (cycleCount >= RESOLVE_CONFLICT_CYCLE_CAP) {
    return { action: "cap-exhausted", reason: "cycle-cap-exhausted" };
  }
  if (alreadyResolving) {
    return { action: "skip", reason: "already-resolving" };
  }
  if (!classification) {
    return { action: "skip", reason: "classification-unavailable" };
  }
  if (!classification.resolvable) {
    return { action: "skip", reason: "not-resolvable" };
  }
  return { action: "mark-and-dispatch", reason: "resolvable" };
}

// defaultCollectResolveConflictCandidates — read-only census over
// workers/<ticket>/phase-*.json, mirroring defaultCollectUnstuckCandidates'
// scope exactly (same dir layout, same per-candidate try/catch discipline).
// Matches BOTH the real producer's field (failureReason) and the documented-
// but-unused field (stalledReason) for RESOLVE_CONFLICT_STALL_REASON, plus
// RESOLVED_MARKER_REASON (an in-flight candidate this sweep already marked).
export function defaultCollectResolveConflictCandidates({
  orchDir,
  readdirSync: readdir = readdirSync,
  readFileSync: readFile = readFileSync,
  // resolveWorktreePath(ticket) → worktree path or null. Production wiring
  // (Task 12) injects the real resolver; the bare default is null (fail-closed
  // — classifyLiveConflict, Task 5, returns null for a null worktreePath, which
  // the classifier reads as "classification-unavailable" and retries next tick).
  resolveWorktreePath = () => null,
  base = "main",
} = {}) {
  const out = [];
  let workerDirs;
  try {
    workerDirs = readdir(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of workerDirs) {
    if (!d.isDirectory()) continue;
    const ticket = d.name;
    if (!isTicketKey(ticket)) continue;
    try {
      const workerDir = join(orchDir, "workers", ticket);
      let files;
      try {
        files = readdir(workerDir);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^phase-(.+)\.json$/.exec(f);
        if (!m) continue;
        let raw;
        try {
          raw = JSON.parse(readFile(join(workerDir, f), "utf8"));
        } catch {
          continue;
        }
        if (raw?.status !== "stalled") continue;
        const reason = raw.failureReason ?? raw.stalledReason ?? null;
        if (reason !== RESOLVE_CONFLICT_STALL_REASON && reason !== RESOLVED_MARKER_REASON) continue;
        let worktreePath = null;
        try {
          worktreePath = resolveWorktreePath(ticket);
        } catch {
          worktreePath = null; // fail-closed — never let a throwing resolver drop the candidate
        }
        out.push({ ticket, phase: m[1], workerDir, worktreePath, base, raw });
      }
    } catch {
      // per-candidate failures degrade to "skip this ticket" — never abort the census.
      continue;
    }
  }
  return out;
}

// defaultLocalMergeTree — #1461 Fix 5 (final-review finding, human-approved
// design): `git merge-tree --write-tree origin/<base> HEAD` run DIRECTLY in
// the ticket's worktree — comparing the LIVE LOCAL worktree state (HEAD)
// against the base, never the pushed remote ticket branch. The prior
// classifyLiveConflict called stale-pr-rescue-timer.mjs's defaultMergeTree,
// which fetches AND diffs origin/<base> against origin/<ticket> (the PUSHED
// branch) — that only works once a ticket's branch has actually been pushed.
// Dispatch-time pre-flight rebase stalls (this whole sweep's actual trigger)
// typically happen on the IMPLEMENT phase, BEFORE the branch has ever been
// pushed, so fetching origin/<ticket> always failed for that common case and
// classifyLiveConflict permanently returned null (ADR-028's "reachable from
// implement/verify/review" goal was defeated for its most common case). HEAD
// is already local and never needs fetching; only origin/<base> is fetched
// first, so a stale local remote-tracking ref can't produce a false
// "resolvable" read against a base that has since moved on. Not injectable
// via classifyLiveConflict's own `mergeTree` seam misuse — this is a NEW,
// separate seam (do not reuse defaultMergeTree, which insists on fetching a
// remote ref by the `head` name — fetching a literal remote "HEAD" would be
// wrong). Returns the same {exitCode, output} shape classifyMergeTree expects.
export async function defaultLocalMergeTree(worktreePath, base) {
  const fetchRes = spawnSync("git", ["-C", worktreePath, "fetch", "origin", base], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (fetchRes.status !== 0) {
    throw new Error(`git fetch origin ${base} failed (exit ${fetchRes.status}): ${fetchRes.stderr ?? ""}`);
  }
  const res = spawnSync(
    "git",
    ["-C", worktreePath, "merge-tree", "--write-tree", `origin/${base}`, "HEAD"],
    { encoding: "utf8", timeout: 30_000 }
  );
  return { exitCode: res.status ?? 128, output: res.stdout ?? "" };
}

// classifyLiveConflict — re-run git merge-tree against the LIVE local worktree
// (HEAD vs origin/<base> — never trust stale census evidence, and never the
// pushed remote ticket branch; see defaultLocalMergeTree above for why) and
// classify with the existing, UNMODIFIED classifyMergeTree. Returns null (not
// a classification) on any probe failure or missing worktree — the caller's
// classifier then reads that as "classification-unavailable" and retries next
// tick; it never guesses.
export async function classifyLiveConflict({ worktreePath, base }, { mergeTree = defaultLocalMergeTree } = {}) {
  if (!worktreePath) return null;
  try {
    const mt = await mergeTree(worktreePath, base);
    return classifyMergeTree(mt);
  } catch {
    return null;
  }
}

// writeResolveConflictBrief — atomic tmp+rename of resolve-conflict-brief.json,
// mirroring writeRecoveryBrief (recovery-reasoning.mjs). This is the
// phase-resolve-conflict skill's prior-phase artifact (Task 9 wires
// `signal:resolve-conflict-brief.json` into phase-artifact-gate.sh).
export function writeResolveConflictBrief(
  orchDir,
  ticket,
  brief,
  { mkdirSync: mkdir = mkdirSync, writeFileSync: writeFile = writeFileSync, renameSync: rename = renameSync } = {},
) {
  const p = join(orchDir, "workers", ticket, "resolve-conflict-brief.json");
  mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFile(tmp, JSON.stringify({ schema: "resolve-conflict-brief/v1", writtenAt: new Date().toISOString(), ...brief }, null, 2));
  rename(tmp, p);
  return p;
}

// markStalledSignalResolving — atomic read-modify-write of the STALLED phase's
// own signal file: rewrite failureReason (or stalledReason, whichever is
// present) to RESOLVED_MARKER_REASON. Every other field (bg_job_id, status,
// etc.) is preserved untouched — read-modify-write, never a blind overwrite.
export function markStalledSignalResolving(
  signalPath,
  { readFileSync: readFile = readFileSync, writeFileSync: writeFile = writeFileSync, renameSync: rename = renameSync } = {},
) {
  const sig = JSON.parse(readFile(signalPath, "utf8"));
  if ("stalledReason" in sig) sig.stalledReason = RESOLVED_MARKER_REASON;
  else sig.failureReason = RESOLVED_MARKER_REASON;
  sig.updatedAt = new Date().toISOString();
  const tmp = `${signalPath}.tmp.${process.pid}`;
  writeFile(tmp, JSON.stringify(sig, null, 2));
  rename(tmp, signalPath);
}

// The phase name resolve-conflict dispatches TO (phase-agent-dispatch resolves
// this, via skill_for_phase's default `phase-<PHASE>` convention, to the
// /catalyst-dev:phase-resolve-conflict skill) — distinct from the STALLED
// phase (`phase` param below, e.g. "implement"), whose own signal file is the one
// markStalledSignalResolving rewrites.
const RESOLVE_CONFLICT_DISPATCH_PHASE = "resolve-conflict";

// RESOLVE_CONFLICT_CYCLE_TERMINAL_STATUSES — a workers/<T>/phase-resolve-conflict.json
// in one of these statuses represents a FINISHED prior cycle — success (`done`),
// a hard failure (`failed`), a dead/never-launched attempt (`stalled`, the
// launch-failure path — phase-agent-dispatch's mark_launch_failed, OR the
// backstopOnRejection/defaultEmitBackstop rejection path — defaultWriteSignalStalled
// writes the SAME `status:"stalled"` shape for a rejected async/codex dispatch),
// or a maxTurns cutoff (`turn-cap-exhausted` — defaultEmitBackstop's OTHER
// terminal shape, written by defaultWriteSignalTerminal to keep the on-disk
// status matching its own distinct terminal event name). All four are safe to
// reset. `dispatched`/`running` are deliberately excluded: those mean a worker
// may still be genuinely in flight, and resetting would pull the rug out from
// under real in-progress work — see maybeResetForResolveConflictCycle below.
// Escalation-gap fix (#1461 review follow-up): this is also the exact set
// defaultCollectResolveConflictFailures (below) reuses to recognize a FAILED
// resolve-conflict cycle in any of its real shapes, not just the in-skill
// `status:"failed"` hard-error path.
const RESOLVE_CONFLICT_CYCLE_TERMINAL_STATUSES = new Set(["done", "failed", "stalled", "turn-cap-exhausted"]);

// maybeResetForResolveConflictCycle — final-whole-branch-re-review follow-up
// (#1461). Mirrors scheduler.mjs's maybeResetForRemediateCycle (CTL-653)
// exactly in spirit, adapted to resolve-conflict-sweep's shape: there is no
// verify⇄remediate PAIR here — just the single `resolve-conflict` dispatch
// phase, re-entered every time the SAME ticket stalls again for a genuinely NEW
// source conflict.
//
// The gap: defaultMarkAndDispatch calls dispatch(orchDir, ticket,
// "resolve-conflict") on every mark-and-dispatch decision. phase-agent-dispatch's
// own idempotency guard (phase-agent-dispatch: `if EXISTING_STATUS ==
// dispatched|running|done → no-op idempotent`) treats a SECOND dispatch call as
// a no-op whenever workers/<T>/phase-resolve-conflict.json still shows a status
// from the FIRST cycle — because nothing ever deletes that file once the cycle
// finishes (defaultClearStall only ever deletes the ORIGINAL stalled-phase
// signal, e.g. phase-implement.json, never phase-resolve-conflict.json itself).
// defaultCollectResolveConflictCompletions then reads the STALE "done" as a
// fresh completion and clearStall fires with zero real resolution work having
// happened on cycle 2+. Repeats forever: no phase.resolve-conflict.complete/
// failed event is ever emitted for cycle 2+, so countResolveConflictAttempts
// never advances past cycle 1's contribution and RESOLVE_CONFLICT_CYCLE_CAP can
// never trip — an unresolvable, recurring conflict spins forever instead of
// ever escalating to a human.
//
// The fix: before defaultMarkAndDispatch initiates a NEW dispatch for a
// candidate, delete the STALE workers/<T>/phase-resolve-conflict.json (+ its
// resolve-conflict-brief.json artifact) IF AND ONLY IF the signal is in a
// terminal status (RESOLVE_CONFLICT_CYCLE_TERMINAL_STATUSES) — a completed/dead
// prior cycle, never an in-flight one. Also drops the phase's CTL-736
// single-flight claim tombstones (`resolve-conflict.claim.<gen>`) so
// phase-agent-dispatch's fresh (no-signal ⇒ gen 1) claim is exclusive instead of
// colliding with a leftover gen-1 tombstone from the prior cycle (GATE-0,
// mirrored from maybeResetForRemediateCycle's own claim-tombstone clear) — and
// any `.progress-resolve-conflict` high-water marker, so a fresh attempt is
// measured from zero rather than false-STOPPED by the prior cycle's progress.
//
// Safety-critical: an in-flight (`dispatched`/`running`) signal is left
// completely untouched — this function only ever fires immediately before
// defaultMarkAndDispatch's own fresh dispatch call, never on an independent
// schedule that could race with an actual live worker.
//
// Returns true when a reset happened (there was a terminal signal to clear);
// false when there was nothing to reset — no signal at all (the common first-
// cycle case), an unreadable/malformed signal, or an in-flight one (left alone).
export function maybeResetForResolveConflictCycle(
  orchDir,
  ticket,
  { rmSync: rm = rmSync, readFileSync: readFile = readFileSync, readdirSync: readdir = readdirSync } = {},
) {
  const workerDir = join(orchDir, "workers", ticket);
  const signalPath = join(workerDir, `phase-${RESOLVE_CONFLICT_DISPATCH_PHASE}.json`);
  let sig;
  try {
    sig = JSON.parse(readFile(signalPath, "utf8"));
  } catch {
    return false; // absent/unreadable — nothing to reset (first cycle, or already clean)
  }
  if (!RESOLVE_CONFLICT_CYCLE_TERMINAL_STATUSES.has(sig?.status)) {
    return false; // dispatched/running (or any other non-terminal status) — never touch
  }
  try {
    rm(signalPath, { force: true });
  } catch {
    // best-effort — a missing file is the desired end state anyway
  }
  try {
    rm(join(workerDir, "resolve-conflict-brief.json"), { force: true });
  } catch {
    /* best-effort */
  }
  let workerEntries;
  try {
    workerEntries = readdir(workerDir);
  } catch {
    workerEntries = []; // worker dir gone — nothing left to clean
  }
  for (const f of workerEntries) {
    const isClaim = f.startsWith(`${RESOLVE_CONFLICT_DISPATCH_PHASE}.claim.`);
    const isProgress = f === `.progress-${RESOLVE_CONFLICT_DISPATCH_PHASE}`;
    if (isClaim || isProgress) {
      try {
        rm(join(workerDir, f), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  return true;
}

// defaultMarkAndDispatch — the "mark-and-dispatch" action seam. Mirrors
// defaultInvokeRecoveryPass's dispatch section (recovery-reasoning.mjs:1650-
// 1828) exactly: lazy-require dispatch.mjs (avoids loading the dispatch graph
// on the off/shadow paths), settle an sdk-fleet Promise synchronously via
// isThenable/settleDispatchSync, verify the settled signal is actually runnable
// via sdkSignalRunnable (NOT a blind verifySync:true — a resolved {code:1} or a
// signal that never went runnable must not be reported as success), and wire
// backstopOnRejection as the onSettled handler so a REJECTED sdk dispatch flips
// the stalled phase's signal to failed + emits phase.<phase>.failed instead of
// stranding silently. The signal-mark + brief-write are wrapped in their own
// try/catch (malformed JSON, filesystem errors) so a write failure returns a
// structured {success:false, reason} instead of throwing out of the function —
// exactly like defaultInvokeRecoveryPass's own brief-write guard
// (recovery-reasoning.mjs:1733-1743).
export function defaultMarkAndDispatch(
  { ticket, phase, workerDir, worktreePath, base, classification, cycleCount, orchDir },
  deps = {},
) {
  // #1461 follow-up (final whole-branch re-review): reset a STALE terminal
  // workers/<T>/phase-resolve-conflict.json (+ its claim tombstones/artifact)
  // left over from a completed prior cycle, so THIS fresh dispatch is not
  // silently swallowed as idempotent by phase-agent-dispatch's own guard. Runs
  // immediately before initiating the dispatch below — never on an independent
  // schedule — and never touches an in-flight (dispatched/running) signal; see
  // maybeResetForResolveConflictCycle for the full rationale. Best-effort: a
  // reset failure must not block the dispatch attempt (same degrade-and-
  // continue discipline as the rest of this function).
  try {
    maybeResetForResolveConflictCycle(orchDir, ticket, deps);
  } catch (err) {
    log.warn(
      { ticket, phase, err: err?.message },
      "resolve-conflict-sweep: cycle-reset failed (#1461) — proceeding with dispatch anyway"
    );
  }

  const signalPath = join(workerDir, `phase-${phase}.json`);
  try {
    markStalledSignalResolving(signalPath, deps);

    writeResolveConflictBrief(
      orchDir,
      ticket,
      {
        stalledPhase: phase,
        conflictFiles: classification.conflictFiles,
        conflictTypes: classification.conflictTypes,
        worktreePath,
        base,
        attempt: cycleCount + 1,
        maxAttempts: RESOLVE_CONFLICT_CYCLE_CAP,
      },
      deps,
    );
  } catch (err) {
    return { success: false, dispatched: false, reason: `mark/brief write failed: ${err.message}` };
  }

  let dispatchTicket, isThenable, settleDispatchSync, backstopOnRejection, sdkSignalRunnable;
  try {
    ({ dispatchTicket, isThenable, settleDispatchSync, backstopOnRejection, sdkSignalRunnable } =
      deps.dispatchMod ?? _require("./dispatch.mjs"));
  } catch (err) {
    return { success: false, dispatched: false, reason: `dispatch module load failed: ${err.message}` };
  }
  const dispatch = deps.dispatch ?? dispatchTicket;
  const thenableCheck = deps.isThenable ?? isThenable;
  const verifyRunnable = deps.sdkSignalRunnable ?? sdkSignalRunnable;
  const backstop = deps.backstopOnRejection ?? backstopOnRejection;

  let r;
  try {
    const rawR = dispatch(orchDir, ticket, RESOLVE_CONFLICT_DISPATCH_PHASE);
    if (thenableCheck && thenableCheck(rawR)) {
      const settle = deps.settleDispatchSync ?? settleDispatchSync;
      // onSettled mirrors defaultInvokeRecoveryPass (recovery-reasoning.mjs:1759-
      // 1786): fail on EITHER a rejection OR a resolved non-zero code, and on
      // failure route through backstopOnRejection so the stalled phase's signal
      // gets a terminal failed event instead of stranding at "dispatched".
      const onSettled = (_res, err) => {
        const failed = err || (_res && Number.isFinite(_res.code) && _res.code !== 0);
        if (!failed) return; // clean resolution → the worker/skill owns its terminal event
        try {
          backstop?.(
            { orchDir, ticket, phase: RESOLVE_CONFLICT_DISPATCH_PHASE },
          )(_res, err ?? new Error(`sdk resolve-conflict resolved code=${_res?.code}`));
        } catch {
          /* best-effort — a failing backstop must not surface as an unhandled rejection */
        }
      };
      r = settle(rawR, {
        verifySync: () => (verifyRunnable ? verifyRunnable(orchDir, ticket, RESOLVE_CONFLICT_DISPATCH_PHASE) : true),
        onSettled,
      });
    } else {
      r = rawR;
    }
  } catch (err) {
    return { success: false, dispatched: false, reason: `dispatch threw: ${err.message}` };
  }

  if (r && r.code === 0) {
    return {
      success: true,
      dispatched: true,
      bgJobId: r.signal?.bg_job_id ?? null,
      pendingSdk: r.async ? r.pending ?? null : null,
    };
  }
  return {
    success: false,
    dispatched: false,
    reason: r?.stderr ?? `dispatch failed (code ${r?.code ?? "unknown"})`,
    pendingSdk: r?.async ? r.pending ?? null : null,
  };
}

// defaultPostResolveConflictComment — thin wrapper over the shared
// linear-comment-post.sh helper, mirroring defaultRunCommentPost in
// unstuck-sweep.mjs. Best-effort: never throws.
function defaultPostResolveConflictComment(ticket, body) {
  const helperPath = join(process.env.PLUGIN_ROOT ?? process.cwd(), "scripts/lib/linear-comment-post.sh");
  const res = spawnSync(helperPath, [ticket, body], { encoding: "utf8", timeout: 10_000 });
  return !res.error && (res.status ?? 1) === 0;
}

// defaultEscalateCapExhausted — the cap-exhaustion escalate seam. Rewrites the
// stalled phase's signal to CAP_EXHAUSTED_REASON (a NEW, non-colliding reason —
// this is a normal `stalled` status, so the existing terminal-label sweep
// (scheduler.mjs) applies needs-human to it exactly like
// remediate-cycle-cap-exhausted already does; Task 10's exemption is scoped
// ONLY to RESOLVED_MARKER_REASON, never to this one). Posts the escalation
// comment mirroring recovery-emit.mjs's header convention VISUALLY (not wired
// into inbox-ask.mjs's parser — see this plan's Global Constraints).
export function defaultEscalateCapExhausted(
  { ticket, phase, workerDir, cycleCount },
  { readFileSync: readFile = readFileSync, writeFileSync: writeFile = writeFileSync, renameSync: rename = renameSync, postComment = defaultPostResolveConflictComment } = {},
) {
  const signalPath = join(workerDir, `phase-${phase}.json`);
  const sig = JSON.parse(readFile(signalPath, "utf8"));
  if ("stalledReason" in sig) sig.stalledReason = CAP_EXHAUSTED_REASON;
  else sig.failureReason = CAP_EXHAUSTED_REASON;
  sig.updatedAt = new Date().toISOString();
  const tmp = `${signalPath}.tmp.${process.pid}`;
  writeFile(tmp, JSON.stringify(sig, null, 2));
  rename(tmp, signalPath);

  const body = `🔼 **phase-resolve-conflict** escalated this to the operator — ${ticket}/${phase} hit the resolve-conflict cycle cap (${RESOLVE_CONFLICT_CYCLE_CAP}) after ${cycleCount} attempt(s) without a clean resolution; manual conflict resolution needed.`;
  return postComment(ticket, body);
}

// defaultCollectResolveConflictCompletions — find every ticket whose
// resolve-conflict phase signal is "done" and read which original phase to
// clear from resolve-conflict-brief.json's stalledPhase. Read-only.
//
// #1461 Fix 1 (CRITICAL final-review finding): this census used to key a
// "completion" off ONLY {status:"done" on phase-resolve-conflict.json} + a
// present resolve-conflict-brief.json — neither file is ever removed or
// marked after a successful clear, so the SAME completion was re-collected on
// EVERY subsequent tick forever (until the whole worker dir is archived at
// pipeline teardown), and defaultClearStall does real, destructive work
// UNCONDITIONALLY on every call: it deletes workers/<T>/phase-<stalledPhase>.json
// (destroying a FRESH signal from a newly-redispatched live worker on every
// tick after the first), deletes the escalation-cooldown marker every tick
// (permanently defeating CTL-1442's ask-budget), deletes
// .orphan-detected.applied every tick (spuriously re-emitting orphan-detected),
// and calls clearStalledLabel every tick (a Linear API write per tick per
// already-cleared ticket, forever).
//
// The fix: a completion is now reported ONLY when the ORIGINAL stalled-phase
// signal (workers/<T>/phase-<stalledPhase>.json) is STILL PRESENT and STILL
// carries the exact RESOLVED_MARKER_REASON this sweep itself wrote via
// markStalledSignalResolving. defaultClearStall's own first step
// unconditionally deletes that exact file, so once a clear has actually run,
// the file is gone and this census naturally stops re-firing for that ticket —
// no separate marker file needed (a second file that must ALSO be correctly
// re-armed across a future, genuinely-new stall/resolve cycle on the same
// ticket+phase would just be a second thing to keep in sync; the existing
// signal file already carries the exact state needed). Three cases: (a) file
// present + reason still RESOLVED_MARKER_REASON → genuine, not-yet-cleared
// completion, report it; (b) file absent (clearStall already deleted it, or a
// teardown/reap removed the worker) → already handled, do not re-report; (c)
// file present but some OTHER process already changed the reason (e.g. a
// manual operator re-arm, or CAP_EXHAUSTED_REASON from a parallel cap-exhaust
// path) → something else already owns this ticket's stall, do not re-fire.
export function defaultCollectResolveConflictCompletions({
  orchDir,
  readdirSync: readdir = readdirSync,
  readFileSync: readFile = readFileSync,
} = {}) {
  const out = [];
  let workerDirs;
  try {
    workerDirs = readdir(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of workerDirs) {
    if (!d.isDirectory()) continue;
    const ticket = d.name;
    if (!isTicketKey(ticket)) continue;
    try {
      const workerDir = join(orchDir, "workers", ticket);
      let sig;
      try {
        sig = JSON.parse(readFile(join(workerDir, "phase-resolve-conflict.json"), "utf8"));
      } catch {
        continue; // no resolve-conflict signal for this ticket
      }
      if (sig?.status !== "done") continue;
      let brief;
      try {
        brief = JSON.parse(readFile(join(workerDir, "resolve-conflict-brief.json"), "utf8"));
      } catch {
        continue; // done signal but no brief — cannot know which phase to clear
      }
      if (!brief?.stalledPhase) continue;

      // Idempotence guard (Fix 1): only a still-marked, not-yet-cleared stall
      // is a genuine completion to act on.
      let stalledRaw;
      try {
        stalledRaw = JSON.parse(readFile(join(workerDir, `phase-${brief.stalledPhase}.json`), "utf8"));
      } catch {
        continue; // absent/unreadable — a prior clearStall already removed it
      }
      const stalledReason = stalledRaw?.failureReason ?? stalledRaw?.stalledReason ?? null;
      if (stalledReason !== RESOLVED_MARKER_REASON) continue; // already changed/cleared by something else

      out.push({ ticket, stalledPhase: brief.stalledPhase });
    } catch {
      continue;
    }
  }
  return out;
}

// defaultCollectResolveConflictFailures — escalation-gap fix (#1461 final-
// review follow-up). Census sibling of defaultCollectResolveConflictCompletions,
// same read-only discipline, but keyed on `phase-resolve-conflict.json` landing
// in any FAILURE-shaped terminal status instead of "done". Before this function
// existed, a FAILED resolve-conflict run was invisible to every collector in
// this file: the cap counter (countResolveConflictAttempts, event-scan.mjs)
// already incremented correctly on the ticket's `phase.resolve-conflict.failed.
// <ticket>` event, but nothing ever reverted the ORIGINAL stalled phase's
// RESOLVED_MARKER_REASON marker that markStalledSignalResolving wrote before
// dispatch — so the ticket could never again satisfy
// classifyResolveConflictCandidate's stalledReasonMatches/alreadyResolving-at-cap
// branches on a FRESH classify pass once it had been re-armed. See
// runResolveConflictSweepPass's failures sub-pass (below) for the two outcomes
// this feeds: escalate (at/over cap) or revert + reset (under cap).
//
// CTL review follow-up (post-fb135a0c): a bare `status === "failed"` check only
// matched the in-skill hard-error path (phase-agent-emit-complete
// --status failed). It MISSED the other two real failure shapes a resolve-
// conflict dispatch can land in on-disk:
//   - phase-agent-dispatch's mark_launch_failed (a dead/never-launched
//     attempt) writes `status:"stalled"` (+ `attentionReason`, NOT
//     `failureReason`/`stalledReason`) and emits phase.resolve-conflict.failed
//     with --no-signal-update — so the durable counter climbs but the on-disk
//     signal reads "stalled", not "failed".
//   - dispatch.mjs's backstopOnRejection → defaultEmitBackstop writes the SAME
//     `status:"stalled"` shape (via defaultWriteSignalStalled) for a REJECTED
//     async/codex dispatch — this is defaultMarkAndDispatch's OWN `onSettled`
//     handler (see below), so under an all-codex/all-sdk executor routing this
//     is the LIVE production dispatch-failure path, and the ORIGINAL bare
//     check missed it entirely.
//   - the same backstop's maxTurns outcome writes `status:"turn-cap-exhausted"`
//     (a THIRD terminal shape, kept distinct from "stalled" so its status
//     matches its own differently-named terminal event).
// Fix: match RESOLVE_CONFLICT_CYCLE_TERMINAL_STATUSES (the same set
// maybeResetForResolveConflictCycle already uses to decide this exact file is
// resettable) minus "done" — i.e. {failed, stalled, turn-cap-exhausted} — so
// every real failure shape is recognized, not just the narrowest one. This is
// safe: mark_launch_failed / defaultWriteSignalStalled write `attentionReason`,
// not `failureReason`/`stalledReason`, so defaultCollectResolveConflictCandidates
// resolves this SAME file's `reason` to null and never double-treats
// phase-resolve-conflict.json itself as a candidate; `dispatched`/`running` stay
// correctly excluded either way (not in the terminal set).
//
// Same idempotence guard as Fix 1's completions collector, and for the exact
// same reason: report a genuine, not-yet-acted-on failure ONLY while the
// original stalled-phase signal still carries RESOLVED_MARKER_REASON. Once this
// sweep's failure-handling path acts — reverting the reason back to
// RESOLVE_CONFLICT_STALL_REASON, or escalating it to CAP_EXHAUSTED_REASON — the
// reason no longer matches and this census naturally stops re-firing for the
// same failure. No separate once-marker file needed; the existing signal
// already carries the state.
//
// Includes `workerDir` in each item (unlike defaultCollectResolveConflictCompletions,
// which omits it since its only consumer — clearStall — is pre-bound to orchDir
// by the scheduler wiring) because this census's own consumer path calls the
// SHARED escalateCapExhausted seam directly, and that seam's contract
// (defaultEscalateCapExhausted) requires an explicit workerDir field, exactly
// like the candidates census already supplies for its own cap-exhausted branch.
export function defaultCollectResolveConflictFailures({
  orchDir,
  readdirSync: readdir = readdirSync,
  readFileSync: readFile = readFileSync,
} = {}) {
  const out = [];
  let workerDirs;
  try {
    workerDirs = readdir(join(orchDir, "workers"), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of workerDirs) {
    if (!d.isDirectory()) continue;
    const ticket = d.name;
    if (!isTicketKey(ticket)) continue;
    try {
      const workerDir = join(orchDir, "workers", ticket);
      let sig;
      try {
        sig = JSON.parse(readFile(join(workerDir, "phase-resolve-conflict.json"), "utf8"));
      } catch {
        continue; // no resolve-conflict signal for this ticket
      }
      if (sig?.status === "done") continue; // that's defaultCollectResolveConflictCompletions's job
      if (!RESOLVE_CONFLICT_CYCLE_TERMINAL_STATUSES.has(sig?.status)) continue; // dispatched/running/undefined/etc. — not a finished failure
      let brief;
      try {
        brief = JSON.parse(readFile(join(workerDir, "resolve-conflict-brief.json"), "utf8"));
      } catch {
        continue; // failed signal but no brief — cannot know which phase to act on
      }
      if (!brief?.stalledPhase) continue;

      let stalledRaw;
      try {
        stalledRaw = JSON.parse(readFile(join(workerDir, `phase-${brief.stalledPhase}.json`), "utf8"));
      } catch {
        continue; // absent/unreadable — already reverted/escalated, or never existed
      }
      const stalledReason = stalledRaw?.failureReason ?? stalledRaw?.stalledReason ?? null;
      if (stalledReason !== RESOLVED_MARKER_REASON) continue; // already acted on by this sweep or something else

      out.push({ ticket, stalledPhase: brief.stalledPhase, workerDir });
    } catch {
      continue;
    }
  }
  return out;
}

// defaultRevertStallAndResetCycle — escalation-gap fix (#1461 final-review
// follow-up), the UNDER-cap outcome for a FAILED resolve-conflict run. Two
// steps:
//   1. Revert the ORIGINAL stalled phase's signal reason from
//      RESOLVED_MARKER_REASON back to RESOLVE_CONFLICT_STALL_REASON —
//      read-modify-write, the exact mirror of markStalledSignalResolving but in
//      reverse (every other field, e.g. bg_job_id, untouched).
//   2. REUSE maybeResetForResolveConflictCycle verbatim (no duplicated deletion
//      logic) to clear the stale terminal phase-resolve-conflict.json + its
//      resolve-conflict-brief.json + claim tombstones/progress marker — the
//      exact same reset defaultMarkAndDispatch already runs before a fresh
//      cycle-2+ dispatch. Without step 2, a later successful re-classification
//      of this ticket as a genuine candidate would immediately hit the SAME
//      phase-agent-dispatch idempotency no-op maybeResetForResolveConflictCycle
//      was originally built to prevent (see that function's own header comment).
//
// Once step 1 lands, defaultCollectResolveConflictFailures's own idempotence
// guard stops re-reporting this failure (the reason no longer matches
// RESOLVED_MARKER_REASON). Because runResolveConflictSweepPass's candidates
// sub-pass runs synchronously right after the failures sub-pass IN THE SAME
// TICK (collectCandidates() re-reads the filesystem fresh, after this revert
// has already landed on disk), defaultCollectResolveConflictCandidates can
// pick the ticket back up as a genuine RESOLVE_CONFLICT_STALL_REASON candidate
// in that SAME tick — classifyResolveConflictCandidate then re-evaluates it
// fresh, exactly as if this were the ticket's first stall, and a fresh
// mark-and-dispatch can fire before this tick even ends (not merely "a later
// tick" — this revert is often invisible for less than one scheduler tick).
//
// Best-effort per step, mirroring defaultMarkAndDispatch's cycle-reset call:
// step 2 failing must not undo step 1 (the revert is the safety-critical part —
// worst case a stale reset leaves one extra idempotent no-op on the NEXT
// dispatch, which itself re-runs this same reset before dispatching).
export function defaultRevertStallAndResetCycle(
  orchDir,
  ticket,
  stalledPhase,
  {
    readFileSync: readFile = readFileSync,
    writeFileSync: writeFile = writeFileSync,
    renameSync: rename = renameSync,
    rmSync: rm = rmSync,
    readdirSync: readdir = readdirSync,
  } = {},
) {
  const workerDir = join(orchDir, "workers", ticket);
  const signalPath = join(workerDir, `phase-${stalledPhase}.json`);
  try {
    const sig = JSON.parse(readFile(signalPath, "utf8"));
    // M2 (review follow-up): defensive re-check — only overwrite the reason if
    // it's STILL RESOLVED_MARKER_REASON at the moment of the write. The
    // collector already guards on this at census time, but a narrow window
    // exists between that read and this write in which a concurrent writer
    // (an operator re-arming the ticket, or a parallel recovery-pass/cap-
    // exhaustion path) could have already changed the reason — e.g. to
    // CAP_EXHAUSTED_REASON. Silently clobbering that with a stale revert would
    // resurrect a ticket that was just correctly terminal-escalated. A
    // mismatch here is not an error — something else already owns this
    // ticket's stall — so this returns false (not-acted), same shape as any
    // other no-op outcome, and never throws.
    const currentReason = ("stalledReason" in sig ? sig.stalledReason : sig.failureReason) ?? null;
    if (currentReason !== RESOLVED_MARKER_REASON) {
      log.warn(
        { ticket, stalledPhase, currentReason },
        "resolve-conflict-sweep: stall reason changed out from under the revert (#1461 escalation-gap fix) — leaving it to whatever owns it now"
      );
      return false;
    }
    if ("stalledReason" in sig) sig.stalledReason = RESOLVE_CONFLICT_STALL_REASON;
    else sig.failureReason = RESOLVE_CONFLICT_STALL_REASON;
    sig.updatedAt = new Date().toISOString();
    const tmp = `${signalPath}.tmp.${process.pid}`;
    writeFile(tmp, JSON.stringify(sig, null, 2));
    rename(tmp, signalPath);
  } catch (err) {
    log.warn(
      { ticket, stalledPhase, err: err?.message },
      "resolve-conflict-sweep: stall-reason revert failed (#1461 escalation-gap fix) — leaving failed cycle unresolved this tick"
    );
    return false;
  }
  try {
    maybeResetForResolveConflictCycle(orchDir, ticket, { rmSync: rm, readFileSync: readFile, readdirSync: readdir });
  } catch (err) {
    log.warn(
      { ticket, stalledPhase, err: err?.message },
      "resolve-conflict-sweep: cycle-reset after stall-reason revert failed (#1461 escalation-gap fix) — proceeding anyway"
    );
  }
  return true;
}

// runResolveConflictSweepPass — the action driver. Every side-effect seam is
// injected; mirrors runUnstuckSweepPass's off/shadow/enforce shape + report.
// Three independent sub-passes per tick: (1) candidates → classify → mark-and-
// dispatch or cap-exhausted-escalate; (2) completions (status:"done") →
// clearStall; (3) failures (status:"failed", #1461 escalation-gap fix) →
// cap-exhausted-escalate or revert-and-reset-cycle. Order is
// completions-then-failures-then-candidates so a just-completed or
// just-failed ticket's stall is cleared/reverted before that same tick's
// candidate scan would otherwise re-see it (defensive; either order is safe
// since an acted-on ticket no longer carries the marker the candidate census
// keys on).
// NOTE: deliberately NOT declared `async` at the top level. Mode "off" must
// return the plain report object synchronously (no Promise wrapper) so a
// caller can check it without awaiting; shadow/enforce need `await
// classifyLive(...)` internally, so that path is delegated to an inner async
// IIFE and its Promise is returned instead. Either way the caller may safely
// `await` the result — awaiting a non-Promise is a no-op.
export function runResolveConflictSweepPass({
  mode = "off",
  collectCandidates = () => [],
  collectCompletions = () => [],
  collectFailures = () => [],
  classifyLive = async () => null,
  cycleCountOf = () => 0,
  markAndDispatch = () => ({ success: false, dispatched: false }),
  escalateCapExhausted = () => false,
  clearStall = () => false,
  revertStallAndResetCycle = () => false,
  emit = async () => true,
} = {}) {
  const report = {
    marked: [],
    wouldMark: [],
    escalated: [],
    wouldEscalate: [],
    cleared: [],
    wouldClear: [],
    retried: [],
    wouldRetry: [],
    skipped: [],
    failed: [],
  };
  if (mode === "off") return report;
  const enforce = mode === "enforce";

  return (async () => {
    const fire = (type, fields) => {
      try {
        const p = emit(type, fields);
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        /* best-effort */
      }
    };

    // ---- completions: clear the stall for a finished resolve-conflict run ----
    let completions = [];
    try {
      completions = collectCompletions() ?? [];
    } catch {
      completions = [];
    }
    for (const c of completions) {
      try {
        if (!enforce) {
          fire("resolve-conflict.would.clear", { ticket: c.ticket, phase: c.stalledPhase });
          report.wouldClear.push({ ticket: c.ticket, phase: c.stalledPhase });
          continue;
        }
        const ok = clearStall({ ticket: c.ticket, phase: c.stalledPhase });
        if (ok === false) {
          report.failed.push({ ticket: c.ticket, phase: c.stalledPhase, reason: "clearStall-returned-false" });
          continue;
        }
        fire("resolve-conflict.cleared", { ticket: c.ticket, phase: c.stalledPhase });
        report.cleared.push({ ticket: c.ticket, phase: c.stalledPhase });
      } catch (err) {
        report.failed.push({ ticket: c?.ticket, phase: c?.stalledPhase, reason: err?.message });
      }
    }

    // ---- failures (#1461 escalation-gap fix): a FAILED resolve-conflict run
    // either escalates (at/over cap, via the SAME escalateCapExhausted seam the
    // candidates sub-pass below uses) or reverts the original stall + resets the
    // stale cycle (under cap) so the ticket becomes a genuine candidate again —
    // and since collectCandidates() below runs synchronously right after this
    // loop, in the SAME tick, a reverted ticket can be re-classified and
    // re-dispatched before this tick even ends, not merely "on a later tick".
    // See defaultCollectResolveConflictFailures / defaultRevertStallAndResetCycle
    // above for the full rationale — this is a NEW, parallel path; it never
    // touches a "done" completion (that's the completions sub-pass above) and
    // never touches a dispatched/running signal (the collector's own
    // idempotence guard + terminal-status filter exclude those entirely).
    let failures = [];
    try {
      failures = collectFailures() ?? [];
    } catch {
      failures = [];
    }
    for (const f of failures) {
      try {
        const cycleCount = cycleCountOf(f.ticket);
        if (cycleCount >= RESOLVE_CONFLICT_CYCLE_CAP) {
          if (!enforce) {
            fire("resolve-conflict.would.escalate", { ticket: f.ticket, phase: f.stalledPhase });
            report.wouldEscalate.push({ ticket: f.ticket, phase: f.stalledPhase });
            continue;
          }
          const posted = escalateCapExhausted({ ticket: f.ticket, phase: f.stalledPhase, workerDir: f.workerDir, cycleCount });
          fire("resolve-conflict.escalated", { ticket: f.ticket, phase: f.stalledPhase, posted });
          report.escalated.push({ ticket: f.ticket, phase: f.stalledPhase });
          continue;
        }
        if (!enforce) {
          fire("resolve-conflict.would.retry", { ticket: f.ticket, phase: f.stalledPhase });
          report.wouldRetry.push({ ticket: f.ticket, phase: f.stalledPhase });
          continue;
        }
        const ok = revertStallAndResetCycle({ ticket: f.ticket, stalledPhase: f.stalledPhase });
        if (ok === false) {
          report.failed.push({ ticket: f.ticket, phase: f.stalledPhase, reason: "revert-stall-and-reset-cycle-returned-false" });
          continue;
        }
        fire("resolve-conflict.retry-armed", { ticket: f.ticket, phase: f.stalledPhase });
        report.retried.push({ ticket: f.ticket, phase: f.stalledPhase });
      } catch (err) {
        report.failed.push({ ticket: f?.ticket, phase: f?.stalledPhase, reason: err?.message });
      }
    }

    // ---- candidates: classify then mark-and-dispatch / cap-exhausted ----
    let candidates = [];
    try {
      candidates = collectCandidates() ?? [];
    } catch {
      return report; // a throwing census degrades to "nothing to do" this tick
    }
    for (const c of candidates) {
      try {
        const reason = c.raw?.failureReason ?? c.raw?.stalledReason ?? null;
        const stalledReasonMatches = reason === RESOLVE_CONFLICT_STALL_REASON;
        const alreadyResolving = reason === RESOLVED_MARKER_REASON;
        const cycleCount = cycleCountOf(c.ticket);
        // Only probe merge-tree for a reason this sweep actually owns — never
        // spawn git for a not-our-stall candidate (classifier would skip it anyway).
        // #1461 Fix 5: no `head` arg any more — classification is always against
        // the LOCAL worktree's HEAD, not the pushed ticket branch (see
        // classifyLiveConflict / defaultLocalMergeTree above).
        const classification =
          stalledReasonMatches && cycleCount < RESOLVE_CONFLICT_CYCLE_CAP
            ? await classifyLive({ worktreePath: c.worktreePath, base: c.base })
            : null;
        const decision = classifyResolveConflictCandidate({ stalledReasonMatches, alreadyResolving, cycleCount, classification });

        if (decision.action === "skip") {
          report.skipped.push({ ticket: c.ticket, phase: c.phase, reason: decision.reason });
          continue;
        }

        if (decision.action === "cap-exhausted") {
          if (!enforce) {
            fire("resolve-conflict.would.escalate", { ticket: c.ticket, phase: c.phase });
            report.wouldEscalate.push({ ticket: c.ticket, phase: c.phase });
            continue;
          }
          const posted = escalateCapExhausted({ ticket: c.ticket, phase: c.phase, workerDir: c.workerDir, cycleCount });
          fire("resolve-conflict.escalated", { ticket: c.ticket, phase: c.phase, posted });
          report.escalated.push({ ticket: c.ticket, phase: c.phase });
          continue;
        }

        // mark-and-dispatch
        if (!enforce) {
          fire("resolve-conflict.would.mark", { ticket: c.ticket, phase: c.phase });
          // #1461 Fix 4: the enforce path fires TWO distinct events for this
          // action (marked.resolvable, then dispatched once markAndDispatch
          // actually dispatches) — resolve-conflict.would.dispatch was in the
          // closed vocabulary but never fired on the shadow twin, leaving it
          // dead on both ends. Fire it alongside would.mark so shadow mode has
          // full observability parity with what enforce would actually do.
          fire("resolve-conflict.would.dispatch", { ticket: c.ticket, phase: c.phase });
          report.wouldMark.push({ ticket: c.ticket, phase: c.phase });
          continue;
        }
        const result = markAndDispatch({
          ticket: c.ticket,
          phase: c.phase,
          workerDir: c.workerDir,
          worktreePath: c.worktreePath,
          base: c.base,
          classification,
          cycleCount,
        });
        if (!result?.success) {
          report.failed.push({ ticket: c.ticket, phase: c.phase, reason: result?.reason ?? "mark-and-dispatch-failed" });
          continue;
        }
        fire("resolve-conflict.marked.resolvable", { ticket: c.ticket, phase: c.phase });
        if (result.dispatched) fire("resolve-conflict.dispatched", { ticket: c.ticket, phase: c.phase });
        report.marked.push({ ticket: c.ticket, phase: c.phase });
      } catch (err) {
        report.failed.push({ ticket: c?.ticket, phase: c?.phase, reason: err?.message });
      }
    }

    return report;
  })();
}

// emitResolveConflictEvent — #1461 Fix 4 (IMPORTANT final-review finding):
// dedicated unified-log emitter for the resolve-conflict-sweep vocabulary,
// mirroring emitUnstuckEvent (unstuck-sweep.mjs) exactly. Without this, the
// production `runTick` never set an `emit` seam, so runResolveConflictSweepPass
// fell back to its own internal no-op default (`emit = async () => true`) —
// shadow mode produced ZERO event output, defeating ADR-023's shadow-then-
// enforce discipline: an operator flipping CATALYST_RESOLVE_CONFLICT_SWEEP=shadow
// had no way to see what the sweep WOULD have done. Validates against this
// sweep's OWN closed vocabulary (RESOLVE_CONFLICT_SWEEP_EVENT_TYPES) and
// appends to the same unified log getEventLogPath() resolves to. Logs (does
// NOT silently swallow) an append failure — this also closes the related
// deferred finding that the driver's own `fire()` helper swallows emit
// rejections with zero observability: now that a real logging emitter is
// wired, an append failure is at least visible in the daemon's own logs.
export async function emitResolveConflictEvent(eventType, fields = {}) {
  if (!RESOLVE_CONFLICT_SWEEP_EVENT_TYPES.includes(eventType)) {
    throw new Error(`unknown resolve-conflict-sweep event type: ${eventType}`);
  }
  const payload = {
    ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    event: eventType,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null || v === "") continue;
    payload[k] = v;
  }
  const line = JSON.stringify(payload) + "\n";
  const logPath = getEventLogPath();
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, line);
    return true;
  } catch (err) {
    log.error({ err: err?.message, eventType }, "emitResolveConflictEvent: append failed (#1461)");
    return false;
  }
}
