// inbox-summary-data.ts — pure mapping helpers for the inbox-summary API
// (CTL-1042 Phase 4). No network, no hooks — unit-tested in inbox-summary-data.test.ts.
import type { BoardTicket } from "@/board/types";

/** Shape returned by GET /api/inbox/:ticket/summary */
export interface InboxSummaryResponse {
  enabled: boolean;
  summary?: string | null;
  ask?: string | null;
  /** API uses `tradeoffs`; merge maps it to BoardTicket.DecisionOption.detail */
  options?: Array<{ label: string; tradeoffs?: string }> | null;
  blocker?: string | null;
  generatedAt?: string;
}

/** Build the endpoint URL, appending ?phase= when provided. */
export function inboxSummaryUrl(ticket: string, phase?: string): string {
  const base = `/api/inbox/${encodeURIComponent(ticket)}/summary`;
  return phase != null ? `${base}?phase=${encodeURIComponent(phase)}` : base;
}

/** True only when the response carries at least one displayable field. */
export function summaryIsUsable(resp: InboxSummaryResponse | null): boolean {
  if (!resp?.enabled) return false;
  return resp.ask != null || resp.summary != null;
}

/**
 * Shallow-merge API summary fields onto a BoardTicket. Only fields present in
 * the response are overwritten; absent/null fields leave the ticket unchanged
 * (degradation = identity merge — today's raw content stays visible).
 */
export function mergeSummaryIntoTicket(
  ticket: BoardTicket,
  resp: InboxSummaryResponse | null,
): BoardTicket {
  if (!resp?.enabled) return ticket;
  return {
    ...ticket,
    ...(resp.summary != null ? { summary: resp.summary } : {}),
    ...(resp.ask != null ? { ask: resp.ask } : {}),
    ...(resp.blocker != null ? { blocker: resp.blocker } : {}),
    ...(resp.options != null
      ? {
          options: resp.options.map((o) => ({
            label: o.label,
            detail: o.tradeoffs ?? "",
          })),
        }
      : {}),
  };
}
