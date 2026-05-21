// merge-state.mjs — execution-core Step C merge-confirmation decision (CTL-533).
//
// Pure mirror of the `case "$PR_STATE"` block in orchestrate/SKILL.md
// (the CTL-31/CTL-80/CTL-133/CTL-211/CTL-243/CTL-252 merge-confirmation
// fallback scan). All non-determinism — PR state, merge SHA, deploy config —
// is injected; the function returns a { patch, attention, events } decision
// and never mutates anything.

import { TERMINAL } from "./signal-reader.mjs";

const NO_OP = Object.freeze({ patch: {}, attention: null, events: [] });

// nextMergeState — decide the Step C transition for one worker.
//
// inputs: {
//   ticket, prState:'MERGED'|'CLOSED'|'OPEN'|'UNKNOWN',
//   mergeStateStatus, prNumber, mergedAt (PR.mergedAt from GitHub),
//   mergeCommitSha, signalMergedAt (.pr.mergedAt already on the signal),
//   skipDeployVerification, currentStatus,
// }
// returns: { patch, attention, events }
export function nextMergeState(inputs) {
  // Terminal worker states absorb everything (the bash scan `continue`s on
  // status=failed / status=stalled before touching GitHub).
  if (TERMINAL.has(inputs.currentStatus)) return NO_OP;

  // Already-reconciled merges are a no-op (the bash scan `continue`s when
  // .pr.mergedAt is already set).
  if (inputs.signalMergedAt) return NO_OP;

  switch (inputs.prState) {
    case "MERGED":
      return onMerged(inputs);
    case "CLOSED":
      return {
        patch: {},
        attention: {
          kind: "pr-closed",
          ticket: inputs.ticket,
          message: `PR #${inputs.prNumber} was closed without merging`,
        },
        events: [],
      };
    // OPEN (and any unknown state): not merged yet — normal. DIRTY/BEHIND/
    // BLOCKED merge states are handled out-of-band by the incident handlers,
    // so this step raises nothing for them.
    default:
      return NO_OP;
  }
}

// onMerged — MERGED → done (skipDeployVerification) or → merged (CTL-211).
function onMerged(inputs) {
  const skip = inputs.skipDeployVerification !== false;
  const status = skip ? "done" : "merged";
  const phase = skip ? 6 : 5;

  const patch = {
    status,
    phase,
    pr: {
      ciStatus: "merged",
      mergedAt: inputs.mergedAt ?? null,
    },
  };
  if (inputs.mergeCommitSha) patch.pr.mergeCommitSha = inputs.mergeCommitSha;

  return {
    patch,
    attention: null,
    events: [
      {
        event: "worker-pr-merged",
        worker: inputs.ticket,
        detail: { pr: inputs.prNumber, mergedAt: inputs.mergedAt ?? null },
      },
    ],
  };
}
