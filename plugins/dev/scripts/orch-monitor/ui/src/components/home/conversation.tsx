// conversation.tsx — the inbox as a CONVERSATION surface (CTL-1569).
//
// Three stacked sections inside the reading pane, in the operator's order of need:
//
//   1. WHAT THIS NEEDS FROM YOU — the ask summary: a kind chip, the plain-language
//      summary, the loud "can I just reply?" line, and one-click suggested replies
//      that PREFILL the box (still editable — a chip is a shortcut, not a submit).
//   2. THE REPLY BOX — posts a real Linear comment authored as the operator. That
//      post IS the resolution mechanism (CTL-1567 clears `needs-human` on a human
//      comment within seconds), so this is the payoff of the whole surface.
//   3. THE THREAD — the last few comments, NEWEST FIRST, agent and human visibly
//      distinct, long bodies clamped with expand-in-place.
//
// ── the honesty contract ─────────────────────────────────────────────────────
// The operator's typed words are never lost. On a failed post the draft STAYS in
// the box, the row is NOT cleared, and the specific reason is shown — including the
// one failure that would otherwise be invisible: a monitor authenticated as the
// Catalyst app can't post a comment that would clear the ask, and the server
// refuses BEFORE posting rather than faking success.
//
// Optimistic clear (§4: "the row disappears on post") is reported UPWARD via
// `onReplied` rather than owned here, so the surface's existing optimistic-mark +
// grace-window rollback machinery (respond-client.ts::reconcileMarks) stays the one
// place that decides when a row truly leaves the inbox.
//
// NO FETCH LIVES HERE: every network call goes through board/conversation-client.ts
// (the home tree's no-fetch invariant).
import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink as ExternalLinkIcon, Send } from "lucide-react";

import {
  fetchConversation,
  postReply,
  type ConversationAsk,
  type ConversationResponse,
  type ReplyOutcome,
  type ThreadComment,
} from "@/board/conversation-client";
import { askPresentation, inferredNote, type AskAccent } from "@/board/inbox-ask-model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

// ── fetch-on-select ──────────────────────────────────────────────────────────

type ConversationState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; conversation: ConversationResponse }
  | { kind: "error" };

/** Load the conversation when a row is selected. `reloadKey` is bumped after a
 *  successful post so the operator sees their own comment land at the top of the
 *  thread — the turn they just took, reflected immediately. */
function useConversation(ticket: string | undefined, enabled: boolean, reloadKey: number) {
  const [state, setState] = useState<ConversationState>({ kind: "idle" });
  useEffect(() => {
    if (!enabled || !ticket) {
      setState({ kind: "idle" });
      return;
    }
    let alive = true;
    setState((prev) => (prev.kind === "loaded" ? prev : { kind: "loading" }));
    void (async () => {
      const result = await fetchConversation(ticket);
      if (!alive) return;
      setState(result.ok ? { kind: "loaded", conversation: result.conversation } : { kind: "error" });
    })();
    return () => {
      alive = false;
    };
  }, [ticket, enabled, reloadKey]);
  return state;
}

// ── the ask summary (§1) ─────────────────────────────────────────────────────

function askChipClasses(accent: AskAccent): string {
  switch (accent) {
    case "red":
      return "border-red/40 bg-red/10 text-red";
    case "amber":
      return "border-yellow/40 bg-yellow/10 text-yellow";
    case "neutral":
      return "border-border bg-surface-2 text-muted";
  }
}

function AskSummary({
  ask,
  onUseSuggestion,
}: {
  ask: ConversationAsk;
  onUseSuggestion: (text: string) => void;
}) {
  const presentation = askPresentation(ask.kind);
  const note = inferredNote(ask.source);

  return (
    <section className="mt-5" data-conversation-ask data-ask-kind={ask.kind}>
      <div className="flex items-center gap-2">
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
          What this needs from you
        </p>
        <Badge
          variant="outline"
          data-ask-chip={ask.kind}
          className={cn("shrink-0 text-[10px] font-medium", askChipClasses(presentation.accent))}
        >
          {presentation.label}
        </Badge>
      </div>

      {/* The plain-language ask — the bright line. */}
      <p className="mt-2 text-[14px] leading-snug text-fg" data-ask-summary>
        {ask.summary}
      </p>

      {/* The loud signal: reply alone, or go do something first. Given its own
          line (not just the chip tint) because mistaking it costs a round trip. */}
      <p
        data-ask-resolution
        data-requires-action={presentation.requiresAction ? "true" : undefined}
        className={cn(
          "mt-2 text-[12px] leading-snug",
          presentation.requiresAction ? "font-medium text-red" : "text-muted",
        )}
      >
        {presentation.resolutionHint}
      </p>

      {/* One-click suggested replies — they PREFILL the box, never auto-send, so
          the operator can edit before committing (§1). Only ever rendered from
          enumerated producer options; the reader-side classifier never invents one. */}
      {ask.suggestedReplies.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2" data-ask-suggestions>
          {ask.suggestedReplies.map((reply) => (
            <Button
              key={reply}
              type="button"
              size="sm"
              variant="outline"
              data-ask-suggestion={reply}
              onClick={() => onUseSuggestion(reply)}
              title="Put this in the reply box (you can still edit it)"
            >
              {reply}
            </Button>
          ))}
        </div>
      )}

      {/* Mark an inferred ask as inferred — never pass a guess off as the agent's
          own words. */}
      {note != null && (
        <p className="mt-2 text-[11px] italic text-muted/70" data-ask-inferred>
          {note}
        </p>
      )}
    </section>
  );
}

