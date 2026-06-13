// belief-why.mjs — thin re-export of traceTicket/latestTickForTicket from
// execution-core/beliefs/why.mjs, plus traceTicketJson that delegates the db
// open to openBeliefsDbRO (no second open path).
//
// NOTE: DO NOT inline the specifiers below — computed specifiers required
// (VITE-GRAPH GUARD, CTL-883). This file IS the single bun:sqlite-touching
// path via governance-reader.mjs:openBeliefsDbRO; server.ts loads this file
// itself via a computed specifier to keep that chain graph-isolated from the
// Vite graph.

// Re-export the resolver and the tick-finder so callers can drive them
// directly without importing from execution-core (which has bun:sqlite at
// top level via schema.mjs).

const WHY_SPECIFIER = ["../../execution-core/beliefs/why.mjs"].join("");
const READER_SPECIFIER = ["./governance-reader.mjs"].join("");

let _why = null;
async function getWhy() {
  if (_why) return _why;
  _why = await import(WHY_SPECIFIER);
  return _why;
}

let _reader = null;
async function getReader() {
  if (_reader) return _reader;
  _reader = await import(READER_SPECIFIER);
  return _reader;
}

// traceTicketJson — one-shot wrapper:
//   1. Opens the db via openBeliefsDbRO (read-only, create:false).
//   2. If absent/unreadable returns empty trace immediately.
//   3. Calls traceTicket, closes in finally, returns the result.
//   4. On any resolver throw, returns the empty trace.
//
// opts.tickId: optional explicit tick_id (number); undefined = latest.
export async function traceTicketJson({ ticket, tickId, dbPath } = {}) {
  const emptyTrace = { ticket: ticket ?? null, tickId: null, beliefs: [] };
  try {
    const { openBeliefsDbRO } = await getReader();
    const db = await openBeliefsDbRO(dbPath);
    if (db == null) return emptyTrace;
    try {
      const { traceTicket } = await getWhy();
      return traceTicket(db, ticket, tickId != null ? { tickId } : {});
    } catch {
      return emptyTrace;
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  } catch {
    return emptyTrace;
  }
}
