// inbox-ask.mjs — "what this needs from you", derived (CTL-1569 §1).
//
// The most important part of the inbox conversation surface: each parked row must
// lead with a plain-language statement of what would SATISFY the ask, and of what
// KIND of ask it is. The distinction the operator actually cares about is not the
// taxonomy for its own sake — it is:
//
//     can I resolve this by REPLYING alone, or do I have to go DO something first?
//
// That single bit is `canResolveByReply`, and every kind below exists to carry it
// honestly.
//
//   approve          — a yes/no is enough                      (reply alone: YES)
//   decide           — choose between enumerated options        (reply alone: YES)
//   act-then-confirm — you must DO something, then confirm      (reply alone: NO)
//   clarify          — free-text answer needed, no default      (reply alone: YES)
//
// TWO SOURCES, in preference order (CTL-1569: "prefer a structured `ask` object …
// fall back to deriving from the last agent comment … do not block the UI on the
// producer change"):
//
//   1. STRUCTURED — an `ask` object on the phase signal's `explanation`
//      (`kind`, `summary`, `suggested_replies[]`). This is what the escalation
//      producer SHOULD write. When present it is used verbatim: the producer knows
//      what it asked far better than any reader-side heuristic.
//   2. DERIVED — the structured explanation's own fields (`options`,
//      `call_to_action`, `what_to_do`), then finally the last AGENT comment body.
//      This is what makes the surface useful for tickets parked BEFORE the producer
//      change — a UI that only renders for future escalations has nothing to show
//      today.
//
// HONESTY RULES (the whole module is built around them):
//   • `source` is always reported ("structured" | "explanation" | "comment"), so
//     the UI can be quieter about a guess than about a producer-authored ask.
//   • A derivation that finds NO usable text returns null — the pane renders the
//     ask block ABSENT rather than fabricating "reply to continue". Absent is
//     honest; invented is not (the standing read-model rule).
//   • `suggestedReplies` is only ever populated from ENUMERATED options or an
//     explicit producer list. The text classifier NEVER invents a reply chip —
//     a chip that prefills a reply the agent won't accept is worse than no chip.
//
// PURE + injection-free: no fs, no db, no fetch. The caller supplies the phase
// signals and (optionally) the last agent comment, so this is unit-tested directly.

/** The four ask kinds (CTL-1569 §1 table). */
export const ASK_KINDS = ["approve", "decide", "act-then-confirm", "clarify"];

/** Kinds an operator can satisfy by replying ALONE — the bit that matters most.
 *  `act-then-confirm` is deliberately excluded: it requires off-platform work
 *  first, and telling the operator "just reply" there would be a lie. */
const REPLY_ALONE_KINDS = new Set(["approve", "decide", "clarify"]);

/** Cap on a rendered summary. Long escalation prose is truncated with an ellipsis
 *  rather than dumped into the row — the full text stays in the thread + pane. */
const SUMMARY_MAX = 400;

/** Cap on suggested-reply chips. More than a handful stops being a shortcut and
 *  becomes a second decision; the operator can always type a free reply. */
const MAX_SUGGESTED = 4;

// ── text classification ──────────────────────────────────────────────────────
// A deliberately CONSERVATIVE classifier. It only claims a kind when the text
// carries a clear marker; everything unrecognized falls to `clarify`, which is the
// honest default ("free-text answer needed, no default"). Ordered most-specific
// first because the act-then-confirm markers are the ones that must never be
// mistaken for a plain approve — misclassifying "create the label, then reply
// done" as `approve` would tell the operator a bare "yes" is sufficient when it
// demonstrably is not. That is the one error with a real cost, so it wins ties.

/** "You must go DO something first, then come back and confirm." */
const ACT_THEN_CONFIRM_PATTERNS = [
  /\bthen\s+(?:reply|confirm|respond|comment|say)\b/i,
  /\b(?:reply|confirm|respond|comment)\s+(?:with\s+)?["'`]?done["'`]?\b/i,
  /\bonce\s+(?:you(?:'ve|\s+have)?|that(?:'s|\s+is)?)\s+.*\b(?:reply|confirm|respond|done)\b/i,
  /\bafter\s+you\s+.*\b(?:reply|confirm|respond)\b/i,
  /\bmanually\s+(?:create|add|set|apply|run|fix|delete|remove)\b/i,
  /\b(?:create|add|set|apply|run|rotate|delete|remove|grant|install)\b[^.!?]*\bthen\b/i,
];

/** A yes/no is enough. */
const APPROVE_PATTERNS = [
  /\b(?:approve|approval)\b/i,
  /\bok(?:ay)?\s+to\s+(?:proceed|continue|merge|publish|ship|deploy|delete)\b/i,
  /\bshould\s+i\s+(?:proceed|continue|merge|publish|ship|deploy|go\s+ahead)\b/i,
  /\bpermission\s+to\b/i,
  /\bgo\/no-?go\b/i,
  /\bconfirm\s+(?:that\s+)?(?:i|we)\s+(?:should|can|may)\b/i,
  /\byes\s*\/\s*no\b/i,
];

/** Choose between enumerated alternatives. */
const DECIDE_PATTERNS = [
  /\bwhich\s+(?:one|option|of|approach|way)\b/i,
  /\b(?:option|choice)\s+(?:a|b|1|2)\b/i,
  /\beither\b[^.!?]*\bor\b/i,
  /\bA\)\s*.*\bB\)/,
  /\b(?:choose|pick|select)\s+(?:between|one|from)\b/i,
];

