// Type declarations for inbox-ask.mjs (CTL-1569 §1) — "what this needs from you",
// derived. Lets the strict TS server and the .ts test files import it without a
// TS7016 implicit-any error. Keep in sync with inbox-ask.mjs.

/** The four ask kinds (CTL-1569 §1 table). */
export type AskKind = "approve" | "decide" | "act-then-confirm" | "clarify";

/** Where a derived ask came from. `structured` is producer-authored; the other two
 *  are reader-side derivations the UI marks as inferred. */
export type AskSource = "structured" | "explanation" | "comment";

export interface InboxAsk {
  kind: AskKind;
  summary: string;
  /** Only ever populated from ENUMERATED producer options or an explicit producer
   *  list — the text classifier never invents a chip. */
  suggestedReplies: string[];
  /** THE bit the operator cares about, always DERIVED from `kind` so the two can
   *  never disagree: false for `act-then-confirm`, true for the other three. */
  canResolveByReply: boolean;
  source: AskSource;
}

export const ASK_KINDS: readonly AskKind[];

export function classifyAskText(text: unknown): AskKind;

export function condenseSummary(text: unknown, max?: number): string | null;

export function askFromStructured(explanation: unknown): InboxAsk | null;

export function askFromExplanation(explanation: unknown): InboxAsk | null;

export function askFromComment(commentBody: unknown): InboxAsk | null;

/** What an agent comment is, as an ask candidate. `blocker` = a named failure with
 *  no question attached (→ `act-then-confirm`); `status` = the pass reporting, not
 *  asking; `none` = nothing left once producer boilerplate is stripped. */
export type AskCandidateClass = "ask" | "blocker" | "status" | "none";

export interface AskCandidate {
  class: AskCandidateClass;
  /** The informative residue to summarize; null for `status` / `none`. */
  text: string | null;
}

export const ASK_CANDIDATE_CLASSES: readonly AskCandidateClass[];

/** Producer boilerplate removed; null when nothing informative is left. */
export function stripEscalationBoilerplate(body: unknown): string | null;

/** Is this the recovery pass REPORTING (✅/🔧/leave-alone verdict) rather than
 *  asking? The `needs-human VALID` verdict is excluded — it names a blocker. */
export function isRecoveryStatusNote(body: unknown): boolean;

/** The paragraph stating an explicit operator requirement, or null. */
export function extractOperatorActionBlock(body: unknown): string | null;

export function classifyAskCandidate(body: unknown): AskCandidate;

export function askFromCandidate(candidate: AskCandidate | null | undefined): InboxAsk | null;

/** Does this body state a request, beyond announcing that one exists? */
export function hasSubstantiveAsk(body: unknown): boolean;

/** Is this body a status report, a pass verdict, or a content-free pointer — i.e.
 *  unusable as an ask? */
export function isEscalationNotice(body: unknown): boolean;

/** Is this body a per-phase status report ("**Phase Implement** · Commits: 7")? */
export function isPhaseStatusReport(body: unknown): boolean;

/** The best ask candidate from a NEWEST-FIRST list: newest `ask`, else newest
 *  `blocker`, else null. Never falls back to the newest body. */
export function pickAskCandidate(agentComments: unknown): AskCandidate | null;

/** The BODY TEXT of the best ask candidate (the residue), or null. */
export function pickAskComment(agentComments: unknown): string | null;

export function deriveAsk(args?: {
  explanation?: unknown;
  /** NEWEST-FIRST agent comment bodies, so notice-skipping can apply. */
  agentComments?: readonly string[] | null;
  lastAgentComment?: string | null;
}): InboxAsk | null;
