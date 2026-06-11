// use-linear-ticket.ts — the LIGHT fetch hook for the ticket's REAL Linear
// {title, description} from /api/linear-ticket/<id> (the CTL-974 cached, fail-
// open server fetch). Kept SEPARATE from ticket-description.tsx so the route can
// import the hook (chrome title + body share one fetch) WITHOUT statically
// pulling in the heavy markdown engine (marked-highlight + highlight.js). The
// heavy <TicketDescription> renderer is lazy-loaded on the ticket route only, so
// the markdown stack code-splits out of the board entry chunk (deliverable §3).
//
// The board ticket carries a STALE-sourced title (triage summary can win) and NO
// description; both are resolved here. Fail-open: any error → { null, null,
// loaded:true } so the caller falls back to the board title and the body shows
// the honest-empty description — never a spinner that hangs.

import { useEffect, useState } from "react";

/** A single Linear label. */
export interface LinearLabel {
  name: string;
  color: string;
}

/** Relations grouped by direction and type. */
export interface LinearRelations {
  blockedBy: string[];
  blocks: string[];
  related: string[];
  duplicateOf: string[];
}

/** /api/linear-ticket/<id> response shape (server.ts). */
interface LinearTicketResponse {
  id: string;
  title: string | null;
  description: string | null;
  labels: LinearLabel[] | null;
  relations: LinearRelations | null;
  source: "linear-live" | "unavailable";
}

export interface LinearTicketState {
  title: string | null;
  description: string | null;
  labels: LinearLabel[] | null;
  relations: LinearRelations | null;
  loaded: boolean;
}

const NULL_STATE: LinearTicketState = {
  title: null,
  description: null,
  labels: null,
  relations: null,
  loaded: true,
};

/** Fetch the ticket's REAL Linear {title, description, labels, relations}.
 *  Cleanup via a `stop` flag (mirrors useTicketArtifacts in ticket-detail-page.tsx). */
export function useLinearTicket(id: string): LinearTicketState {
  const [state, setState] = useState<LinearTicketState>({
    title: null,
    description: null,
    labels: null,
    relations: null,
    loaded: false,
  });

  useEffect(() => {
    if (!id) {
      setState(NULL_STATE);
      return;
    }
    let stop = false;
    setState({ title: null, description: null, labels: null, relations: null, loaded: false });
    fetch(`/api/linear-ticket/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<LinearTicketResponse>) : null))
      .then((body) => {
        if (stop) return;
        setState({
          title: body?.title ?? null,
          description: body?.description ?? null,
          labels: body?.labels ?? null,
          relations: body?.relations ?? null,
          loaded: true,
        });
      })
      .catch(() => {
        if (!stop) setState(NULL_STATE);
      });
    return () => {
      stop = true;
    };
  }, [id]);

  return state;
}
