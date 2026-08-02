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

import { readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { isTicketKey } from "./ticket-key.mjs";
import { classifyMergeTree } from "./stale-pr-rescue.mjs";
import { defaultMergeTree } from "./stale-pr-rescue-timer.mjs";

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
//   cycleCount            — countResolveConflictCycles({ticket}) — event-counted, durable
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

// classifyLiveConflict — re-run git merge-tree against the LIVE worktree (never
// trust stale census evidence — mirrors sourceConflictActSeam's own re-check
// discipline in unstuck-act-seams.mjs) and classify with the existing,
// UNMODIFIED classifyMergeTree. Returns null (not a classification) on any
// probe failure or missing worktree — the caller's classifier then reads that
// as "classification-unavailable" and retries next tick; it never guesses.
export async function classifyLiveConflict({ worktreePath, base, head }, { mergeTree = defaultMergeTree } = {}) {
  if (!worktreePath) return null;
  try {
    const mt = await mergeTree(worktreePath, base, head);
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
// this to the /catalyst-dev:resolve-conflict skill) — distinct from the STALLED
// phase (`phase` param below, e.g. "implement"), whose own signal file is the one
// markStalledSignalResolving rewrites.
const RESOLVE_CONFLICT_DISPATCH_PHASE = "resolve-conflict";

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
