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

/** /api/linear-ticket/<id> response shape (server.ts). */
interface LinearTicketResponse {
  id: string;
  title: string | null;
  description: string | null;
  source: "linear-live" | "unavailable";
}

export interface LinearTicketState {
  title: string | null;
  description: string | null;
  loaded: boolean;
}

/** Fetch the ticket's REAL Linear {title, description}. Cleanup via a `stop`
 *  flag (mirrors useTicketArtifacts in ticket-detail-page.tsx). */
export function useLinearTicket(id: string): LinearTicketState {
  const [state, setState] = useState<LinearTicketState>({
    title: null,
    description: null,
    loaded: false,
  });

  useEffect(() => {
    if (!id) {
      setState({ title: null, description: null, loaded: true });
      return;
    }
    let stop = false;
    setState({ title: null, description: null, loaded: false });
    fetch(`/api/linear-ticket/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<LinearTicketResponse>) : null))
      .then((body) => {
        if (stop) return;
        setState({
          title: body?.title ?? null,
          description: body?.description ?? null,
          loaded: true,
        });
      })
      .catch(() => {
        if (!stop) setState({ title: null, description: null, loaded: true });
      });
    return () => {
      stop = true;
    };
  }, [id]);

  return state;
}
