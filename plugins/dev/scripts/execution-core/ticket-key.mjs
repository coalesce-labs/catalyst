// ticket-key.mjs — the canonical "is this string a Linear ticket key?" predicate
// (CTL-1504). A worker-dir census reads bare directory names (`d.name`) off the
// filesystem; a debris dir like `.catalyst` must NEVER be handed to a live
// `linearis issues read` as a ticket id. Single source of truth for the shape
// `/^[A-Z]+-\d+$/` (previously inline at stall-janitor.mjs:654). Zero deps.
export const TICKET_KEY_RE = /^[A-Z]+-\d+$/;

// isTicketKey — true iff `name` is a canonical TEAM-123 ticket key. Never throws;
// non-string / null / empty → false.
export function isTicketKey(name) {
  return typeof name === "string" && TICKET_KEY_RE.test(name);
}
