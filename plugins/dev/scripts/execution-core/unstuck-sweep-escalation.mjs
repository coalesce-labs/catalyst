// unstuck-sweep-escalation.mjs — CTL-1064 Phase 6 escalation write-up author.
//
// Both exports are PURE (no IO, no imports beyond constants).
// authorEscalationComment: replaces tautological "needs a human" copy with a
// causal write-up naming the single decision the human must make.
// summarizeRemediateCapHistory: turns verify⇄remediate round-trips into a
// per-round disagreement summary + a single decision sentence.

// authorEscalationComment — pure. Dispatches on evidence.reason to produce a
// causal, human-readable escalation comment.
// evidence shape mirrors captureDeepDiveEvidence's output plus
//   commitsAhead    number   (runtime-detected commits ahead of origin/main)
//   reason          string   (the stalledReason / category)
//   ticket          string
//   phase           string
export function authorEscalationComment(evidence = {}) {
  const { ticket, phase, reason, commitsAhead, porcelainLines, prState, remediateHistory } = evidence;

  const ticketId = ticket ?? "?";
  const phaseStr = phase ?? "?";

  // Empty-branch (runtime detection: commitsAhead.length === 0 or commitsAhead === 0).
  // Never hardcoded to a specific stalledReason string.
  const ahead = typeof commitsAhead === "number"
    ? commitsAhead
    : (Array.isArray(commitsAhead) ? commitsAhead.length : null);
  if (ahead === 0) {
    return [
      `**${ticketId} / ${phaseStr} — escalated: empty branch**`,
      "",
      "The branch is 0 commits ahead of `origin/main`. No implementation work was committed.",
      "This requires a human decision: the sweep cannot safely seed or close the branch.",
      "",
      "**Decision required:** Should this ticket be closed (no work to ship), or should the",
      "branch be seeded with an initial commit to retry the implement phase?",
    ].join("\n");
  }

  // dirty-tree with non-noise porcelain
  if (reason === "rebase_refused_dirty_tree" && Array.isArray(porcelainLines) && porcelainLines.length > 0) {
    const fileList = porcelainLines.slice(0, 10).map((l) => `  ${l}`).join("\n");
    const more = porcelainLines.length > 10 ? `\n  … (${porcelainLines.length - 10} more)` : "";
    return [
      `**${ticketId} / ${phaseStr} — escalated: real worktree dirt prevents auto-clear**`,
      "",
      "The rebase was refused because the worktree has non-noise modified files that",
      "the auto-clear sweep cannot safely discard:",
      "",
      fileList + more,
      "",
      "**Decision required:** Review the above files. If they are safe to discard or",
      "stage, resolve the conflict manually and re-dispatch the phase.",
    ].join("\n");
  }

  // source-conflict (force-push safety gate failed)
  if (reason === "source_conflict_ctl708_unavailable") {
    const prInfo = prState ? ` (PR state: ${prState})` : "";
    return [
      `**${ticketId} / ${phaseStr} — escalated: force-push safety gate failed**`,
      "",
      `The branch has a \`source_conflict_ctl708_unavailable\` stall${prInfo}.`,
      "The auto-push sweep requires: empty noise-filtered porcelain, ticket-only commits,",
      "and HEAD as a strict descendant of origin/main. One or more gates failed.",
      "",
      "**Decision required:** Confirm whether the worktree's rebase is safe to force-push.",
      "If yes, run: `git -C <worktree> push --force-with-lease` and re-dispatch.",
    ].join("\n");
  }

  // remediate-cap
  if (reason === "remediate-cycle-cap-exhausted") {
    const historySummary = Array.isArray(remediateHistory) && remediateHistory.length > 0
      ? summarizeRemediateCapHistory(ticketId, remediateHistory)
      : "_No remediate history available._";
    return [
      `**${ticketId} / ${phaseStr} — escalated: verify/remediate cap exhausted**`,
      "",
      "The verify→remediate cycle reached the iteration cap without reaching a passing",
      "verify verdict. Round-by-round summary:",
      "",
      historySummary,
      "",
      "**Decision required:** Review the above disagreements and decide whether to extend",
      "the remediate cap, manually fix the failing checks, or close the ticket.",
    ].join("\n");
  }

  // generic / unknown — not mechanically resolvable
  const reasonStr = reason ? ` (reason: \`${reason}\`)` : "";
  return [
    `**${ticketId} / ${phaseStr} — escalated: not mechanically resolvable**`,
    "",
    `This ticket is stalled${reasonStr} and is outside the auto-unstuck whitelist.`,
    "The sweep cannot safely resolve this automatically.",
    "",
    "Evidence summary:",
    `- Stall reason: \`${reason ?? "unknown"}\``,
    `- Phase: \`${phaseStr}\``,
    `- PR state: ${prState ?? "unknown"}`,
    "",
    "**Decision required:** Investigate the above and manually clear or reassign.",
  ].join("\n");
}

// summarizeRemediateCapHistory — pure. Turns a list of remediate round objects
// into a human-readable per-round summary + a single decision sentence.
// Returns "" for empty history.
// history items shape: { round, verifyFindings, remediateChanges, reVerifyResult }
export function summarizeRemediateCapHistory(ticket, history) {
  if (!Array.isArray(history) || history.length === 0) return "";

  const lines = [];
  for (const item of history) {
    const round = item?.round ?? "?";
    const findings = item?.verifyFindings ?? "findings unavailable";
    const changes = item?.remediateChanges ?? "changes unavailable";
    const reResult = item?.reVerifyResult ?? "result unavailable";
    lines.push(
      `**Round ${round}:** verify found: ${findings}; remediate changed: ${changes}; re-verify: ${reResult}`
    );
  }

  lines.push(
    `\n**Single decision for ${ticket}:** Review the above round disagreements and`,
    "determine whether the failing checks are correct or the remediate approach was wrong."
  );

  return lines.join("\n");
}
