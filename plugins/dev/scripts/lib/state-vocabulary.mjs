// state-vocabulary.mjs — CTL-1871 COORD-41: canonical plain-language glossary for
// every Catalyst-internal term that may appear in a human-facing status renderer.
//
// WHY THIS EXISTS. Every stuck / needs-human / abandoned state must render three
// things in plain words: what happens next, who acts, and what happens if nobody
// acts ("if no one acts" / default_if_silent). Without a single source of truth each
// renderer invents its own wording — and the "who" distinction between needs-human
// (operator) vs needs-input (user) has been wrong or absent in five places at once.
//
// DESIGN. A frozen map term → gloss object, exported as `glossFor(term)`. Unknown
// terms return a safe degraded gloss rather than throwing (the consumer always gets
// something renderable). Zero imports: the same module is safe to load from bare Node,
// bun, the orch-monitor mjs layer, and the UI TypeScript stack via its .d.ts sidecar.
//
// ADDING A TERM. Append to VOCABULARY below. Tests enforce: every term has a
// non-empty plainLabel, whatsNext, who, and ifNobody; needs-human and needs-input
// differ on `who`; awaiting-work is disambiguated from the CTL-615/702 tombstone yield.

/** @typedef {{ term: string, plainLabel: string, whatsNext: string, who: string, ifNobody: string }} Gloss */

