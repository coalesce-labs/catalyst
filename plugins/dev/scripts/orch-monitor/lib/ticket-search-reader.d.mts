// Type declarations for ticket-search-reader.mjs (CTL-889, P12). Keep in sync
// with the object assembled in the .mjs.

import type { TicketDescriptor } from "../../broker/broker-state.d.mts";

/** One fuzzy search result row. */
export interface TicketSearchResult {
  /** The matched ticket identifier. */
  ticket: string;
  /** Linear workflow state name from the descriptor, or null. */
  linearState: string | null;
  /** Component/held labels from the descriptor. */
  labels: string[];
  /** Match score — higher is a better match (substring > subsequence). */
  score: number;
}

export interface TicketSearchResponse {
  /** The original query string. */
  query: string;
  /** Ranked matches, capped at `limit`. */
  results: TicketSearchResult[];
  /** Provenance marker — always "filter-state.db" (never a live Linear hit). */
  source: "filter-state.db";
}

/** Pure fuzzy search over a descriptor array. */
export function searchDescriptors(
  query: string,
  descriptors: TicketDescriptor[],
  opts?: { limit?: number },
): TicketSearchResponse;

export interface ReadTicketSearchOptions {
  dbPath?: string;
  limit?: number;
  descriptorsReader?: () =>
    | TicketDescriptor[]
    | Promise<TicketDescriptor[]>;
}

/** Route-facing reader: fuzzy-search the durable ticket_state cache. */
export function readTicketSearch(
  query: string,
  opts?: ReadTicketSearchOptions,
): Promise<TicketSearchResponse>;
