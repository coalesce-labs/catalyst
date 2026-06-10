// Type declarations for linear-title-description-fallback.mjs — supplemental
// {title, description} resolver for the ticket-detail page (CTL-974 pattern).

/** Resolved supplemental fields for a single ticket. */
export interface TitleDescription {
  /** The ticket's real current Linear title, or null when unavailable. */
  title: string | null;
  /** The ticket's description as raw markdown, or null when unavailable/empty. */
  description: string | null;
}

/**
 * fillTitleDescriptionFallback — given an array of ticket IDs, return a map
 * { [id]: { title, description } } for those IDs.
 *
 * - Hits are served from the in-memory TTL cache (5 min).
 * - Remaining IDs are batched into one Linear GraphQL call per team-chunk.
 * - Always resolves; never rejects (fail-open → { title:null, description:null }).
 */
export function fillTitleDescriptionFallback(
  ticketIds: string[],
): Promise<Record<string, TitleDescription>>;

// Test / webhook helpers.
/** Clear one ticket's cache entry (id given) or the whole cache (id omitted). */
export function _clearTitleDescCache(id?: string): void;
/** Current number of cached ticket entries. */
export function _getTitleDescCacheSize(): number;
