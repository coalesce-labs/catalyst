// inbox-read-client.ts — THE read path of the calm Inbox home reading pane
// (CTL-1042). The mirror of respond-client.ts (the WRITE path): a React-/jotai-/
// router-free module that owns the two GET calls the reading pane makes on select
// — the per-item AI summary and the research/plan deep-dive artifact list. It
// lives OUTSIDE the React tree on purpose:
//
//   1. The home tree's no-fetch invariant (home-surface.test.ts: "the ONLY place
//      the write client (fetch) is reached is …") keeps every literal fetch( out
//      of home-surface / inbox-row / reading-pane — the components reach the
//      network ONLY through an isolated client like this one, via a hook.
//   2. Being module-graph-free lets the orch-monitor `bun test` suite unit each
//      branch (ok / !ok / network throw) directly, with an injected fetch, the
//      same way respond-client is tested — no DOM, no server.
//
// Every call FAILS SOFT: a non-ok response or a network throw resolves to an
// `ok:false` outcome (never a throw), so the hook degrades the pane to today's
// raw content instead of surfacing an error card.

import { inboxSummaryUrl, type InboxSummaryResponse } from "@/components/home/inbox-summary-data";

// ── inbox summary (per-item AI summary, CTL-1042) ────────────────────────────

/** The closed outcome of a summary fetch: the parsed response, or a soft miss
 *  (non-ok status / network throw) the pane degrades to raw content on. */
export type InboxSummaryResult =
  | { ok: true; response: InboxSummaryResponse }
  | { ok: false };

interface ReadDeps {
  /** Injectable fetch so the unit tests drive every branch without a server. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch the per-item AI summary for a needs-you row. GETs the summary endpoint
 * (inboxSummaryUrl bakes in the optional ?phase=) and maps the result to an
 * `InboxSummaryResult`. Fails soft on every IO path — a non-ok status or a
 * network throw becomes `{ ok: false }` so the pane keeps today's raw content.
 */
export async function fetchInboxSummary(
  ticket: string,
  phase: string | undefined,
  { fetchImpl = fetch }: ReadDeps = {},
): Promise<InboxSummaryResult> {
  try {
    const res = await fetchImpl(inboxSummaryUrl(ticket, phase));
    if (!res.ok) return { ok: false };
    const response = (await res.json()) as InboxSummaryResponse;
    return { ok: true, response };
  } catch {
    return { ok: false };
  }
}

// ── deep-dive artifact links (research / plan, CTL-1042 Scenario 4) ───────────

/** One research/plan thoughts artifact for the deep-dive pills. Mirrors the
 *  server reader's `TicketArtifact` shape (ticket-artifacts-reader.mjs). */
export interface TicketArtifact {
  kind: "research" | "plan";
  path: string;
  peek: string | null;
}

/** The raw artifact-list response shape the list route returns. */
export interface ArtifactsResponse {
  ticket: string;
  artifacts: TicketArtifact[];
  crossNodeCaveat: string;
}

/** The closed outcome of an artifacts fetch: the list (possibly empty), or a
 *  soft miss the pane renders no pills for. */
export type ArtifactsResult =
  | { ok: true; artifacts: TicketArtifact[] }
  | { ok: false };

/**
 * Fetch the research/plan artifact list for a row's deep-dive pills. GETs the
 * list route and maps to an `ArtifactsResult`. Fails soft — a non-ok status or
 * a network throw becomes `{ ok: false }` so no pills render (never an error).
 */
export async function fetchArtifacts(
  ticket: string,
  { fetchImpl = fetch }: ReadDeps = {},
): Promise<ArtifactsResult> {
  try {
    const res = await fetchImpl(`/api/ticket-artifacts/${encodeURIComponent(ticket)}`);
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as ArtifactsResponse;
    return { ok: true, artifacts: body.artifacts ?? [] };
  } catch {
    return { ok: false };
  }
}

/** The href for a single artifact's deep-dive pill — the by-kind content route
 *  the server serves the markdown from (CTL-1042). Centralized here (not inlined
 *  in the pane) so the URL shape has ONE source of truth the unit test locks. */
export function artifactHref(ticket: string, kind: TicketArtifact["kind"]): string {
  return `/api/ticket-artifacts/${encodeURIComponent(ticket)}/${encodeURIComponent(kind)}`;
}
