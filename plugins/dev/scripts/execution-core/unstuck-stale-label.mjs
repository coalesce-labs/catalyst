// unstuck-stale-label.mjs — CTL-1064 Category D pure classifier.
//
// Classifies a terminal (Canceled/Duplicate/Done) ticket that still carries an
// attention label (needs-human / blocked / waiting) as 'clear-label'. Uses
// gateway.listLabeledTickets (NOT listStartedTickets, which excludes terminal
// tickets — the documented enumeration gap). The act seam delegates to
// clearStalledLabel (label-guard.mjs:124), which removes the Linear label AND
// deletes both .linear-label-<label>.applied/.skipped markers together —
// closing the suppression trap.

// ATTENTION_LABELS — the three attention labels the sweep can clear from
// terminal tickets. Keep in sync with deriveAttention (orch-monitor/board-data.mjs).
export const ATTENTION_LABELS = Object.freeze(["needs-human", "blocked", "waiting"]);

// TERMINAL_LINEAR_STATES — ticket states in which stale labels should be cleared.
export const TERMINAL_LINEAR_STATES = Object.freeze(["Canceled", "Duplicate", "Done"]);

// classifyTerminalStaleLabel — PURE. No IO.
// evidence shape:
//   linearState    string|null    (Linear state name)
//   attentionLabels string[]      (labels currently on the ticket)
//   ticket         string
//
// Returns:
//   { action: 'clear-label', label } — terminal state + attention label found
//   { action: 'skip', reason }       — not terminal, no label, unknown state
export function classifyTerminalStaleLabel(evidence = {}) {
  const { linearState, attentionLabels } = evidence;

  // Fail-closed: null/unknown state → skip (we must be certain the ticket is terminal).
  if (!linearState || !TERMINAL_LINEAR_STATES.includes(linearState)) {
    return { action: "skip", reason: "not-terminal" };
  }

  // Find the first attention label on this ticket.
  if (!Array.isArray(attentionLabels) || attentionLabels.length === 0) {
    return { action: "skip", reason: "no-attention-label" };
  }
  const label = attentionLabels.find((l) => ATTENTION_LABELS.includes(l));
  if (!label) {
    return { action: "skip", reason: "no-attention-label" };
  }

  return { action: "clear-label", label };
}

// collectTerminalStaleLabelCandidates — census with injected Linear seams.
// Queries attention-labeled tickets directly (NOT listStartedTickets).
// Expands multi-label tickets into one candidate per attention label.
// Per-candidate catch: a seam throw on one ticket does not abort the rest.
export function collectTerminalStaleLabelCandidates({
  listLabeledTickets = () => [],  // () → [{ticket, labels:string[], linearState:string|null}]
  resolveLinearState = null,      // optional: (ticket) → string|null (override if not in struct)
} = {}) {
  const out = [];
  let labeled;
  try {
    labeled = listLabeledTickets() ?? [];
  } catch {
    return out;
  }

  for (const item of labeled) {
    try {
      const ticket = item.ticket ?? item.id ?? item.identifier;
      if (!ticket) continue;

      const labels = Array.isArray(item.labels) ? item.labels : [];
      const linearState = item.linearState ?? (resolveLinearState ? resolveLinearState(ticket) : null);

      // Expand into one candidate per attention label.
      for (const label of labels) {
        if (!ATTENTION_LABELS.includes(label)) continue;
        out.push({
          ticket,
          phase: "none",    // stale labels are not phase-specific
          isStaleLabel: true,
          evidence: {
            ticket,
            phase: "none",
            linearState,
            attentionLabels: [label], // one label per candidate (expanded)
            liveSessionInWorktree: false,
            linearTerminal: TERMINAL_LINEAR_STATES.includes(linearState),
          },
        });
      }
    } catch {
      // per-candidate error: skip, no throw
    }
  }
  return out;
}
