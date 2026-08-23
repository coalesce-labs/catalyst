// use-ticket-discussion.ts — fetch a ticket's Linear DISCUSSION (comments +
// issue_history activity) from /api/ticket-discussion/<id> (CTL-1574).
//
// One fetch on mount and on every id change; NO polling. The discussion is a
// reading surface, not a live signal — the operator re-opens the ticket (or
// re-selects the row) to see newer turns, and a poll here would multiply replica
// reads across every open pane for content that changes on human timescales.
//
// Fail-open, mirroring use-linear-ticket.ts: any transport error resolves to
// `available:false` with empty arrays and `loading:false`, so the surface renders
// the honest "unavailable" line instead of hanging on a spinner. `available` is
// carried through from the server so the UI can tell "the replica could not be
// read" from "this ticket genuinely has no discussion" — the two must never render
// the same, or we would be claiming emptiness about a source we never reached.

import { useEffect, useState } from "react";
import type {
  TicketActivityEvent,
  TicketComment,
  TicketDiscussion,
} from "../../../lib/ticket-discussion-reader.mjs";

export type { TicketActivityEvent, TicketComment };

export interface TicketDiscussionState {
  /** false when the replica could not be read OR the ticket is not mirrored. */
  available: boolean;
  comments: TicketComment[];
  activity: TicketActivityEvent[];
  /** Issue creation instant (ms epoch) — gates the "created this issue" label. */
  createdAt: number | null;
  loading: boolean;
  /** The transport/read failure reason, or null. */
  error: string | null;
}

const IDLE: TicketDiscussionState = {
  available: false,
  comments: [],
  activity: [],
  createdAt: null,
  loading: false,
  error: null,
};

export function useTicketDiscussion(id: string | undefined): TicketDiscussionState {
  const [state, setState] = useState<TicketDiscussionState>(
    id ? { ...IDLE, loading: true } : IDLE,
  );

  useEffect(() => {
    if (!id) {
      setState(IDLE);
      return;
    }
    // `stop` guards against a late response for a ticket we have navigated away
    // from overwriting the current selection's state (the same cleanup idiom as
    // useLinearTicket).
    let stop = false;
    setState({ ...IDLE, loading: true });
    fetch(`/api/ticket-discussion/${encodeURIComponent(id)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as TicketDiscussion;
      })
      .then((body) => {
        if (stop) return;
        setState({
          available: Boolean(body?.available),
          comments: Array.isArray(body?.comments) ? body.comments : [],
          activity: Array.isArray(body?.activity) ? body.activity : [],
          createdAt: typeof body?.createdAt === "number" ? body.createdAt : null,
          loading: false,
          error: null,
        });
      })
      .catch((e: unknown) => {
        if (stop) return;
        setState({
          ...IDLE,
          error: e instanceof Error ? e.message : String(e),
        });
      });
    return () => {
      stop = true;
    };
  }, [id]);

  return state;
}
