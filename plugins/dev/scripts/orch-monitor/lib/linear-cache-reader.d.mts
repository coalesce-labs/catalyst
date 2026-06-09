// Type declarations for linear-cache-reader.mjs (CTL-883 durable-cache Linear
// enrichment). Keep in sync with the object assembled in the .mjs.

export interface LinearCacheEntry {
  /** 0=no priority, 1=urgent .. 4=low (Linear scale). */
  priority: number;
  /** Story-point estimate — absent from the durable cache, so always null. */
  estimate: number | null;
  /** Project name (from the eligible projection; ticket_state has no project). */
  project: string | null;
  /** Component/held labels from the ticket_state descriptor. */
  labels: string[];
  /** Linear relation graph (blocks/related/…), or null when uncached. */
  relations: unknown;
  /** Assignee UUID from the ticket_state descriptor, or null. */
  assignee: string | null;
  /** Linear workflow state name from the descriptor, or null. */
  linearState: string | null;
  /**
   * Ticket title — only the eligible projection carries it (ticket_state has no
   * title column), so null when the ticket has no eligible row (BFF9 / CTL-921).
   */
  title: string | null;
  /**
   * CTL-922 (BFF10): the owning host NAME, projected into ticket_state from the
   * catalyst://fence attachment by the broker (BFF11 / CTL-923). board-data
   * derives the host {name,id} ref from this for the node-aware surfaces. null
   * when no fence attachment has been observed.
   */
  ownerHost: string | null;
  /**
   * CTL-922 (BFF10): the fence generation from the same durable projection — the
   * value a fence-aware web mutation (BFF8 stop, HOME5 unblock) passes to
   * isFenceCurrent without a live attachment fetch. null when no fence.
   */
  generation: number | null;
}

export type LinearCacheById = Record<string, LinearCacheEntry>;

export interface ReadLinearCacheOptions {
  dbPath?: string;
  eligibleDir?: string;
  ticketStateReader?: (dbPath: string) => Promise<Record<string, Partial<LinearCacheEntry>>>;
  eligibleReader?: (eligibleDir: string) => Promise<Record<string, Partial<LinearCacheEntry>>>;
  breakerOpen?: boolean;
}

export function readLinearCache(opts?: ReadLinearCacheOptions): Promise<LinearCacheById>;
