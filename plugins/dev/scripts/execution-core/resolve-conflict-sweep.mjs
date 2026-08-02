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
import { isTicketKey } from "./ticket-key.mjs";
import { classifyMergeTree } from "./stale-pr-rescue.mjs";
import { defaultMergeTree } from "./stale-pr-rescue-timer.mjs";

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
