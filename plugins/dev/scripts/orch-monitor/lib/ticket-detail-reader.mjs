// ticket-detail-reader.mjs — cache-backed Linear ticket detail for the ticket
// detail page's RELATIONS / LABELS / HELD / narrative panels (CTL-889, P8).
//
// The board payload (board-data.mjs) carries the FORWARD `blockers[]` edge and
// the held label classification, but the ticket detail page also needs:
//   • reverse relation edges (who BLOCKS this ticket, what RELATES to it),
//   • the full component LABELS set,
//   • the assignee,
//   • the Linear workflow state + priority,
//   • the held classification + the held-since timestamp (when the cache has one).
//
// Every field is read EXCLUSIVELY from the broker's durable filter-state.db
// ticket_state descriptor (CTL-821) via the broker-state read helpers — this
// route NEVER does a synchronous `linearis` call (the BFF1 / CTL-883 decision,
// and the rate-limit win the brief calls out). The Linear circuit breaker
// (execution-core/linear-breaker.mjs) is honored by construction: this module
// spawns NOTHING, so it cannot trip the breaker and a cache read is always
// served.
//
// HONEST-NULL CONTRACT: a field the durable cache does not carry is returned as
// null/[] — never fabricated. In particular:
//   • `description` (the Linear narrative body) is NOT stored in ticket_state,
//     so it is always null here (the UI renders that row dim). Re-fetching it
//     live would violate the cache-only architecture.
//   • `heldSince` has no timestamp column in ticket_state today — `heldFor` is
//     pure label classification with no "since" — so it stays null until a real
//     timestamp lands in the cache (never a fabricated "2h14m").

import { heldFor } from "./board-data.mjs";

// Normalize one stored relation entry to { type, id }. ticket_state stores
// relations as a JSON array of { type, id } (see broker ticket-descriptor.test:
// `relations: [{ type: "blocks", id: "CTL-780" }]`). Tolerant of partial/odd
// shapes — a malformed entry is dropped rather than throwing the whole read.
function normRelation(rel) {
  if (!rel || typeof rel !== "object") return null;
  const type = typeof rel.type === "string" ? rel.type : null;
  const id =
    typeof rel.id === "string"
      ? rel.id
      : typeof rel.identifier === "string"
        ? rel.identifier
        : null;
  if (!id) return null;
  return { type: type ?? "related", id };
}

// Forward relations stored on THIS ticket's descriptor → [{ type, id }].
function forwardRelations(descriptor) {
  const raw = descriptor?.relations;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const r of raw) {
    const n = normRelation(r);
    if (n) out.push(n);
  }
  return out;
}

// Linear relation types come in inverse pairs. To surface the REVERSE edges the
// board payload does not carry, scan every OTHER descriptor: if ticket B's
// descriptor declares `{ type: "blocks", id: A }`, then from A's perspective B
// is a `blocked_by` edge; a `related` edge is symmetric. This is the relation-
// graph join the ticket calls out as the L/5 cost driver.
const INVERSE_TYPE = {
  blocks: "blocked_by",
  blocked_by: "blocks",
  related: "related",
  duplicate_of: "duplicate",
  duplicate: "duplicate_of",
};

function reverseRelations(ticket, allDescriptors) {
  const out = [];
  for (const d of allDescriptors) {
    if (!d || d.ticket === ticket) continue;
    const rels = Array.isArray(d.relations) ? d.relations : [];
    for (const r of rels) {
      const n = normRelation(r);
      if (!n || n.id !== ticket) continue;
      out.push({ type: INVERSE_TYPE[n.type] ?? n.type, id: d.ticket });
    }
  }
  return out;
}

// buildTicketDetail — assemble the cache-backed detail object from the durable
// descriptors. Pure: the descriptor + the full descriptor set are passed in, so
// the unit tests drive it without a DB. Returns null when the ticket has no
// descriptor row (the route maps that to 404).
//
// Returns: {
//   ticket, linearState, priority, assignee, resolution, updatedAt,
//   description (always null — narrative not cached),
//   labels: string[],
//   held: "blocked" | "queued" | "waiting" | null,  // CTL-764: "waiting"→"queued"
//   heldSince: null,           // no timestamp in the cache today (honest null)
//   relations: {
//     forward: [{ type, id }], // edges THIS ticket declares
//     reverse: [{ type, id }], // edges OTHER tickets declare pointing here
//   },
//   source: "filter-state.db", // provenance marker — NEVER a live Linear hit
// }
export function buildTicketDetail(ticket, descriptor, allDescriptors = []) {
  if (!descriptor) return null;
  const labels = Array.isArray(descriptor.labels)
    ? descriptor.labels.filter((l) => typeof l === "string" && l.length > 0)
    : [];
  return {
    ticket,
    linearState: descriptor.state ?? null,
    priority: typeof descriptor.priority === "number" ? descriptor.priority : null,
    assignee: descriptor.assignee ?? null,
    resolution: descriptor.resolution ?? null,
    updatedAt: descriptor.updatedAt ?? null,
    // The Linear narrative body is not stored in ticket_state — honest null,
    // never re-fetched live (cache-only).
    description: null,
    labels,
    held: heldFor(labels),
    // No timestamp column for the held transition exists in the cache today;
    // surface null rather than a fabricated duration (the UI renders ↯).
    heldSince: null,
    relations: {
      forward: forwardRelations(descriptor),
      reverse: reverseRelations(ticket, allDescriptors),
    },
    source: "filter-state.db",
  };
}

// readTicketDetail — the route-facing reader. Opens (or reuses) the broker's
// shared filter-state.db handle and reads the requested descriptor plus the full
// descriptor set for the reverse-edge join, then assembles via buildTicketDetail.
//
// All collaborators are injectable so the route + unit tests drive it without a
// real DB. Tolerant of an absent/locked DB: any failure returns null (the route
// maps that to 404), never throws, never blocks (CTL-883 cache-only contract).
export async function readTicketDetail(
  ticket,
  {
    dbPath,
    // injection seams (default to the real broker-state durable readers)
    descriptorReader,
    allDescriptorsReader,
  } = {},
) {
  try {
    let descRead = descriptorReader;
    let allRead = allDescriptorsReader;
    if (!descRead || !allRead) {
      const { openBrokerStateDb, getTicketDescriptor, getAllTicketDescriptors } =
        await import("../../broker/broker-state.mjs");
      openBrokerStateDb(dbPath);
      descRead = descRead ?? ((t) => getTicketDescriptor(t));
      allRead = allRead ?? (() => getAllTicketDescriptors());
    }
    const descriptor = await descRead(ticket);
    if (!descriptor) return null;
    const all = (await allRead()) ?? [];
    return buildTicketDetail(ticket, descriptor, all);
  } catch {
    return null;
  }
}
