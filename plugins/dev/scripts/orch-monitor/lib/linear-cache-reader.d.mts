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
   * CTL-922 (BFF10) + CTL-884 (BFF2): the owning host NAME, projected into
   * ticket_state from the catalyst://fence attachment by the broker (BFF11 /
   * CTL-923). board-data derives the host {name,id} ref from this for the
   * node-aware surfaces; the cluster view groups by it. null when no fence
   * attachment has been observed (the read-model NEVER does a live attachment
   * fetch). Required on the type — the assembled `.mjs` ALWAYS emits it.
   */
  ownerHost: string | null;
  /**
   * CTL-922 (BFF10): the fence generation from the same durable projection — the
   * value a fence-aware web mutation (BFF8 stop, HOME5 unblock) passes to
   * isFenceCurrent without a live attachment fetch. null when no fence.
   */
  generation: number | null;
  /**
   * CTL-884 (BFF2) fence companions. OPTIONAL on the type (additive — only the
   * cluster view consumes them; the BFF9 /api/linear fetcher and its fixtures
   * pre-date them and never construct them) but the assembled `.mjs` ALWAYS emits
   * them (null when no fence is cached), so a consumer that reads them gets a
   * defined value, never `undefined`.
   */
  /** The pipeline phase recorded on the fence at claim time, or null. */
  fencePhase?: string | null;
  /** ISO timestamp the fence was claimed, or null. */
  claimedAt?: string | null;
  /** ISO timestamp the held label was first applied (hold duration source), or null. */
  heldSince?: string | null;
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
