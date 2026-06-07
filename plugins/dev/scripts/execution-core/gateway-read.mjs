// gateway-read.mjs — CTL-823 (Gateway L1 child c): the daemon's READ client
// for the broker-owned durable descriptor store (~/catalyst/filter-state.db,
// schema CTL-821, populated by the CTL-822 webhook write-through).
//
// Deliberately NOT an HTTP client: the scheduler tick is synchronous, so an
// HTTP hop would mean another per-call subprocess (the exact cost this slice
// removes). SQLite WAL exists for this shape — the broker stays the single
// WRITER, this module opens the same file strictly READONLY. The HTTP read
// surface moves to child (d), where out-of-process workers actually need it.
//
// Fail-open contract: ANY failure (file absent, pre-CTL-821 schema, lock
// contention, corrupt row) returns null — callers fall through to the live
// linearis read exactly as before this module existed. The gateway is a safe
// optimization, never the source of truth.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { resolve } from "node:path";

function defaultDbPath() {
  return resolve(process.env.CATALYST_DIR ?? `${homedir()}/catalyst`, "filter-state.db");
}

// descriptorAgeMs — ms since the descriptor's last write; Infinity when the
// timestamp is absent/unparseable so staleness checks fail safe (too old).
export function descriptorAgeMs(descriptor, now = Date.now()) {
  const ts = descriptor?.updatedAt;
  if (!ts) return Infinity;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? now - t : Infinity;
}

export function createGatewayReader({ dbPath = defaultDbPath() } = {}) {
  let db = null;

  const open = () => {
    if (db) return db;
    db = new Database(dbPath, { readonly: true });
    // Readonly + WAL: writers never block readers, but a checkpoint can hold
    // the lock briefly — wait a beat instead of failing the read.
    db.run("PRAGMA busy_timeout = 250");
    return db;
  };

  const dropHandle = () => {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
    db = null;
  };

  const parse = (s) => {
    if (s === null || s === undefined) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  // getDescriptor — full descriptor row or null (absent row OR any failure).
  // A pre-CTL-821 DB (legacy 4-column ticket_state) still resolves: SELECT *
  // simply yields undefined for the missing columns → nulls.
  const getDescriptor = (ticket) => {
    if (!ticket) return null;
    try {
      const row = open().prepare(`SELECT * FROM ticket_state WHERE ticket = ?`).get(ticket);
      if (!row) return null;
      return {
        ticket: row.ticket,
        state: row.linear_state ?? null,
        prNumber: row.pr_number ?? null,
        relations: parse(row.relations),
        labels: parse(row.labels),
        priority: row.priority ?? null,
        resolution: row.resolution ?? null,
        assignee: row.assignee ?? null,
        uuid: row.uuid ?? null,
        removed: row.removed_at != null,
        removedAt: row.removed_at ?? null,
        updatedAt: row.updated_at ?? null,
      };
    } catch {
      // Drop the handle so a later call re-opens fresh — the DB may be
      // created/migrated by the broker between calls.
      dropHandle();
      return null;
    }
  };

  return { getDescriptor, close: dropHandle };
}
