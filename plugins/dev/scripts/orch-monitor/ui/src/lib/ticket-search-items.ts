export interface TicketSearchResultLike {
  ticket: string;
  linearState: string | null;
  labels: string[];
  score: number;
}

export interface TicketSearchRow {
  id: string;
  label: string;
  meta?: string;
}

export function ticketSearchItems(results: TicketSearchResultLike[]): TicketSearchRow[] {
  return results.map((res) => ({
    id: res.ticket,
    label: res.ticket,
    meta: res.linearState ?? undefined,
  }));
}
