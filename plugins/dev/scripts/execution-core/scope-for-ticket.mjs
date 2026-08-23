// scope-for-ticket.mjs — CTL-2129. Map a ticket identifier to its scope key so
// an instrument pages resolveSteward(projectId), NOT resolveSteward(ticketId): a
// steward owns a PROJECT, so a raw ticket id can never match a project steward's
// scopeKeys.
//
// Pure and node:*-only (imports nothing) — the same import-free discipline
// escalation-router.mjs holds, so a bare-`node` role runner loads it with no
// node_modules. The one I/O dependency (readProjectId, a bun-side replica read)
// is INJECTED, so the mapping is tested deterministically rather than discovered
// during an outage.

/**
 * ticket → scope key (Linear project id), fail-open.
 *
 * The fallback to the RAW ticket id is deliberate: an unknown/unproject-ed ticket
 * then resolves to no steward → concierge, which is the correct fail direction
 * (never a crash, never a direct-human label). A readProjectId that is missing,
 * not a function, or throws is treated identically — the ticket id is returned.
 *
 * @param {string} ticket
 * @param {{readProjectId?: (ticket: string) => string|null}} [deps]
 * @returns {string} the project id, or the ticket id when there is no project
 */
export function scopeForTicket(ticket, { readProjectId } = {}) {
  try {
    const pid = typeof readProjectId === "function" ? readProjectId(ticket) : null;
    return typeof pid === "string" && pid.length > 0 ? pid : ticket;
  } catch {
    return ticket;
  }
}
