// relation-blockers.mjs — project Linear blocked-by/blocks relations into the
// per-ticket `blockers[]` the dependency graph reads (CTL-1020).
//
// WHY: board-data populates `blockers[]` ONLY from triage.json (tickets with a
// worker dir). Queued/Todo tickets — and any ticket whose dependency was set via
// Linear's "blocked by" relation without a triage pass — emit `blockers: []`, so
// the dep graph drew their nodes with no connecting edges. The Linear relations
// ARE already carried on the board payload (linfo[id].relations, from
// ticket_state / the eligible projection) but were never converted into blockers[].
// This module is the additive converter; the triage-derived blockers stay
// authoritative and these merge ON TOP (union, deduped).
//
// PURE + injectable so it unit-tests without a DB. No @xyflow/react, no Bun-only
// imports.

// Linear relation types come in inverse pairs (mirrors ticket-detail-reader's
// INVERSE_TYPE). For the dep graph we only care about the blocking axis:
//   - ticket T declares { type: "blocked_by", id: S }  ⇒ S blocks T  ⇒ T.blockers += S
//   - ticket S declares { type: "blocks",     id: T }  ⇒ S blocks T  ⇒ T.blockers += S
// `related` / `duplicate` are NOT dependency edges and are ignored.

/**
 * Normalize one relation entry to { type, id } | null. Tolerates the two stored
 * shapes:
 *   - ticket_state:  { type: "blocks", id: "CTL-780" }   (id OR identifier)
 *   - eligible node: { type: "blocked_by", relatedIssue: { identifier: "CTL-1" } }
 * A malformed/odd entry yields null (dropped, never throws).
 */
export function normRelation(rel) {
  if (!rel || typeof rel !== "object") return null;
  const type = typeof rel.type === "string" ? rel.type : null;
  const id =
    typeof rel.id === "string"
      ? rel.id
      : typeof rel.identifier === "string"
        ? rel.identifier
        : typeof rel.relatedIssue?.identifier === "string"
          ? rel.relatedIssue.identifier
          : typeof rel.relatedIssue?.id === "string"
            ? rel.relatedIssue.id
            : null;
  if (!id) return null;
  return { type: type ?? "related", id };
}

/**
 * Coerce a stored `relations` field to a flat array of raw relation entries.
 * Accepts:
 *   - an array:        [{ type, id }, …]
 *   - a {nodes:[…]}:   { nodes: [{ type, relatedIssue }, …] }  (eligible shape)
 *   - null/garbage:    → []
 */
export function relationEntries(relations) {
  if (Array.isArray(relations)) return relations;
  if (relations && Array.isArray(relations.nodes)) return relations.nodes;
  return [];
}

/**
 * Build a Map<ticketId, Set<blockerId>> from the enrichment map's relations.
 *
 * @param linfo { [ticketId]: { relations?: array|{nodes}|null } }
 *
 * Both relation directions are projected so a blocker→blocked edge is captured
 * regardless of which side of the pair Linear stored the relation on. Self-edges
 * (a ticket blocking itself) are skipped.
 */
export function buildBlockerMapFromRelations(linfo) {
  const map = new Map();
  if (!linfo || typeof linfo !== "object") return map;

  const add = (blockedId, blockerId) => {
    if (!blockedId || !blockerId || blockedId === blockerId) return;
    if (!map.has(blockedId)) map.set(blockedId, new Set());
    map.get(blockedId).add(blockerId);
  };

  for (const [ticketId, info] of Object.entries(linfo)) {
    for (const raw of relationEntries(info?.relations)) {
      const n = normRelation(raw);
      if (!n) continue;
      if (n.type === "blocked_by") {
        // this ticket is blocked BY n.id ⇒ n.id is a blocker of this ticket
        add(ticketId, n.id);
      } else if (n.type === "blocks") {
        // this ticket BLOCKS n.id ⇒ this ticket is a blocker of n.id
        add(n.id, ticketId);
      }
      // related / duplicate / unknown → not a dependency edge, ignored
    }
  }
  return map;
}

/**
 * Merge the triage-derived blockers (authoritative) with the relation-derived
 * blockers (additive gap-fill), returning a deduped string[]. Order: triage
 * blockers first (stable), then any relation blockers not already present.
 *
 * @param triageBlockers string[]      from ticketBlockers(triage)
 * @param relationBlockers Set<string> | string[] | undefined
 */
export function mergeBlockers(triageBlockers, relationBlockers) {
  const out = [];
  const seen = new Set();
  for (const b of triageBlockers ?? []) {
    const id = typeof b === "string" ? b : b == null ? "" : String(b);
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  for (const b of relationBlockers ?? []) {
    const id = typeof b === "string" ? b : b == null ? "" : String(b);
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
  }
  return out;
}
