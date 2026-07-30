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

/** Is this body a content-free escalation pointer ("…(See your inbox.)")? */
export function isEscalationNotice(body: unknown): boolean;

/** Pick the agent comment that best carries the ask, from a NEWEST-FIRST list. */
export function pickAskComment(agentComments: unknown): string | null;

export function deriveAsk(args?: {
  explanation?: unknown;
  /** NEWEST-FIRST agent comment bodies, so notice-skipping can apply. */
  agentComments?: readonly string[] | null;
  lastAgentComment?: string | null;
}): InboxAsk | null;