// ── the thread (§2) ──────────────────────────────────────────────────────────

/** Relative time for a comment. Returns null when the replica carried no honest
 *  timestamp, so the UI omits it rather than fabricating one. */
function relativeTime(at: number | null, now: number): string | null {
  if (at == null || !Number.isFinite(at)) return null;
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function ThreadEntry({ comment, now }: { comment: ThreadComment; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const when = relativeTime(comment.at, now);
  const clamped = comment.truncated && !expanded;

  return (
    <li
      className="flex flex-col gap-1 py-2.5"
      data-thread-comment={comment.id}
      data-thread-author={
        comment.isIntegration ? "integration" : comment.isCatalystAgent ? "agent" : "human"
      }
    >
      <div className="flex items-center gap-2">
        {/* Three classes, styled distinctly (§2). The CATALYST AGENT gets the
            accent — it is the one asking. The operator is neutral-bright.
            INTEGRATION plumbing (a GitHub sync notice) is fully muted, because
            styling it as the agent makes automation chatter look like a question
            that needs answering. */}
        <span
          aria-hidden
          className={cn(
            "h-3 w-0.5 shrink-0 rounded-full",
            comment.isCatalystAgent
              ? "bg-accent"
              : comment.isIntegration
                ? "bg-muted/30"
                : "bg-muted/50",
          )}
        />
        <span
          className={cn(
            "text-[11.5px] font-medium",
            comment.isCatalystAgent
              ? "text-accent"
              : comment.isIntegration
                ? "text-muted/70"
                : "text-fg",
          )}
        >
          {comment.authorName}
        </span>
        {comment.isIntegration && (
          <span className="text-[10px] uppercase tracking-wide text-muted/50">automation</span>
        )}
        {when != null && <span className="text-[11px] text-muted/70">{when}</span>}
      </div>

      {/* The body. Rendered as PLAIN TEXT with preserved newlines — the bodies are
          markdown, but half-rendering markdown is a correctness bug whereas a
          literal `**` is merely cosmetic. */}
      <p
        className={cn(
          "whitespace-pre-wrap pl-2.5 text-[12.5px] leading-relaxed text-fg/90",
          clamped && "line-clamp-4",
        )}
      >
        {comment.body}
      </p>

      {comment.truncated && (
        <button
          type="button"
          data-thread-expand={comment.id}
          onClick={() => setExpanded((v) => !v)}
          className="self-start pl-2.5 text-[11px] text-muted underline-offset-2 hover:underline"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </li>
  );
}

function Thread({ comments, now }: { comments: ThreadComment[]; now: number }) {
  if (comments.length === 0) {
    return (
      <p className="mt-2 text-[12px] text-muted/70" data-thread-empty>
        No comments yet.
      </p>
    );
  }
  // Already newest-first from the server (§2) — rendered in the order received.
  return (
    <ul className="mt-1 flex flex-col divide-y divide-border/50" data-thread>
      {comments.map((c) => (
        <ThreadEntry key={c.id} comment={c} now={now} />
      ))}
    </ul>
  );
}

// ── the reply box (§4) ───────────────────────────────────────────────────────

function ReplyBox({
  ticket,
  draft,
  setDraft,
  onReplied,
}: {
  ticket: string;
  draft: string;
  setDraft: (v: string) => void;
  onReplied: (outcome: ReplyOutcome) => void;
}) {
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const send = useCallback(async () => {
    const body = draft.trim();
    if (body === "" || sending) return;
    setSending(true);
    setFailure(null);
    const outcome = await postReply({ ticket, body });
    setSending(false);
    if (outcome.status === "replied") {
      // Clear the box only on a CONFIRMED post; the row's disappearance is the
      // parent's call (it owns the optimistic mark + rollback window).
      setDraft("");
      onReplied(outcome);
      return;
    }
    // Every failure path KEEPS the draft — the operator's words are never lost —
    // and states the specific reason (§4: a failed post must restore the row).
    setFailure(
      outcome.status === "empty"
        ? "Nothing to send."
        : (outcome as { message: string }).message,
    );
    onReplied(outcome);
  }, [draft, sending, ticket, setDraft, onReplied]);

  return (
    <section className="mt-5" data-reply-box={ticket}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Your reply</p>
      <textarea
        data-reply-input={ticket}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter sends; a bare Enter stays a newline so a considered,
          // multi-line answer is never fired off half-written.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void send();
          }
        }}
        rows={3}
        placeholder="Reply to the agent — this posts a comment to Linear as you."
        className={cn(
          "mt-2 w-full resize-y rounded-sm border border-border bg-surface-1 px-3 py-2",
          "text-[13px] leading-relaxed text-fg placeholder:text-muted/60",
          "focus:border-accent focus:outline-none",
        )}
      />
      <div className="mt-2 flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          data-reply-send={ticket}
          disabled={draft.trim() === "" || sending}
          onClick={() => void send()}
        >
          <Send className="size-3.5" />
          {sending ? "Sending…" : "Send reply"}
        </Button>
        <span className="text-[11px] text-muted/70">⌘↵ to send</span>
      </div>

      {failure != null && (
        <p className="mt-2 text-[11.5px] leading-snug text-red" data-reply-failure={ticket}>
          {failure}
        </p>
      )}
    </section>
  );
}

// ── the composed surface ─────────────────────────────────────────────────────

export function Conversation({
  ticket,
  enabled,
  onReplied,
  now = Date.now(),
}: {
  ticket: string;
  /** Only needs-you rows carry a conversation (running/done rows stay calm). */
  enabled: boolean;
  /** Bubble the outcome so the surface can optimistically clear the row on a
   *  confirmed post and leave it in place on every failure. */
  onReplied?: (outcome: ReplyOutcome) => void;
  now?: number;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [draft, setDraft] = useState("");
  const state = useConversation(ticket, enabled, reloadKey);

  // A new selection starts a fresh draft — one operator's half-typed answer must
  // never leak onto a different ticket.
  const lastTicket = useRef(ticket);
  useEffect(() => {
    if (lastTicket.current !== ticket) {
      lastTicket.current = ticket;
      setDraft("");
    }
  }, [ticket]);

  const handleReplied = useCallback(
    (outcome: ReplyOutcome) => {
      // Re-read the thread on success so the operator's own comment appears on top.
      if (outcome.status === "replied") setReloadKey((k) => k + 1);
      onReplied?.(outcome);
    },
    [onReplied],
  );

  if (!enabled) return null;
  if (state.kind !== "loaded") return null; // loading/error → render nothing (fails soft)

  const { conversation } = state;

  return (
    <div data-conversation={ticket}>
      {conversation.ask != null && (
        <AskSummary ask={conversation.ask} onUseSuggestion={setDraft} />
      )}

      {/* The direct link to the ticket (§3). Absent when the issue never resolved
          (a synthesized row) — never a dead link. */}
      {conversation.url != null && (
        <a
          href={conversation.url}
          target="_blank"
          rel="noopener noreferrer"
          data-linear-link={ticket}
          className="mt-3 inline-flex items-center gap-1.5 text-[11.5px] text-muted hover:text-fg"
        >
          Open {ticket} in Linear
          <ExternalLinkIcon className="size-3" />
        </a>
      )}

      {/* The reply box — suppressed entirely for rows with no underlying Linear
          ticket, which have nothing to reply to (§4 / orphan-PR rows). */}
      {conversation.canReply ? (
        <ReplyBox
          ticket={ticket}
          draft={draft}
          setDraft={setDraft}
          onReplied={handleReplied}
        />
      ) : (
        <p className="mt-4 text-[11.5px] text-muted/70" data-no-reply-affordance={ticket}>
          This item has no Linear ticket behind it, so there is nothing to reply to.
        </p>
      )}

      <Separator className="mt-5" />

      {/* The thread. Rendered only when the replica was actually READABLE — an
          unavailable source stays silent rather than claiming "no comments". */}
      {conversation.thread.available && (
        <section className="mt-4" data-conversation-thread>
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
            Conversation
          </p>
          <Thread comments={conversation.thread.comments} now={now} />
        </section>
      )}
    </div>
  );
}
