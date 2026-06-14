// Type declarations for belief-store-queries.mjs (CTL-1100).
// Pure db-injected query functions; no bun:sqlite transitive import safe for
// static import in server.ts. Keep in sync with belief-store-queries.mjs.

import type { Database } from "bun:sqlite";

export declare const RECENT_DEFAULT_LIMIT: number;
export declare const RATES_LRU_CAP: number;

export declare function beliefSummary(db: Database): unknown;
export declare function beliefRates(db: Database, lru: Map<number | null, unknown>): unknown;
export declare function beliefRecent(db: Database, opts?: { limit?: number }): unknown;
export declare function beliefCfg(db: Database): unknown;
export declare function beliefRulesManifest(db: Database): unknown;
