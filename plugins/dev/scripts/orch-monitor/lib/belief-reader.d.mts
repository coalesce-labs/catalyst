// Type declarations for belief-reader.mjs (CTL-967, N5).
// belief-reader.mjs uses bun:sqlite internally (behind a computed specifier so
// esbuild cannot pull it into the browser bundle); these types let server.ts
// and the test file import it with full type safety.

export interface BeliefRow {
  belief_id: number;
  tick_id: number;
  rule_id: string;
  name: string;
  subject: string;
  value: string | null;
  source_fact_ids: string;
  stratum: number;
  /** epoch ms from the parent tick row; null when tick row is missing */
  ts_ms: number | null;
  /** host name from the parent tick row; null when tick row is missing */
  host: string | null;
}

export interface BeliefTailOptions {
  /** Path to beliefs.db (default: ~/catalyst/beliefs.db). */
  dbPath?: string;
  /** Max rows returned per poll (default: 200). */
  pageSize?: number;
}

/**
 * BeliefTail — stateful cursor over the `belief` table in beliefs.db.
 * poll() returns new rows since the last call, advancing the cursor.
 * Gracefully returns [] if beliefs.db is absent or unreadable.
 * Never writes to beliefs.db (read-only).
 */
export declare class BeliefTail {
  /** Last emitted belief_id; -1 = unprimed. */
  lastBeliefId: number;
  constructor(opts?: BeliefTailOptions);
  /**
   * Prime the cursor to the current max belief_id so a fresh SSE connection
   * does not replay the entire history.
   */
  prime(): Promise<void>;
  /**
   * Return new belief rows since the cursor, advancing it.
   * Returns [] on any error or when beliefs.db is absent.
   */
  poll(): Promise<BeliefRow[]>;
  /** Close the underlying DB handle (idempotent). */
  close(): void;
}
