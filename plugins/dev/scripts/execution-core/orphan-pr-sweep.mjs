// orphan-pr-sweep.mjs — CTL-1175 pure decision core for orphan-PR detect+notify.
// No I/O: the timer (orphan-pr-sweep-timer.mjs) lists PRs, filters worker-tracked
// ones, persists state, and emits events. Twin of stale-pr-rescue.mjs.
//
// "Orphan" = an open PR with no pipeline worker tracking it. This module decides,
// per orphan, whether to STAMP a first-seen, WAIT out the stable window, NOTIFY
// (raise the Needs-You row), or SKIP. NOTIFY ONLY — never merge/adopt/rebase.

export const DEFAULTS = Object.freeze({
  intervalSeconds: 600,
  stableSeconds: 300,
});

// Blocker set mirrors orch-monitor board-data.mjs PR_BLOCKER_STATES
// {DIRTY,BLOCKED,UNSTABLE}. These two constants are independent twins (same
// rationale as the two stableSeconds=300 implementations, research F "stableSeconds
// — Two independent implementations"): the board and execution-core are separate
// packages and cannot share a constant without a cross-package import. BLOCKED +
// UNSTABLE ARE the CI-red states the ticket's "feed mergeStateStatus" sub-task asks
// for — orphan CI-red triggers a row; BEHIND deliberately does not (a behind PR
// needs a rebase, not a human).
const BLOCKER_STATES = new Set(["DIRTY", "BLOCKED", "UNSTABLE"]);

export function isOrphanBlocked(mergeStateStatus) {
  return BLOCKER_STATES.has(mergeStateStatus);
}

// decideOrphanNotify — the per-orphan state machine.
//   entry: the persisted orphan-prs.json record for this PR, or null on first sight.
//   Returns { action: 'skip'|'stamp'|'wait'|'notify', reason }.
// The timer owns all side-effects (stamping firstSeenAt, setting notifiedAt, emit).
export function decideOrphanNotify({ mergeStateStatus, isDraft, entry, nowMs, stableSeconds = DEFAULTS.stableSeconds }) {
  if (!isOrphanBlocked(mergeStateStatus)) return { action: "skip", reason: "not_blocked" };
  if (isDraft) return { action: "skip", reason: "draft" };

  if (!entry?.firstSeenAt) return { action: "stamp", reason: "first_sighting" };
  if (entry.notifiedAt) return { action: "skip", reason: "already_notified" };

  const seenMs = new Date(entry.firstSeenAt).getTime();
  if (Number.isNaN(seenMs)) return { action: "stamp", reason: "restamp_unparsable" };
  if (nowMs - seenMs < stableSeconds * 1000) return { action: "wait", reason: "stability_window" };

  return { action: "notify", reason: "blocker_stable" };
}
