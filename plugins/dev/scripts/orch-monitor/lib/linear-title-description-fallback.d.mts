// Type declarations for linear-title-description-fallback.mjs — supplemental
// {title, description, labels, relations, state, priority, project, estimate}
// resolver for the ticket-detail page (CTL-974 pattern, extended CTL-996+CTL-1003).

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

/** A resolved relation-target issue (B3: enriched from bare string). */
export interface RelationTarget {
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

/** Relations grouped by direction and type. B3: arrays are RelationTarget[]. */
export interface LinearRelations {
  /** Issues that block this ticket. */
  blockedBy: RelationTarget[];
  /** Issues this ticket blocks. */
  blocks: RelationTarget[];
  /** Related issues (deduped, both directions). */
  related: RelationTarget[];
  /** Issues this ticket is a duplicate of. */
  duplicateOf: RelationTarget[];
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
  /** Own-ticket state (name+type), or null when unavailable. */
  state: LinearStateRef | null;
  /** Own-ticket priority (0=none, 1=urgent, 2=high, 3=medium, 4=low), or null. */
  priority: number | null;
  /** Own-ticket project name, or null when unavailable. */
  project: string | null;
  /** Own-ticket estimate (story points), or null when unset. */
  estimate: number | null;
}

/**
 * fillTitleDescriptionFallback — given an array of ticket IDs, return a map
 * { [id]: TitleDescription } for those IDs.
 *
 * - Hits are served from the in-memory TTL cache (5 min default; 24h for completed/canceled).
 * - Remaining IDs are batched into one Linear GraphQL call per team-chunk.
 * - Always resolves; never rejects (fail-open → all null fields).
 */
export function fillTitleDescriptionFallback(
  ticketIds: string[],
): Promise<Record<string, TitleDescription>>;

/** CTL-1215: hard size cap (insertion-order LRU) on the in-memory cache. */
export const TITLE_DESC_CAP: number;

// Test / webhook helpers.
/** Clear one ticket's cache entry (id given) or the whole cache (id omitted). */
export function _clearTitleDescCache(id?: string): void;
/** Current number of cached ticket entries. */
export function _getTitleDescCacheSize(): number;
/**
 * CTL-1215: evict entries whose per-entry TTL has elapsed. Returns the count
 * removed. `now` is injectable for tests; a setInterval in server.ts calls it.
 */
export function _sweepTitleDescCache(now?: number): number;