function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

/**
 * Classify free-text into an ask kind. Conservative + ordered: act-then-confirm
 * (the costly-to-miss case) → decide → approve → clarify (the honest default).
 * Exported so the classification itself is directly unit-tested.
 */
export function classifyAskText(text) {
  if (typeof text !== "string" || text.trim() === "") return "clarify";
  if (matchesAny(text, ACT_THEN_CONFIRM_PATTERNS)) return "act-then-confirm";
  if (matchesAny(text, DECIDE_PATTERNS)) return "decide";
  if (matchesAny(text, APPROVE_PATTERNS)) return "approve";
  return "clarify";
}

// ── helpers ──────────────────────────────────────────────────────────────────

function nonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Collapse whitespace + truncate for a one-glance summary. Markdown is left as
 *  literal text: the pane renders it as plain text, so a stray `**` is cosmetic,
 *  whereas a partial-HTML render would be a correctness bug. */
export function condenseSummary(text, max = SUMMARY_MAX) {
  const s = nonEmptyString(text);
  if (s == null) return null;
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** Normalize a producer-supplied kind, or null when it isn't one of the four. */
function normalizeKind(v) {
  const s = nonEmptyString(v);
  if (s == null) return null;
  const k = s.toLowerCase().replace(/_/g, "-");
  return ASK_KINDS.includes(k) ? k : null;
}

/** Normalize a suggested-reply list to short, de-duped, non-empty strings. */
function normalizeSuggested(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    // Accept either a bare string or an {label} / {value} object (the options
    // shape the escalation producer already writes for decision rows).
    const label = nonEmptyString(
      typeof item === "string" ? item : item?.label ?? item?.value ?? null,
    );
    if (label == null) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= MAX_SUGGESTED) break;
  }
  return out;
}

/** Build the closed ask view object. `kind` is trusted; the reply-alone bit is
 *  always DERIVED from the kind so the two can never disagree. */
function buildAsk({ kind, summary, suggestedReplies, source }) {
  return {
    kind,
    summary,
    suggestedReplies,
    canResolveByReply: REPLY_ALONE_KINDS.has(kind),
    source,
  };
}

// ── the structured (preferred) path ──────────────────────────────────────────

/**
 * Read a producer-authored `ask` object off an explanation. Returns null unless it
 * carries BOTH a recognized kind AND a summary — a half-written ask is treated as
 * absent so the derived path can still produce something useful, rather than
 * rendering a kind chip with no sentence under it.
 */
export function askFromStructured(explanation) {
  const ask = explanation?.ask;
  if (!ask || typeof ask !== "object") return null;
  const kind = normalizeKind(ask.kind);
  const summary = condenseSummary(ask.summary);
  if (kind == null || summary == null) return null;
  return buildAsk({
    kind,
    summary,
    suggestedReplies: normalizeSuggested(ask.suggested_replies ?? ask.suggestedReplies),
    source: "structured",
  });
}

// ── the derived paths ────────────────────────────────────────────────────────

/**
 * Derive an ask from the explanation's EXISTING fields (no `ask` object). This is
 * the sweet spot for tickets parked today: the CTL-1110 escalation producer
 * already writes `call_to_action` / `what_to_do` / `options`.
 *
 * Enumerated `options` are the strongest signal available — two or more of them
 * IS a decision, and their labels are legitimate reply chips (they came from the
 * producer, not from a guess). Otherwise the CTA/what-to-do text is classified.
 */
