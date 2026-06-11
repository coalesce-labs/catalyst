// Type declarations for linear-title-description-fallback.mjs — supplemental
// {title, description, labels, relations} resolver for the ticket-detail page
// (CTL-974 pattern, extended CTL-996).

/** A single Linear label. */
export interface LinearLabel {
  name: string;
  color: string;
}

/** Relations grouped by direction and type. */
export interface LinearRelations {
  /** Identifiers of tickets this ticket is blocked by. */
  blockedBy: string[];
  /** Identifiers of tickets this ticket blocks. */
  blocks: string[];
  /** Identifiers of related tickets (deduped, both directions). */
  related: string[];
  /** Identifiers of tickets this ticket is a duplicate of. */
  duplicateOf: string[];
}

/** Resolved supplemental fields for a single ticket. */
export interface TitleDescription {
  /** The ticket's real current Linear title, or null when unavailable. */
  title: string | null;
  /** The ticket's description as raw markdown, or null when unavailable/empty. */
  description: string | null;
  /** The ticket's Linear labels, or null when unavailable/on fetch failure. */
  labels: LinearLabel[] | null;
  /** The ticket's relations (blockedBy/blocks/related/duplicateOf), or null on failure. */
  relations: LinearRelations | null;
}

/**
 * fillTitleDescriptionFallback — given an array of ticket IDs, return a map
 * { [id]: { title, description, labels, relations } } for those IDs.
 *
 * - Hits are served from the in-memory TTL cache (5 min).
 * - Remaining IDs are batched into one Linear GraphQL call per team-chunk.
 * - Always resolves; never rejects (fail-open → all null fields).
 */
export function fillTitleDescriptionFallback(
  ticketIds: string[],
): Promise<Record<string, TitleDescription>>;

// Test / webhook helpers.
/** Clear one ticket's cache entry (id given) or the whole cache (id omitted). */
export function _clearTitleDescCache(id?: string): void;
/** Current number of cached ticket entries. */
export function _getTitleDescCacheSize(): number;
