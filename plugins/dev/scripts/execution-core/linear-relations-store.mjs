// linear-relations-store.mjs — CAT-168: on-disk persistence (L2) for the
// relations cache. linear-cache.mjs's relationsEntries Map is the L1 (hot
// per-tick reads, unchanged latency); this store lets a fresh entry survive a
// daemon restart instead of forcing a full live `linearis issues read`
// re-fetch of every ticket's relations.
//
// Deliberately a SEPARATE SQLite file/schema from catalyst-replica.db — this
// must NOT become a second writer feeding the CAT-152 replica (which, per
// operator direction 2026-08-10, is expected to be torn down within days once
// Catalyst Cloud onboarding lands). This store has no dependency on that
// infrastructure and is unaffected by its removal.
//
// Fail-open contract throughout: any disk error (missing dir, corrupt row,
// lock contention) degrades to a miss/no-op, never throws into the scheduler
// tick — this is an accelerator, never a source of truth. Mirrors the
// broker/filter-state.mjs conventions (WAL mode, CREATE TABLE IF NOT EXISTS,
// prepared statements).

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";

let db = null;

const CATALYST_DIR = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
const DEFAULT_DB_PATH = resolve(CATALYST_DIR, "linear-relations-cache.db");

function openRelationsStoreDb(dbPath) {
  if (db) return db;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new Database(dbPath, { create: true });
    db.run("PRAGMA journal_mode=WAL");
    db.run(`
      CREATE TABLE IF NOT EXISTS relations_cache (
        identifier  TEXT PRIMARY KEY,
        desc_json   TEXT NOT NULL,
        expires_at  INTEGER NOT NULL
      )
    `);
    return db;
  } catch {
    db = null; // fail-open — caller gets a store whose methods all no-op/miss
    return null;
  }
}

export function closeRelationsStoreDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// createRelationsStore — the read/write facade linear-cache.mjs's
// createTicketStateCache consumes as an optional `relationsStore` L2.
export function createRelationsStore(dbPath = DEFAULT_DB_PATH) {
  const database = openRelationsStoreDb(dbPath);
  if (!database) {
    return { get: () => undefined, set: () => {}, invalidate: () => {} };
  }

  const getStmt = database.prepare(`SELECT desc_json, expires_at FROM relations_cache WHERE identifier = ?`);
  const setStmt = database.prepare(`
    INSERT INTO relations_cache (identifier, desc_json, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(identifier) DO UPDATE SET desc_json = excluded.desc_json, expires_at = excluded.expires_at
  `);
  const deleteStmt = database.prepare(`DELETE FROM relations_cache WHERE identifier = ?`);

  function get(identifier) {
    try {
      const row = getStmt.get(identifier);
      if (!row) return undefined;
      return { desc: JSON.parse(row.desc_json), expiresAt: row.expires_at };
    } catch {
      return undefined; // corrupt row / disk error — treated as a miss
    }
  }

  function set(identifier, desc, expiresAt) {
    try {
      setStmt.run(identifier, JSON.stringify(desc), expiresAt);
    } catch {
      // fail-open — a write failure must never throw into the hot path
    }
  }

  function invalidate(identifier) {
    try {
      deleteStmt.run(identifier);
    } catch {
      // fail-open
    }
  }

  return { get, set, invalidate };
}
