// ticket-search-reader.mjs — cache-backed fuzzy ticket search for the ⌘K
// palette's "Search all tickets in Linear" action (CTL-889, P12).
//
// The palette searches the resident board payload for tickets already on the
// board, but "search ALL tickets" needs the wider Linear-truth set. This reader
// serves that from the broker's durable filter-state.db ticket_state cache —
// EXACTLY like the detail route, it NEVER issues a per-keystroke live Linear
// call (the rate-limit win, BFF1 / CTL-883). The Linear circuit breaker is
// honored by construction: this module spawns nothing.
//
// The match is a lightweight fuzzy scorer over each descriptor's searchable
// text (ticket id + workflow state + labels): an exact substring ranks highest,
// then a contiguous-token match, then a subsequence (characters in order). This
// is deliberately simple and dependency-free — the cache is hundreds of rows, so
// a linear scan per query is cheap and a fuzzy library would be over-kill.

// Build the searchable haystack for one descriptor: id + state + labels, joined
// and lower-cased. The id is duplicated up front so an id-prefix query ranks it
// strongly.
function haystackFor(d) {
  const parts = [d.ticket ?? ""];
  if (d.state) parts.push(d.state);
  if (Array.isArray(d.labels)) parts.push(...d.labels.filter(Boolean));
  return parts.join(" ").toLowerCase();
}

// Score a query against a haystack. Higher = better; 0 = no match.
//   • exact substring → 1000 − position (earlier is better)
//   • subsequence (chars in order, possibly gapped) → up to ~500, denser = higher
//   • no subsequence → 0
function fuzzyScore(query, haystack) {
  if (query.length === 0) return 1; // empty query matches everything weakly
  const sub = haystack.indexOf(query);
  if (sub !== -1) return 1000 - Math.min(sub, 999);
  // subsequence walk
  let qi = 0;
  let firstHit = -1;
  let lastHit = -1;
  let hits = 0;
  for (let hi = 0; hi < haystack.length && qi < query.length; hi++) {
    if (haystack[hi] === query[qi]) {
      if (firstHit === -1) firstHit = hi;
      lastHit = hi;
      hits++;
      qi++;
    }
  }
  if (qi < query.length) return 0; // not all query chars matched in order
  // Denser spans (smaller first→last window) and earlier starts score higher.
  const span = lastHit - firstHit + 1;
  const density = hits / span; // (0, 1]
  return Math.round(200 + density * 200 - Math.min(firstHit, 100));
}

// searchDescriptors — pure fuzzy search over a descriptor array. Injected by the
// route + tests so no DB is required. Returns the top-`limit` matches as
// lightweight result rows, ranked by score then id.
//
// Returns: { query, results: [{ ticket, linearState, labels, score }], source }
export function searchDescriptors(query, descriptors, { limit = 20 } = {}) {
  const q = (query ?? "").trim().toLowerCase();
  const scored = [];
  for (const d of descriptors ?? []) {
    if (!d || !d.ticket) continue;
    const score = fuzzyScore(q, haystackFor(d));
    if (score <= 0) continue;
    scored.push({
      ticket: d.ticket,
      linearState: d.state ?? null,
      labels: Array.isArray(d.labels) ? d.labels.filter(Boolean) : [],
      score,
    });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0;
  });
  return {
    query: query ?? "",
    results: scored.slice(0, Math.max(0, limit)),
    source: "filter-state.db",
  };
}

// readTicketSearch — the route-facing reader. Opens (or reuses) the broker's
// shared filter-state.db handle, reads every descriptor in one pass, and fuzzy-
// matches the query. Injectable for tests. Tolerant of an absent/locked DB:
// returns an empty result set (never throws, never blocks — CTL-883).
export async function readTicketSearch(
  query,
  { dbPath, limit = 20, descriptorsReader } = {},
) {
  try {
    let read = descriptorsReader;
    if (!read) {
      const { openBrokerStateDb, getAllTicketDescriptors } = await import(
        "../../broker/broker-state.mjs"
      );
      openBrokerStateDb(dbPath);
      read = () => getAllTicketDescriptors();
    }
    const descriptors = (await read()) ?? [];
    return searchDescriptors(query, descriptors, { limit });
  } catch {
    return { query: query ?? "", results: [], source: "filter-state.db" };
  }
}
