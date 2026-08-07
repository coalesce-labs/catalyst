// inbox-ask-model.ts — the PRESENTATION model for "what this needs from you"
// (CTL-1569 §1). Pure, React-free, unit-testable: it turns the server's derived ask
// into the exact words and accents the pane renders, so the component stays dumb.
//
// The design rule this file encodes: the operator must be able to answer TWO
// questions at a glance, without reading the thread —
//
//   1. Can I resolve this by replying alone, or must I go DO something first?
//   2. What are the acceptable replies?
//
// (1) is the LOUD signal, because getting it wrong wastes a round trip: the
// operator either types "approve" on something that needed a manual step, or goes
// hunting for work that a bare "yes" would have finished. So the reply-alone bit
// gets its own explicit line, not just a colored chip.

/** The four ask kinds, mirroring the server's `ASK_KINDS`. */
export type AskKind = "approve" | "decide" | "act-then-confirm" | "clarify";

/** How the ask chip is tinted. Amber = a decision is wanted; red = you must act
 *  before this can clear; neutral = an open question. NEVER cyan (reserved for the
 *  live signal), matching the pane's existing accent vocabulary. */
export type AskAccent = "amber" | "red" | "neutral";

export interface AskPresentation {
  /** The short chip label shown at a glance. */
  label: string;
  accent: AskAccent;
  /** The one-line answer to "can I just reply?" — the loud signal. */
  resolutionHint: string;
  /** True when the operator must do something off-platform first. */
  requiresAction: boolean;
}

const PRESENTATION: Record<AskKind, Omit<AskPresentation, "requiresAction">> = {
  approve: {
    label: "Approval",
    accent: "amber",
    resolutionHint: "A yes or no reply is enough to resolve this.",
  },
  decide: {
    label: "Decision",
    accent: "amber",
    resolutionHint: "Choosing one of the options below resolves this.",
  },
  "act-then-confirm": {
    label: "Action, then confirm",
    accent: "red",
    // Deliberately blunt: this is the case a colored chip alone would under-sell.
    // "above" because the summary sits ABOVE this line in the pane — and it is the
    // dominant kind on real parked tickets, where the agent reported a blocker
    // (a dirty tree, a CONFLICTING PR) rather than asking a question.
    resolutionHint:
      "Replying alone will NOT resolve this — do the work described above, then reply to confirm.",
  },
  clarify: {
    label: "Question",
    accent: "neutral",
    resolutionHint: "A written answer resolves this; there is no default.",
  },
};

/** The presentation for an ask kind. Unknown kinds degrade to `clarify` — the
 *  honest default — rather than throwing on a producer that invents a fifth kind. */
export function askPresentation(kind: string): AskPresentation {
  const key = (PRESENTATION[kind as AskKind] ? kind : "clarify") as AskKind;
  return { ...PRESENTATION[key], requiresAction: key === "act-then-confirm" };
}

/** Whether to tell the operator this ask was INFERRED rather than stated by the
 *  agent. A derived ask is a best-effort reading of prose, and quietly presenting
 *  a guess as the agent's own words would be dishonest — so the pane marks it. */
export function isInferredAsk(source: string): boolean {
  return source !== "structured";
}

/** The note shown for an inferred ask (null when producer-authored). */
export function inferredNote(source: string): string | null {
  if (!isInferredAsk(source)) return null;
  return source === "comment"
    ? "Inferred from the agent's last comment."
    : "Inferred from the agent's escalation details.";
}
