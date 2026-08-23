// ask-wake.mjs — CTL-2157. The PURE half of "an ask must wake the agent parked
// on it": given the commented ticket and its replica detail record, decide which
// WORK tickets that comment should wake.
//
// ── WHY THIS EXISTS ──
// The wake path (daemon.mjs `handleCommentWake`, CTL-549) has always keyed on a
// comment landing on the WORK ticket. An ask is a DIFFERENT ticket — one ask
// ticket carrying a `blocks` relation to the work it holds up — so the human's
// answer lands somewhere the wake path never looked. Precedent: ADV-1374/1376 sat
// for DAYS because nothing consumed the ask. An ask that does not wake its agent
// piles up exactly the way the `needs-human` label did: the same disease with a
// nicer name.
//
// ── THE UNION, AND WHY BOTH HALVES ARE LOAD-BEARING ──
// Two independent records of what an ask holds up, and they fail DIFFERENTLY:
//
//   1. the replica's `relations` table (type='blocks', issue_identifier → related_identifier)
//      — Linear's own answer, mirrored locally. ⚠️ It can be MISSING even on a
//      correctly-filed ask: `linearis issues create --blocks` keeps only the LAST
//      `--blocks` flag on some versions (ask.mjs `missingBlocksFrom` exists for
//      exactly that), so a multi-ticket ask files with one relation, or none.
//   2. the ask BODY's `Blocks:` line, written by ask.mjs `buildAskBody`
//      — the filer's stated intent, immune to the relation-drop above. ⚠️ But a
//      human editing the description can drop it.
//
// Either one alone is a silent no-wake, which is the failure this phase exists to
// remove — so the answer is their UNION.
//
// ⛔ AUDIT CORRECTION (plan-audit Gap 4). The audit reported that `blocks`
// relations are unavailable locally, having enumerated the top-level keys of
// `issues.raw` and found no `relations` key. That is true of `raw` and NOT true of
// the replica: there is a normalized `relations` TABLE. Measured 2026-08-21 on
// ~/catalyst/catalyst-replica.db: 2,982 rows, 937 of them type='blocks', and the
// two known asks CTC-694 and CTL-2132 each carry the exact edge their body's
// `Blocks:` line names (CTC-689 and CTC-841). So this resolver costs ZERO Linear
// API quota. (`replica-read.mjs` `details()` already reads title + description +
// labels + relations in one snapshot; this module is the interpretation on top.)
//
// PURE: no IO, no clock, no process state. The daemon injects the detail record.

// ⛔ A SECOND COPY of ask.mjs's ASK_LABEL_NAMES, deliberately: importing ask.mjs
// from the daemon would run its CLI self-execution guard, which exits the process
// with 3 if argv[0] happens to be "create"/"accept". The copy is pinned by a
// parity test (ask-wake.test.mjs) — the same discipline alert-emit's taxonomy uses
// against board-data's.
export const ASK_LABEL_NAMES = Object.freeze(["catalyst-ask", "ask/decision"]);

/** A Linear identifier, anchored — `CTL-2157`, `CTC-841`. */
const TICKET_ID = /^[A-Z][A-Z0-9]*-\d+$/;
/** The same, unanchored, for pulling every id out of one declaration line. */
const TICKET_ID_G = /\b[A-Z][A-Z0-9]*-\d+\b/g;

