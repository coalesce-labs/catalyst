// stale-pr-rescue.mjs — CTL-782 pure decision core for orphaned-CONFLICTING-PR
// rescue. No I/O: the timer (stale-pr-rescue-timer.mjs) gathers inputs and
// executes the returned action. merge-state.mjs Step C deliberately leaves
// DIRTY/BEHIND "out-of-band"; in execution-core this module is that band.

const RESOLVABLE_TYPES = new Set(["content", "add/add"]);

export const DEFAULTS = Object.freeze({
  intervalSeconds: 600,
  stableSeconds: 300,
  behindThreshold: 10,
  maxAttempts: 1,
  maxConflictFiles: 5,
});

// classifyMergeTree — parse `git merge-tree --write-tree <base> <head>` output.
// exit 0 → clean merge possible. exit 1 → parse "CONFLICT (<type>)" lines.
// Anything else (exit >1, unparsable) → NOT resolvable (fail-safe: escalate).
export function classifyMergeTree(
  { exitCode, output },
  { maxConflictFiles = DEFAULTS.maxConflictFiles } = {}
) {
  if (exitCode === 0) {
    return { resolvable: true, conflictFiles: [], conflictTypes: [] };
  }
  if (exitCode !== 1) {
    return { resolvable: false, conflictFiles: [], conflictTypes: [] };
  }

  const conflictFiles = [];
  const conflictTypes = [];
  const lines = (output ?? "").split("\n");

  // CONFLICT (<type>): <desc> in <file>  (most common form)
  // CONFLICT (<type>): <file> deleted in <side>  (modify/delete)
  const re = /^CONFLICT \(([^)]+)\)/;
  const fileRe = /\bin ([^\s].+)$/;

  for (const line of lines) {
    const m = re.exec(line);
    if (!m) continue;
    const type = m[1];
    conflictTypes.push(type);
    const fm = fileRe.exec(line);
    if (fm) conflictFiles.push(fm[1].trim());
  }

  const hasUnresolvable = conflictTypes.some((t) => !RESOLVABLE_TYPES.has(t));
  if (hasUnresolvable) {
    return { resolvable: false, conflictFiles, conflictTypes };
  }
  if (conflictFiles.length > maxConflictFiles) {
    return { resolvable: false, conflictFiles, conflictTypes };
  }

  return { resolvable: true, conflictFiles, conflictTypes };
}

// isTriggered — true when the ticket's PR needs a rescue attempt.
// DIRTY always triggers; BEHIND only past the threshold.
function isTriggered(mergeStateStatus, behindBy, threshold) {
  if (mergeStateStatus === "DIRTY") return true;
  if (mergeStateStatus === "BEHIND" && behindBy > threshold) return true;
  return false;
}

// decideRescue — the full decision matrix (see test file for the spec).
// Order: skip-guards (live job / merged / not-triggered / already-escalated)
// → worktree gate → stability window (wait) → budget gate → classification gate
// → dispatch | escalate.
//
// Returns { action: 'skip'|'wait'|'dispatch'|'escalate', reason, detail }
// The timer owns all impure side-effects (timestamp writes, labelOnce, etc.).
export function decideRescue(inputs) {
  const {
    prState,
    mergeStateStatus,
    behindBy,
    anyJobAlive,
    worktreeExists,
    rescueState = {},
    nowMs,
    config = {},
    classification,
  } = inputs;

  const stableSeconds = config.stableSeconds ?? DEFAULTS.stableSeconds;
  const behindThreshold = config.behindThreshold ?? DEFAULTS.behindThreshold;
  const maxAttempts = config.maxAttempts ?? DEFAULTS.maxAttempts;

  // Skip-guards: fast exits before any expensive checks.
  if (anyJobAlive) return { action: "skip", reason: "live_job" };
  if (prState === "MERGED" || prState === "CLOSED") {
    return { action: "skip", reason: "pr_not_open" };
  }
  if (!isTriggered(mergeStateStatus, behindBy, behindThreshold)) {
    return { action: "skip", reason: "not_triggered" };
  }
  if (rescueState.escalatedAt) {
    return { action: "skip", reason: "already_escalated" };
  }

  // Worktree gate: dispatch hard-fails on a missing worktree.
  if (!worktreeExists) {
    return { action: "escalate", reason: "worktree_missing", detail: { behindBy } };
  }

  // Budget gate: if we already dispatched the maximum attempts, escalate
  // without re-waiting for the stability window (we know it passed before).
  const attempts = rescueState.rescueAttempts ?? 0;
  if (attempts >= maxAttempts) {
    return {
      action: "escalate",
      reason: "rescue_budget_exhausted",
      detail: { attempts, behindBy },
    };
  }

  // Stability window: wait for firstSeenAt + stableSeconds before first dispatch.
  if (!rescueState.firstSeenAt) {
    return { action: "wait", reason: "first_sighting", detail: { stampFirstSeen: true } };
  }
  const seenMs = new Date(rescueState.firstSeenAt).getTime();
  const elapsedMs = nowMs - seenMs;
  if (elapsedMs < stableSeconds * 1000) {
    return { action: "wait", reason: "stability_window" };
  }

  // BEHIND rescue: no conflict classification needed.
  if (mergeStateStatus === "BEHIND") {
    return { action: "dispatch", reason: "behind_threshold_exceeded", detail: { behindBy } };
  }

  // DIRTY: need a classification result.
  if (!classification) {
    return { action: "escalate", reason: "unclassified_dirty", detail: { behindBy } };
  }
  if (!classification.resolvable) {
    return {
      action: "escalate",
      reason: "unresolvable_conflicts",
      detail: {
        conflictFiles: classification.conflictFiles,
        conflictTypes: classification.conflictTypes,
        behindBy,
      },
    };
  }

  return {
    action: "dispatch",
    reason: "resolvable_dirty",
    detail: {
      conflictFiles: classification.conflictFiles,
      conflictTypes: classification.conflictTypes,
      behindBy,
    },
  };
}