export function askFromExplanation(explanation) {
  if (!explanation || typeof explanation !== "object") return null;

  const options = normalizeSuggested(explanation.options);
  const cta = nonEmptyString(explanation.call_to_action);
  const whatToDo = nonEmptyString(explanation.what_to_do);

  // Enumerated options → a decision, with the option labels as real chips.
  if (options.length >= 2) {
    const summary = condenseSummary(cta ?? whatToDo ?? `Choose: ${options.join(" / ")}`);
    if (summary == null) return null;
    return buildAsk({
      kind: "decide",
      summary,
      suggestedReplies: options,
      source: "explanation",
    });
  }

  // No options → classify the most actionable prose the producer wrote. Both
  // fields feed the classifier (what_to_do is where "…then reply done" usually
  // lives, and missing that is the one costly error), but the CTA leads the
  // summary because it is the shorter, more imperative line.
  const summary = condenseSummary(cta ?? whatToDo);
  if (summary == null) return null;
  const kind = classifyAskText([cta, whatToDo].filter(Boolean).join(" — "));
  return buildAsk({ kind, summary, suggestedReplies: [], source: "explanation" });
}

/**
 * Last-resort derivation from the newest AGENT comment — what makes the ~handful
 * of tickets parked RIGHT NOW render usefully. `source: "comment"` lets the UI
 * mark it as inferred rather than producer-authored.
 *
 * Never produces reply chips: a chip derived from prose would be a guess at what
 * the agent accepts, and a wrong chip is worse than a free-text box.
 */
export function askFromComment(commentBody) {
  const summary = condenseSummary(commentBody);
  if (summary == null) return null;
  return buildAsk({
    kind: classifyAskText(commentBody),
    summary,
    suggestedReplies: [],
    source: "comment",
  });
}

// ── choosing WHICH agent comment carries the ask ──────────────────────────────
//
// The newest agent comment is usually the ask — but not always, and the exception
// is systematic rather than rare. The recovery-pass escalation posts a content-free
// POINTER as its final word:
//
//     🔼 **recovery-pass** self-heal attempts exhausted on this ticket —
//     escalated to the operator. (See your inbox.)
//
// That is the entire comment. Deriving the ask from it yields a summary that tells
// the operator only that they are needed, which they already knew — while the
// comment directly beneath it carries the actual reason:
//
//     **Reason:** Failure reason: duplicate_of_CTL-1385:fix_already_merged…
//
// So we skip SHORT, purely-referential escalation notices and use the newest
// SUBSTANTIVE agent comment instead. This is selection among things the agent
// really said — never fabrication. If every agent comment is a notice we fall back
// to the newest one rather than rendering nothing: a weak ask beats an absent one
// when the agent genuinely said nothing else.

/** Markers of a bare "you are needed, look elsewhere" notice. */
const ESCALATION_NOTICE_PATTERNS = [
  /\(see your inbox\.?\)/i,
  /escalated to the operator/i,
  /marked for human review/i,
  /requires human judgment/i,
  /self-heal attempts exhausted/i,
];

/** Below this length a notice-matching comment is treated as a pure pointer. A
 *  LONG comment that happens to contain a notice phrase still carries content, so
 *  the length floor keeps the filter from discarding real asks. */
const NOTICE_MAX_CHARS = 400;

/** Is this body a content-free escalation pointer? Exported for direct testing. */
export function isEscalationNotice(body) {
  const s = nonEmptyString(body);
  if (s == null) return true; // an empty body carries no ask either
  if (s.length > NOTICE_MAX_CHARS) return false;
  return matchesAny(s, ESCALATION_NOTICE_PATTERNS);
}

/**
 * Pick the agent comment that best carries the ask, from a NEWEST-FIRST list of
 * agent comment bodies. Returns the newest substantive body, else the newest body,
 * else null for an empty list.
 */
export function pickAskComment(agentComments) {
  const bodies = (Array.isArray(agentComments) ? agentComments : [])
    .map((b) => nonEmptyString(b))
    .filter(Boolean);
  if (bodies.length === 0) return null;
  return bodies.find((b) => !isEscalationNotice(b)) ?? bodies[0];
}

// ── the public entry point ───────────────────────────────────────────────────

/**
 * Derive the ask summary for a parked ticket, walking the preference chain:
 *   structured `ask` → explanation fields → newest agent comment → null.
 *
 * `explanation` is the CTL-1110 six-field object (board-data.mjs::deriveExplanation)
 * optionally extended with an `ask` object. For the comment fallback, prefer
 * `agentComments` (a NEWEST-FIRST list, so notice-skipping can apply); the single
 * `lastAgentComment` remains accepted for callers that have only one body.
 *
 * Returns null when NO source yields usable text — the pane then renders no ask
 * block at all (honest absence).
 */
export function deriveAsk({
  explanation = null,
  agentComments = null,
  lastAgentComment = null,
} = {}) {
  const commentBody =
    (Array.isArray(agentComments) ? pickAskComment(agentComments) : null) ?? lastAgentComment;
  return (
    askFromStructured(explanation) ??
    askFromExplanation(explanation) ??
    askFromComment(commentBody) ??
    null
  );
}
