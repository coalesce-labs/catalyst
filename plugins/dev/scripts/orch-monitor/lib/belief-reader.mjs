// belief-reader.mjs — read-only BeliefTail for the beliefs SSE endpoint
// (CTL-967, N5). Tails new belief rows from ~/catalyst/beliefs.db by a
// tick_id/belief_id cursor; each poll returns rows since the cursor and
// advances it. Never writes to beliefs.db.
//
// VITE-GRAPH GUARD (same pattern as linear-cache-reader.mjs, CTL-883):
// beliefs/schema.mjs has a top-level `import { Database } from "bun:sqlite"`.
// This module is imported by server.ts via a COMPUTED specifier so esbuild
// cannot follow the dependency graph into bun:sqlite. See openBeliefsDbRO()
// for the lazy import pattern. DO NOT change the computed specifier to a
// string literal.
//
// Graceful degradation: if beliefs.db is absent or unreadable (shadow off),
// every poll returns [] rather than throwing. The SSE endpoint emits only the
// open frame and stays alive for future rows.

import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const DEFAULT_BELIEFS_DB_PATH = join(HOME, "catalyst", "beliefs.db");

// openBeliefsDbRO — lazily open beliefs.db READ-ONLY. Returns the db handle
// or null if the file is absent / import fails. Callers should treat null as
// "shadow disabled — degrade to empty".
async function openBeliefsDbRO(dbPath) {
  try {
    const { Database } = await import("bun:sqlite");
    // READONLY flag = 0x00000001 per Bun docs; pass as the second arg.
    return new Database(dbPath, { readonly: true, create: false });
  } catch {
    return null;
  }
}

/**
 * BeliefTail — stateful cursor over the `belief` table in beliefs.db.
 *
 * Each `poll()` call queries for belief rows with belief_id > lastBeliefId
 * (or tick_id > lastTickId when the cursor is tick-based). The cursor
 * advances so consecutive polls never return duplicates.
 *
 * Shape of each emitted row (matches the FiringFeed / FiringEvent interface
 * the Rules Explorer UI expects from /api/beliefs/stream):
 *   { belief_id, tick_id, rule_id, name, subject, value,
 *     source_fact_ids, stratum, ts_ms, host, rules_sha }
 * ts_ms, host, and rules_sha are JOIN'd from the tick table for the same tick_id.
 */
export class BeliefTail {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dbPath]   path to beliefs.db (default ~/catalyst/beliefs.db)
   * @param {number} [opts.pageSize] max rows per poll (default 200)
   */
  constructor({ dbPath = DEFAULT_BELIEFS_DB_PATH, pageSize = 200 } = {}) {
    this.dbPath = dbPath;
    this.pageSize = pageSize;
    /** cursor: the last belief_id we emitted. -1 = not yet primed. */
    this.lastBeliefId = -1;
    /** lazy-opened DB handle; null while absent/unreadable. */
    this._db = null;
    this._dbLoaded = false;
  }

  /** Lazy-load the DB handle (read-only). */
  async _ensureDb() {
    if (this._dbLoaded) return this._db;
    this._dbLoaded = true;
    this._db = await openBeliefsDbRO(this.dbPath);
    return this._db;
  }

  /**
   * Prime the cursor to the CURRENT max belief_id so a fresh connection does
   * not replay the entire history. Called once on the first SSE open.
   */
  async prime() {
    const db = await this._ensureDb();
    if (!db) return;
    try {
      const row = db.query("SELECT MAX(belief_id) AS max_id FROM belief").get();
      this.lastBeliefId = row?.max_id ?? 0;
    } catch {
      this.lastBeliefId = 0;
    }
  }

  /**
   * poll() — return new belief rows since the cursor, advancing the cursor.
   * Each row is enriched with ts_ms + host + rules_sha from the tick table.
   * Returns [] if the db is absent, empty, or an error occurs.
   *
   * @returns {Promise<Array<{belief_id:number,tick_id:number,rule_id:string,
   *   name:string,subject:string,value:string|null,source_fact_ids:string,
   *   stratum:number,ts_ms:number|null,host:string|null,rules_sha:string|null}>>}
   */
  async poll() {
    const db = await this._ensureDb();
    if (!db) return [];
    // On the very first poll (lastBeliefId === -1) prime to the tail so we
    // don't spray the entire history at the connecting client.
    if (this.lastBeliefId === -1) {
      await this.prime();
    }
    try {
      const rows = db
        .query(
          `SELECT b.belief_id, b.tick_id, b.rule_id, b.name, b.subject,
                  b.value, b.source_fact_ids, b.stratum,
                  t.now_ms AS ts_ms, t.host, t.rules_sha
             FROM belief b
             LEFT JOIN tick t ON t.tick_id = b.tick_id
            WHERE b.belief_id > ?
            ORDER BY b.belief_id ASC
            LIMIT ?`,
        )
        .all(this.lastBeliefId, this.pageSize);
      if (rows.length > 0) {
        this.lastBeliefId = rows[rows.length - 1].belief_id;
      }
      return rows;
    } catch {
      return [];
    }
  }

  /** Close the underlying DB handle (idempotent). */
  close() {
    if (this._db) {
      try {
        this._db.close();
      } catch {
        /* already closed */
      }
      this._db = null;
    }
  }
}
