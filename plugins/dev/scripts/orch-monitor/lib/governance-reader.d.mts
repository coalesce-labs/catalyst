// Type declarations for governance-reader.mjs (CTL-1100).
// governance-reader.mjs lazy-imports bun:sqlite via a computed specifier so
// esbuild cannot pull it into the browser bundle; these types give server.ts
// and test files full type safety without a static bun:sqlite import.

import type { Database } from "bun:sqlite";

/**
 * Resolve the beliefs.db path from the environment.
 * Precedence: CATALYST_BELIEFS_DB › CATALYST_DIR/beliefs.db › ~/catalyst/beliefs.db.
 */
export declare function defaultBeliefsDbPath(env?: NodeJS.ProcessEnv): string;

/**
 * Open beliefs.db READ-ONLY (create:false).
 * Returns null on any error (absent file, import failure, etc.).
 * Never throws. Callers must treat null as "data unavailable".
 */
export declare function openBeliefsDbRO(dbPath: string): Promise<Database | null>;

/**
 * Single degradation wrapper for db-backed governance endpoints.
 * Opens a RO handle, runs fn(db), closes in finally, returns fallback on null/throw.
 */
export declare function withBeliefsDbRO<T>(
  dbPath: string,
  fn: (db: Database) => T | Promise<T>,
  fallback: T,
): Promise<T>;

/**
 * The allowlist of event name prefixes that qualify as governance lifecycle events.
 * One entry per pipeline step (phase.triage. … phase.teardown.) plus phase.remediate.
 */
export declare const GOVERNANCE_EVENT_PREFIXES: ReadonlyArray<string>;

/**
 * True iff the event name is a governance-relevant phase lifecycle event.
 * Rejects names containing "reap" or "would." and reaper-family prefixes.
 * Admits only names starting with a GOVERNANCE_EVENT_PREFIXES entry.
 */
export declare function isGovernanceEvent(name: string): boolean;
