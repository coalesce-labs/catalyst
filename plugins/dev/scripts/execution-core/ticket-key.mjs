// ticket-key.mjs — the canonical "is this string a Linear ticket key?" predicate
// (CTL-1504). A worker-dir census reads bare directory names (`d.name`) off the
// filesystem; a debris dir like `.catalyst` must NEVER be handed to a live
// `linearis issues read` as a ticket id. Single source of truth, kept in sync
// with the identifiers phase-agent-dispatch accepts + creates under workers/
// (`^[A-Za-z][A-Za-z0-9_]*-[0-9]+$`, phase-agent-dispatch:234) so a real team
// prefix carrying a digit/underscore (e.g. `OPS_2-17`) is never skipped (Codex P1).
// Uppercase — real Linear ids are uppercase; a lowercase dir is not a ticket.
export const TICKET_KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

// isTicketKey — true iff `name` is a canonical TEAM-123 ticket key. Never throws;
// non-string / null / empty → false.
export function isTicketKey(name) {
  return typeof name === "string" && TICKET_KEY_RE.test(name);
}
