// comms-drain.mjs — execution-core Step F comms-channel drain decision (CTL-533).
//
// Pure mirror of the comms-attention promotion in orchestrate/SKILL.md
// (CTL-111, CTL-269): workers post type:"attention" messages to the
// orchestrator's channel when blocked; the scan promotes each one to a
// state-level attention item.
//
// The caller is responsible for reading messages from the channel file since
// the cursor. This function is pure: given the already-read messages and the
// prior cursor, it returns the attention items and the advanced cursor.

// TICKET_PREFIX — workers post with their TICKET_ID as the author (--as),
// matching the legacy `grep -oE '^[A-Z]+-[0-9]+'` extraction.
const TICKET_PREFIX = /^[A-Z]+-[0-9]+/;

// drainComms — promote attention messages and advance the cursor.
//
// inputs: { messages:[{type,from,body}], cursor:number }
// returns: { attentions:[{kind,ticket,body}], newCursor:number }
export function drainComms({ messages = [], cursor = 0 }) {
  const attentions = [];
  for (const msg of messages) {
    if (msg?.type !== "attention") continue;
    const from = msg.from ?? "";
    const match = from.match(TICKET_PREFIX);
    attentions.push({
      kind: "comms-attention",
      ticket: match ? match[0] : from,
      body: `[${from}] ${msg.body ?? ""}`,
    });
  }
  return { attentions, newCursor: cursor + messages.length };
}
