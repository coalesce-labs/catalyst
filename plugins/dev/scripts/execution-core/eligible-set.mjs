// eligible-set.mjs - execution-core eligible-set projection (CTL-535 Phase 3).
//
// Holds the in-memory eligible state (per project, a Map of pickable tickets)
// and persists it as an atomic per-project JSON projection at
// ~/catalyst/execution-core/eligible/<projectKey>.json. Mirrors the broker's
// projection.mjs: tmp + renameSync atomic writes, skip-write-when-unchanged.

import {
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { getEligibleDir, log } from "./config.mjs";

// projectKey -> { tickets: Map<identifier, ticket>, source, query }
const eligible = new Map();

function projectionPath(projectKey) {
  return join(getEligibleDir(), `${projectKey}.json`);
}

// Deterministic ticket order: lexicographic by identifier.
function byIdentifier(a, b) {
  return String(a.identifier).localeCompare(String(b.identifier));
}

// Stable content signature - identifiers + states + priorities + parent. The
// projection's updatedAt timestamp always differs between writes, so the
// skip-when-unchanged check compares ticket content, never the serialized
// body. JSON.stringify of the tuple list is collision-proof (its escaping
// disambiguates any separator that could appear inside a field).
//
// CTL-878: `parent` is part of the signature so a parent-only delta forces a
// rewrite. The dependency graph drops a `blocks` edge from a ticket's parent
// epic, which needs `parent` ON the projected descriptor. Without parent in the
// key, a pre-fix projection (no parent field) written by an older daemon would
// survive across a deploy whenever the project's identifier/state/priority set
// is steady — leaving the parent-epic edge un-dropped and the child deadlocked.
// CTL-957: `estimate` added to the signature so an estimate-only change
// (e.g. PM sets points on a queued ticket) forces a projection rewrite and the
// board picks up the new value without waiting for a state/priority change.
//
// CTL-926: relation edges (`blocks` / `blocked_by`) are also part of the
// signature. The scheduler bakes each ticket's relations into the on-disk
// projection and derives the blocked/ready graph from them (dependency-graph.mjs).
// A pure edge delta — a blocker added or removed in Linear with no state/
// priority/parent change — left all tuple fields identical, so the write
// was skipped and the scheduler kept reading stale edges, deadlocking a ticket
// whose blockers were already cleared. Only `blocks`/`blocked_by` types matter:
// they are the only types buildDependencyEdges consumes; `related`/`duplicate`
// are ignored and excluded to avoid spurious rewrites.
//
// The signature is order-independent (sorted) and array-source-independent: an
// edge appears in `relations` on one endpoint and `inverseRelations` on the
// other, but both encode the same dependency, so we normalize both into one
// sorted "type:peer" list per ticket.
function relationsSignature(t) {
  const edges = [];
  for (const n of t.relations?.nodes ?? []) {
    if (n?.type === "blocks" || n?.type === "blocked_by") {
      edges.push(`${n.type}:${n.relatedIssue?.identifier ?? ""}`);
    }
  }
  for (const n of t.inverseRelations?.nodes ?? []) {
    if (n?.type === "blocks" || n?.type === "blocked_by") {
      edges.push(`${n.type}:${n.issue?.identifier ?? ""}`);
    }
  }
  return edges.sort().join("|");
}

function contentKey(tickets) {
  return JSON.stringify(
    tickets.map((t) => [
      t.identifier,
      t.state,
      t.priority,
      t.parent ?? null,
      t.estimate ?? null,
      relationsSignature(t),
      // CTL-1174: delegate in the signature so an out-of-band delegate change
      // forces a projection rewrite (the CONTENTKEY PROJECTION TRAP). `?? null`
      // collapses undefined/null identically — a batch outage leaves delegate
      // unset and must not churn the set on the next successful poll.
      t.delegate ?? null,
    ]),
  );
}

function sortedTickets(projectKey) {
  const entry = eligible.get(projectKey);
  if (!entry) return [];
  return [...entry.tickets.values()].sort(byIdentifier);
}

// Atomic projection write, skipped when ticket content is unchanged so a
// steady-state reconcile produces zero disk writes.
function writeProjection(projectKey) {
  const entry = eligible.get(projectKey);
  if (!entry) return;
  const tickets = sortedTickets(projectKey);
  const file = projectionPath(projectKey);

  if (existsSync(file)) {
    try {
      const prev = JSON.parse(readFileSync(file, "utf8"));
      if (
        Array.isArray(prev.tickets) &&
        contentKey(prev.tickets) === contentKey(tickets)
      ) {
        return; // on-disk projection already has identical ticket content
      }
    } catch {
      // unreadable / malformed existing file - fall through and rewrite
    }
  }

  const body = JSON.stringify(
    {
      projectKey,
      updatedAt: new Date().toISOString(),
      source: entry.source,
      query: entry.query,
      tickets,
    },
    null,
    2,
  );
  mkdirSync(getEligibleDir(), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, file);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* tmp already gone */
    }
    throw err;
  }
}

// setProjectEligible - replace a project's eligible set and persist it.
export function setProjectEligible(projectKey, tickets, { source, query } = {}) {
  const map = new Map();
  for (const t of tickets) map.set(t.identifier, { ...t });
  eligible.set(projectKey, {
    tickets: map,
    source: source ?? null,
    query: query ?? null,
  });
  writeProjection(projectKey);
}

// removeTicket - drop one ticket from a project's eligible set. Returns true
// and rewrites the projection when the ticket was a member; returns false
// (no rewrite) otherwise. Removing a non-member is a safe no-op: the
// event-driven fast path can fire for a ticket that was never eligible.
export function removeTicket(projectKey, identifier) {
  const entry = eligible.get(projectKey);
  if (!entry || !entry.tickets.has(identifier)) return false;
  entry.tickets.delete(identifier);
  entry.source = "event"; // a removal is always event-driven
  writeProjection(projectKey);
  return true;
}

// dropProject - forget a project entirely: in-memory entry + projection file.
export function dropProject(projectKey) {
  eligible.delete(projectKey);
  try {
    unlinkSync(projectionPath(projectKey));
  } catch (err) {
    // ENOENT is expected (no projection written yet); anything else is logged.
    if (err?.code !== "ENOENT") {
      log.warn({ projectKey, err: err.message }, "failed to remove projection file");
    }
  }
}

// upsertTicket — insert or merge a single ticket into a project's eligible set
// and persist. CTL-681: the event-driven fold (handleIssueUpdatedEvent) adds a
// newly-eligible ticket from the webhook payload alone, with no Linear poll.
// Merge-over-existing preserves the richer fields (title, relations,
// inverseRelations) the last reconcile filled in, since the event payload does
// not carry them. writeProjection's skip-when-unchanged guard makes a no-op
// upsert produce zero disk writes.
export function upsertTicket(projectKey, ticket, { query } = {}) {
  let entry = eligible.get(projectKey);
  if (!entry) {
    entry = { tickets: new Map(), source: null, query: null };
    eligible.set(projectKey, entry);
  }
  const prev = entry.tickets.get(ticket.identifier);
  entry.tickets.set(ticket.identifier, { ...(prev ?? {}), ...ticket });
  entry.source = "event";
  if (query !== undefined) entry.query = query;
  writeProjection(projectKey);
}

// getEligibleSet - a sorted copy of a project's eligible tickets. Callers may
// mutate the result freely; the internal state is never exposed.
export function getEligibleSet(projectKey) {
  return sortedTickets(projectKey).map((t) => ({ ...t }));
}