/** @type {ReadonlyMap<string, Gloss>} */
const VOCABULARY = Object.freeze(
  new Map([
    [
      "needs-human",
      {
        term: "needs-human",
        plainLabel: "Needs your decision",
        whatsNext: "An operator must review and take action before work can continue.",
        who: "Operator (you)",
        ifNobody: "This ticket stays blocked until an operator responds. No automated action is taken.",
      },
    ],
    [
      "needs-input",
      {
        term: "needs-input",
        plainLabel: "Waiting for your reply",
        whatsNext: "The agent paused and asked a question. Reply in the ticket to unblock it.",
        who: "Ticket author / assignee",
        ifNobody: "Work stays paused until someone replies in the ticket thread.",
      },
    ],
    [
      "stalled",
      {
        term: "stalled",
        plainLabel: "Gave up — needs reset",
        whatsNext: "The agent exhausted its retry budget and stopped. An operator must decide whether to retry or close the ticket.",
        who: "Operator (you)",
        ifNobody: "The ticket remains stalled indefinitely. No automated retry will occur.",
      },
    ],
    [
      "aborted",
      {
        term: "aborted",
        plainLabel: "Cancelled",
        whatsNext: "Work was intentionally stopped. No further action is expected unless the ticket is re-opened.",
        who: "No one — resolved",
        ifNobody: "Nothing happens. The ticket stays cancelled.",
      },
    ],
    [
      "awaiting-work",
      {
        term: "awaiting-work",
        // Disambiguate from the CTL-615/702 tombstone "yield" (a duplicate-worker bow-out).
        // This is the CTL-1854 bounded wait — the agent delegated to a background job and
        // declared a 30-minute deadline. The deadline expires to `failed/abandoned`, never to
        // a redispatch; the worker must declare before stopping, not stop and hope to be resumed.
        plainLabel: "Waiting on background work (bounded)",
        whatsNext: "The agent is waiting up to 30 minutes for a background job it started. It will resume automatically when the job completes or the deadline passes.",
        who: "No one — automated",
        ifNobody: "The agent's deadline expires and the phase is recorded as abandoned. An operator can then re-triage.",
      },
    ],
    [
      "preempted",
      {
        term: "preempted",
        plainLabel: "Taken over by another worker",
        whatsNext: "A higher-priority or reclaim worker has taken ownership of this ticket. The preempted session bowed out.",
        who: "No one — automated",
        ifNobody: "The reclaiming worker continues automatically.",
      },
    ],
    [
      "turn-cap-exhausted",
      {
        term: "turn-cap-exhausted",
        plainLabel: "Hit turn limit — needs continuation",
        whatsNext: "The agent reached its per-session turn cap. A continuation worker will be dispatched automatically.",
        who: "No one — automated (continuation dispatched)",
        ifNobody: "If continuation dispatch fails, the ticket enters needs-human for an operator to re-triage.",
      },
    ],
    [
      "reclaim",
      {
        term: "reclaim",
        plainLabel: "Reclaimed from a dead worker",
        whatsNext: "The scheduler detected that the previous worker stopped without finishing and assigned a new worker.",
        who: "No one — automated",
        ifNobody: "The scheduler will continue to attempt reclaims on future ticks.",
      },
    ],
    [
      "revive",
      {
        term: "revive",
        plainLabel: "Resumed after stall",
        whatsNext: "A stalled or abandoned phase is being retried with a fresh worker.",
        who: "No one — automated",
        ifNobody: "If the revive budget is exhausted, the ticket enters needs-human.",
      },
    ],
    [
      "orphan",
      {
        term: "orphan",
        plainLabel: "Left behind by its orchestrator",
        whatsNext: "The worker was running but its orchestrator is gone. The orphan reaper will clean it up.",
        who: "No one — automated (reaper)",
        ifNobody: "The orphan reaper removes the stale state on its next pass.",
      },
    ],
    [
      "reap",
      {
        term: "reap",
        plainLabel: "Background job being stopped",
        whatsNext: "The daemon is sending a stop signal to the background job and cleaning up its worktree.",
        who: "No one — automated",
        ifNobody: "The reaper retries on the next cycle if the job does not stop.",
      },
    ],
    [
      "dispatch",
      {
        term: "dispatch",
        plainLabel: "Launching worker",
        whatsNext: "The scheduler is starting a new background agent for this phase.",
        who: "No one — automated",
        ifNobody: "If dispatch fails, the scheduler retries or escalates after the circuit-breaker threshold.",
      },
    ],
    [
      "advance",
      {
        term: "advance",
        plainLabel: "Moving to next phase",
        whatsNext: "This phase is complete; the pipeline is transitioning to the next one.",
        who: "No one — automated",
        ifNobody: "Nothing — advance is a momentary transition, not a waiting state.",
      },
    ],
    [
      "signal",
      {
        term: "signal",
        plainLabel: "Phase status file",
        whatsNext: "A disk record tracking this phase's progress. Normally invisible; present here because the orchestrator is inspecting it.",
        who: "No one — internal",
        ifNobody: "Nothing — signal files are internal bookkeeping.",
      },
    ],
    // Pipeline phases — each carries a standard who/ifNobody since the human
    // only intervenes at escalation; the normal path is fully automated.
    ...["triage", "research", "plan", "implement", "verify", "review", "pr", "monitor-merge", "monitor-deploy", "teardown"].map(
      (phase) => [
        phase,
        {
          term: phase,
          plainLabel: `Phase: ${phase}`,
          whatsNext: `A background agent is running the ${phase} phase. No action needed unless it escalates.`,
          who: "No one — automated",
          ifNobody: "Nothing — this phase runs automatically. If it fails, the scheduler will escalate.",
        },
      ]
    ),
  ])
);

export const VOCABULARY_TERMS = Object.freeze([...VOCABULARY.keys()]);

/** The gloss for an unknown term — always renderable, never throws. */
const UNKNOWN_GLOSS = (term) => ({
  term,
  plainLabel: term,
  whatsNext: "Unknown state — check the ticket.",
  who: "Unknown",
  ifNobody: "No automated action is defined for this state.",
});

/**
 * Returns the plain-language gloss for a Catalyst internal term.
 * Unknown terms return a safe degraded gloss rather than throwing.
 *
 * @param {string} term
 * @returns {Gloss}
 */
export function glossFor(term) {
  return VOCABULARY.get(term) ?? UNKNOWN_GLOSS(term);
}
