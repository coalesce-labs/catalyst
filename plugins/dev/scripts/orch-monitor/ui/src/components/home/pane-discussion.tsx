// pane-discussion.tsx — the reading pane's Linear DISCUSSION section (CTL-1574).
//
// Split into its own module purely so reading-pane.tsx can React.lazy it. The
// timeline renders comment bodies through renderTicketDescriptionHtml, which
// pulls the whole markdown stack (marked + marked-highlight + highlight.js);
// ticket-description.tsx deliberately lazy-loads for exactly that reason, and a
// static import from the inbox would have put ~21 kB gzip of markdown machinery
// on the home route's critical path for a section that renders below the fold.
//
// Renders NOTHING while loading, when the replica is unreadable, and when the
// ticket genuinely has no discussion — an unavailable source stays silent in the
// inbox rather than adding an error line to a pane whose job is the next action
// (the same fails-soft posture as the Conversation block above it).
import { TicketTimeline } from "../ticket-discussion";
import { useTicketDiscussion } from "@/hooks/use-ticket-discussion";

/** How many of the newest timeline entries the pane shows before "Show all N". */
const COLLAPSED_LIMIT = 5;

export function PaneDiscussion({ ticket }: { ticket: string }) {
  const { comments, activity, createdAt, available, loading } = useTicketDiscussion(ticket);
  if (loading || !available) return null;
  if (comments.length === 0 && activity.length === 0) return null;

  return (
    <section className="mt-6" data-pane-discussion={ticket}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted">
        Discussion
        {/* The pane inverts to newest-first (the next thing to react to sits on
            top); say so, since the ticket page reads chronologically. */}
        <span className="ml-2 font-normal normal-case tracking-normal text-fg-dim">
          newest first
        </span>
      </p>
      <div className="mt-3">
        {/* key: the reading pane keeps ONE instance across inbox selections, so
            without it the previous ticket's "Show all" expansion leaks into the
            next selection (and there is no Show-less to undo it). */}
        <TicketTimeline
          key={ticket}
          comments={comments}
          activity={activity}
          issueCreatedAt={createdAt}
          loaded
          available
          limit={COLLAPSED_LIMIT}
          newestFirst
        />
      </div>
    </section>
  );
}
