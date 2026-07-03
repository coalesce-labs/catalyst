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

// claimedAtAgeMs — ms since the fence was CLAIMED (CTL-863). Keyed on
// `claimedAt`, NOT the row's shared `updated_at` (which every ticket_state
// writer bumps — a webhook fold on an active ticket would spuriously "freshen" a
// dead-owner fence, spec finding 6). `claimed_at` is set only by a real claim /
// takeover / heartbeat re-emit, so its age measures FENCE liveness, not broker
// liveness. Infinity when absent/unparseable → the freshness gate fails safe
// (too old → escalate to the authoritative read, never trust).
export function claimedAtAgeMs(fence, now = Date.now()) {
  const ts = fence?.claimedAt;
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
        delegate: row.delegate ?? null,
        uuid: row.uuid ?? null,
        removed: row.removed_at != null,
        removedAt: row.removed_at ?? null,
        updatedAt: row.updated_at ?? null,
        // CTL-863: fence projection columns (broker-owned, CTL-923 schema). These
        // were surfaced in ticket_state but omitted from getDescriptor — the real
        // gap the fence-read migration closes. A pre-CTL-923 DB yields undefined →
        // null (SELECT * simply lacks the columns).
        ownerHost: row.owner_host ?? null,
        generation: row.catalyst_generation ?? null,
        fencePhase: row.fence_phase ?? null,
        claimedAt: row.claimed_at ?? null,
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

// gatewayLabelsHit — cache-only label probe for the retraction sweep (CTL-1079).
// Maps the broker projection (ticket_state.labels via getDescriptor) into the
// { ok, labels } shape removeLabel's readLabels seam expects. Returns null on
// ANY cache miss — no gateway, no getDescriptor, absent row, tombstoned row, or
// a labels column that isn't an array — so the caller can fall back to a live
// read. Pure: never shells out, never throws.
export function gatewayLabelsHit(gateway, ticket) {
  if (!gateway || typeof gateway.getDescriptor !== "function") return null;
  let d;
  try {
    d = gateway.getDescriptor(ticket);
  } catch {
    return null;
  }
  if (d && !d.removed && Array.isArray(d.labels)) {
    return { ok: true, labels: d.labels };
  }
  return null;
}

// gatewayFence — cache-only fence probe for the CTL-863 fence guard. Maps the
// broker projection (ticket_state fence columns via getDescriptor) into the
// { ownerHost, generation, phase, claimedAt } shape fenceGuard reads. Returns
// null on ANY miss — no gateway, no getDescriptor, absent row, tombstoned row,
// or a row with no owner_host at all (never claimed / released → cleared) — so
// the guard falls back to the authoritative read rather than trusting an empty
// projection. A released fence (owner_host cleared to null) therefore reads as
// null here → the multi-host guard escalates or the self-owned check fails →
// suppress (fail-closed). Pure: never shells out, never throws.
export function gatewayFence(gateway, ticket) {
  if (!gateway || typeof gateway.getDescriptor !== "function") return null;
  let d;
  try {
    d = gateway.getDescriptor(ticket);
  } catch {
    return null;
  }
  if (!d || d.removed) return null;
  if (d.ownerHost == null) return null; // never-claimed / released → no fence to trust
  return {
    ownerHost: d.ownerHost,
    generation: Number.isFinite(d.generation) ? d.generation : null,
    phase: d.fencePhase ?? null,
    claimedAt: d.claimedAt ?? null,
  };
}
