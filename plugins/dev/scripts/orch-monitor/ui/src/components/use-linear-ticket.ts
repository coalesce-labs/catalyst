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

/** Own-ticket state (name + workflow type). */
export interface LinearStateRef {
  name: string;
  /** Linear workflow state type: "backlog"|"unstarted"|"started"|"completed"|"canceled" */
  type: string;
}

/** A resolved relation-target issue (B3: enriched with title, state, priority, project). */
export interface LinearRelationTarget {
  /** Linear identifier, e.g. "CTL-997". */
  identifier: string;
  /** Issue title, or null when unavailable. */
  title: string | null;
  /** Issue state (name+type), or null when unavailable. */
  state: LinearStateRef | null;
  /** Issue priority (0–4, 0=none), or null when unavailable. */
  priority: number | null;
  /** Project name, or null when unavailable. */
  project: string | null;
}

/** Relations grouped by direction and type. B3: arrays are LinearRelationTarget[]. */
export interface LinearRelations {
  blockedBy: LinearRelationTarget[];
  blocks: LinearRelationTarget[];
  related: LinearRelationTarget[];
  duplicateOf: LinearRelationTarget[];
}

/** /api/linear-ticket/<id> response shape (server.ts). */
interface LinearTicketResponse {
  id: string;
  title: string | null;
  description: string | null;
  labels: LinearLabel[] | null;
  relations: LinearRelations | null;
  state: LinearStateRef | null;
  priority: number | null;
  project: string | null;
  estimate: number | null;
  source: "linear-live" | "unavailable";
}

export interface LinearTicketState {
  title: string | null;
  description: string | null;
  labels: LinearLabel[] | null;
  relations: LinearRelations | null;
  /** Own-ticket state (name+type), or null when unavailable. */
  state: LinearStateRef | null;
  /** Own-ticket priority (0=none, 1=urgent, 2=high, 3=medium, 4=low), or null. */
  priority: number | null;
  /** Own-ticket project name, or null when unavailable. */
  project: string | null;
  /** Own-ticket estimate (story points), or null when unset. */
  estimate: number | null;
  loaded: boolean;
}

const NULL_STATE: LinearTicketState = {
  title: null,
  description: null,
  labels: null,
  relations: null,
  state: null,
  priority: null,
  project: null,
  estimate: null,
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
    state: null,
    priority: null,
    project: null,
    estimate: null,
    loaded: false,
  });

  useEffect(() => {
    if (!id) {
      setState(NULL_STATE);
      return;
    }
    let stop = false;
    setState({ title: null, description: null, labels: null, relations: null, state: null, priority: null, project: null, estimate: null, loaded: false });
    fetch(`/api/linear-ticket/${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? (r.json() as Promise<LinearTicketResponse>) : null))
      .then((body) => {
        if (stop) return;
        setState({
          title: body?.title ?? null,
          description: body?.description ?? null,
          labels: body?.labels ?? null,
          relations: body?.relations ?? null,
          state: body?.state ?? null,
          priority: body?.priority ?? null,
          project: body?.project ?? null,
          estimate: body?.estimate ?? null,
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