// The `Blocks` header. Mirrors ask.mjs's OPTIONS_HEADER shape (one
// alternation-free pattern so the bold markers cannot be matched at the preceding
// newline), with the colon OPTIONAL — a human-authored ask writes
// `Blocks [CTC-598](…)` with no colon (measured on CTC-601).
const BLOCKS_HEADER = /(?:^|\n)[ \t]*\*{0,2}[ \t]*Blocks[ \t]*:?[ \t]*\*{0,2}[ \t]*/i;
// ⛔ THE DECLARATION MUST NAME AN ID FIRST. Without this, "Blocks the release
// until CTL-123 lands" reads as a declaration and dispatches an agent onto
// CTL-123. A false positive here is a spurious wake, so the bar is: the first
// token after the header is a ticket id (bare, or as a markdown link label).
const STARTS_WITH_ID = /^\*{0,2}\[?[A-Z][A-Z0-9]*-\d+\b/;
/** `- CTL-1` / `* CTL-1` — one item of a bulleted Blocks list. */
const LIST_ITEM = /^[-*]\s+(.+)$/;

const idsIn = (line) => (typeof line === "string" ? (line.match(TICKET_ID_G) ?? []) : []);

const uniqueIds = (ids) => [...new Set(ids.filter((id) => TICKET_ID.test(id)))];

/**
 * parseBlocksFromBody — the ids named by an ask body's `Blocks:` declaration.
 *
 * Accepts the inline form (`Blocks: CTL-1, CTL-2`, with or without markdown
 * links) and the bulleted form under a `**Blocks:**` header. Returns `[]` for
 * anything it cannot read as a declaration — never a guess.
 */
export function parseBlocksFromBody(body) {
  if (typeof body !== "string" || body.trim() === "") return [];
  const header = BLOCKS_HEADER.exec(body);
  if (header == null) return [];
  const lines = body.slice(header.index + header[0].length).split("\n");

  const out = [];
  let i = 0;
  const head = (lines[0] ?? "").trim();
  if (head !== "") {
    // An inline declaration. If the header line is prose, the whole match was
    // prose — stop, rather than walking into an unrelated list below it.
    if (!STARTS_WITH_ID.test(head)) return [];
    out.push(...idsIn(head));
    i = 1;
  }
  for (; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") {
      if (out.length > 0) break; // a blank line ends the list (same rule as the options parser)
      continue;
    }
    const item = LIST_ITEM.exec(trimmed);
    if (item == null) break; // a non-item line ends the list
    if (!STARTS_WITH_ID.test(item[1].trim())) break;
    out.push(...idsIn(item[1]));
  }
  return uniqueIds(out);
}

/**
 * isAskDetail — does this ticket carry an ask label?
 *
 * Fails CLOSED: an absent/unreadable detail is NOT an ask, so a replica miss can
 * never fan a comment out across the workspace.
 */
export function isAskDetail(detail, { labelNames = ASK_LABEL_NAMES } = {}) {
  const labels = detail?.labels;
  if (!Array.isArray(labels)) return false;
  return labels.some((l) => {
    const name = typeof l === "string" ? l : l?.name;
    return typeof name === "string" && labelNames.includes(name);
  });
}

/**
 * blocksFromRelations — the FORWARD `blocks` edges only.
 *
 * `blockedBy` is the other direction (something blocks THIS ticket) and must
 * never be woken: waking it would dispatch the agent that is already waiting on
 * this one.
 */
export function blocksFromRelations(detail) {
  const edges = detail?.relations?.blocks;
  if (!Array.isArray(edges)) return [];
  return uniqueIds(
    edges
      .map((t) => (typeof t === "string" ? t : t?.identifier))
      .filter((id) => typeof id === "string")
  );
}

/**
 * resolveAskWakeTargets — the whole decision, in one place.
 *
 * → `{ isAsk, blocked }`. `blocked` is the deduped union of the relation edges and
 * the body declaration, minus the ask itself (a self-edge would re-enter the wake
 * path on the ticket that just fired it).
 *
 * ⛔ Gated on `isAsk`. The daemon receives EVERY workspace `linear.comment.created`,
 * so an ungated resolver would let any ticket whose description mentions a Blocks
 * line dispatch agents onto tickets nobody asked about.
 */
export function resolveAskWakeTargets(ticket, detail, { labelNames = ASK_LABEL_NAMES } = {}) {
  if (!isAskDetail(detail, { labelNames })) return { isAsk: false, blocked: [] };
  const blocked = uniqueIds([
    ...blocksFromRelations(detail),
    ...parseBlocksFromBody(detail?.description),
  ]).filter((id) => id !== ticket);
  return { isAsk: true, blocked };
}

/**
 * createAskBlocksResolver — bind the pure resolver to a replica reader.
 *
 * `readDetails` is `replica-read.mjs`'s `details([id])` (or any shape returning
 * `{ [identifier]: detail }`). Fail-open in the SAFE direction: any throw, any
 * miss ⇒ `[]` ⇒ today's single-ticket wake, never a fabricated fan-out.
 */
export function createAskBlocksResolver(readDetails) {
  return function askBlocks(ticket) {
    if (typeof readDetails !== "function" || !ticket) return [];
    try {
      const detail = readDetails([ticket])?.[ticket];
      return resolveAskWakeTargets(ticket, detail).blocked;
    } catch {
      return [];
    }
  };
}
