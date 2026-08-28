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
/** Escalation types whose producer contract means the agent CANNOT do the work —
 *  the human must perform it, so a written reply alone can never resolve them. */
const ACTION_REQUIRED_ESCALATION_TYPES = new Set(["manual"]);

/** A `manual` escalation is only trusted as action-required when the producer
 *  actually filled the contract (a blocked capability / instructions), so a
 *  legacy payload that merely DEFAULTED to "manual" still classifies normally. */
export function isValidatedManualEscalation(expl) {
  if (!expl || typeof expl !== "object") return false;
  if (!ACTION_REQUIRED_ESCALATION_TYPES.has(expl.escalation_type)) return false;
  for (const k of ["blocked_capability", "instructions", "remediation", "what_to_do"]) {
    const v = expl[k];
    if (typeof v === "string" && v.trim() !== "") return true;
    if (Array.isArray(v) && v.length > 0) return true;
  }
  return false;
}

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
  const classified = classifyAskText([cta, whatToDo].filter(Boolean).join(" — "));
  return buildAsk({
    kind: declaredKind(explanation, classified),
    summary,
    suggestedReplies: [],
    source: "explanation",
  });
}

/**
 * The producer's DECLARED escalation type → ask kind.
 *
 * `escalation_type` is an existing documented tagged union — `decision |
 * authorization | manual`, defined by `VALID_TYPES` in
 * execution-core/escalation-explanation.mjs (the recovery-pass and
 * _phase-agent-template SKILL.md files that used to document it were removed in
 * CTL-2239) — i.e. the producer's own word for what it is asking. It beats any reader-side
 * reading of the CTA prose: the live `authorization` escalations say "authorize
 * another recovery cycle …, or take it over?", which the text classifier reads as
 * `clarify` ("free-text answer needed") when the producer plainly declared it a
 * yes/no.
 *
 * `manual` is deliberately ABSENT: it is the DEFAULT the producer substitutes when
 * nothing was declared (recovery-reasoning.mjs), so mapping it would turn
 * "unspecified" into a claim. Those fall through to the prose classifier.
 */
const ESCALATION_TYPE_KINDS = { decision: "decide", authorization: "approve" };

/** The declared kind, EXCEPT that a classified `act-then-confirm` always wins.
 *  That is the one asymmetry worth hard-coding: if the prose says "create the
 *  label, then reply done", honoring a declared `authorization` would tell the
 *  operator a bare "yes" is sufficient when it demonstrably is not. */
function declaredKind(explanation, classified) {
  if (classified === "act-then-confirm") return classified;
  // A VALIDATED `manual` escalation is action-required by contract: the producer
  // says the agent could not do the work itself. Without this, a CTA like "Rotate
  // the expired API credential." falls through to `clarify` and the pane promises
  // that a written reply alone resolves it. Only validated payloads qualify, so a
  // legacy signal that merely DEFAULTED to "manual" still classifies normally.
  if (isValidatedManualEscalation(explanation)) return "act-then-confirm";
  const declared = ESCALATION_TYPE_KINDS[nonEmptyString(explanation?.escalation_type)?.toLowerCase()];
  return declared ?? classified;
}

/**
 * Build an ask from a classified comment candidate (see classifyAskCandidate).
 *
 * The class decides the KIND for a `blocker`, bypassing the prose classifier: a
 * named failure with no question attached is work, not a question, and running it
 * through the classifier returned `clarify` — whose rendered promise is "a written
 * answer resolves this; there is no default". On a ticket blocked by a dirty tree
 * or a CONFLICTING PR that promise is simply false, and it is the expensive
 * direction of the error this module is built to avoid. `act-then-confirm` states
 * it honestly: do the work, then reply to confirm.
 */
export function askFromCandidate(candidate) {
  const text = nonEmptyString(candidate?.text);
  if (text == null) return null;
  const summary = condenseSummary(text);
  if (summary == null) return null;
  return buildAsk({
    // `action` and `blocker` both REQUIRE work before the ticket can clear, so the
    // kind is forced rather than inferred — the classifier cannot be trusted to
    // find an act-then-confirm marker in prose like "Action required: rotate the
    // credentials.", and a false "just reply" promise costs the operator a round trip.
    kind:
      candidate.class === "blocker" || candidate.class === "action"
        ? "act-then-confirm"
        : classifyAskText(text),
    summary,
    // Never a chip from prose: it would be a guess at what the agent accepts, and
    // a wrong chip is worse than a free-text box.
    suggestedReplies: [],
    source: "comment",
  });
}

/**
 * Last-resort derivation from a single AGENT comment — what makes the ~handful of
 * tickets parked RIGHT NOW render usefully. `source: "comment"` lets the UI mark it
 * as inferred rather than producer-authored. Returns null when the comment carries
 * no ask at all (a status note, a phase report, a bare pointer).
 */
export function askFromComment(commentBody) {
  return askFromCandidate(classifyAskCandidate(commentBody));
}

// ── choosing WHICH agent comment carries the ask ──────────────────────────────
//
// The newest agent comment is usually the ask — but on a parked ticket it usually
// ISN'T, and the exception is systematic rather than rare. Verified against the
// live inbox (6 parked tickets, 2026-07-30): the newest agent comment was the ask
// on ZERO of them. It was the recovery pass's content-free pointer on five:
//
//     🔼 **recovery-pass** self-heal attempts exhausted on this ticket —
//     escalated to the operator. self-heal attempts exhausted (2 dispatches
//     without a recorded verdict). (See your inbox.)
//
// That is the entire comment, and every clause of it is escalation BOOKKEEPING:
// rendered as the ask it tells the operator only that they are needed — "(See your
// inbox.)" inside the inbox — which they already knew. The informative comment sits
// beneath it:
//
//     **Reason:** Failure reason: rebase_refused_dirty_tree
//
// STRIP, THEN CLASSIFY — the design that replaced a phrase blacklist.
//
// An earlier cut REJECTED any short comment matching a notice phrase. That threw
// away the comment above (it matches "requires human judgment" and "marked for
// human review" and is only 188 chars), left every remaining candidate a phase
// report, and then fell back to `bodies[0]` — the pointer. So the filter meant to
// suppress the pointer is exactly what elected it.
//
// The fix inverts the primitive: those phrases are producer BOILERPLATE to REMOVE,
// not evidence to reject on. Every one of them comes from a template we can name
// (recovery-reasoning.mjs `formatEscalationComment` / the `🔼` escalation comment;
// recovery-emit.mjs's `🔍`/`🔼` notes; the recovery-pass SKILL's `✅`/`🔧` notes), so
// strip the template and classify what the agent actually added:
//
//   ask     — a real request: a question, enumerated options, "reply <x>", or an
//             explicit operator-action block. The operator answers or acts.
//   blocker — a named FAILURE with no question attached ("Failure reason: …",
//             "needs-human VALID: PR #212 CONFLICTING/DIRTY"). The operator must go
//             DO something; no reply resolves it. → act-then-confirm.
//   status  — the pass REPORTING, not asking ("✅ unstuck this", "🔧 is working
//             this", a leave-alone verdict, a phase status report). Never an ask.
//   none    — nothing left after the boilerplate. Never an ask.
//
// Selection is ranked (newest `ask`, else newest `blocker`) and there is NO
// fallback to the newest body. The old `?? bodies[0]` was the "a weak ask beats an
// absent one" rule, and production disproved it: it rendered "✅ recovery-pass
// unstuck this — … now running" under the heading "What this needs from you", and
// told the operator a written answer would resolve a ticket the agent had already
// fixed. Absent is honest; a fabricated ask is not.

/**
 * Producer BOILERPLATE, removed before classifying. Each entry is a template we
 * can point at, not a guess about prose:
 *   1. the `<emoji> **recovery-pass** <verb> —` comment header (recovery-emit.mjs,
 *      recovery-reasoning.mjs, recovery-pass/SKILL.md)
 *   2/3/4. the three fixed lines of recovery-reasoning.mjs::formatEscalationComment
 *   5/6. the escalation trailer ("escalated to the operator", "(See your inbox.)")
 *   7. recovery-reasoning.mjs's escalation-bookkeeping reason — it restates THAT
 *      the escalation happened, which is the one thing the operator already knows
 *   8. recovery-emit.mjs's leave-alone trailer
 * Ordered header-first so the header match still sees the start of the string.
 */
const BOILERPLATE_PATTERNS = [
  /^\s*[^\p{L}\p{N}]*\*{0,2}recovery-pass\*{0,2}\s+[^—\n]*—\s*/u,
  /^[ \t]*#{1,6}[^\n]*Recovery Escalation[ \t]*$/gim,
  /Reasoning pass determined this requires human judgment\.?/gi,
  /This ticket is now marked for human review\.?/gi,
  /escalated to the operator\.?/gi,
  /\(see your inbox\.?\)/gi,
  /self-heal attempts exhausted(?:\s+on this ticket)?\s*(?:\(\s*\d+\s+dispatches?[^)]*\))?\.?/gi,
  /No action needed[^.\n]*\.?/gi,
];

/**
 * Strip the producer's boilerplate and return what the agent actually added, or
 * null when nothing is left (a pure pointer). Exported for direct testing.
 */
export function stripEscalationBoilerplate(body) {
  const s = nonEmptyString(body);
  if (s == null) return null;
  let out = s;
  for (const re of BOILERPLATE_PATTERNS) out = out.replace(re, " ");
  // Removal leaves orphaned punctuation at the EDGES (and the producer's own ".."
  // where two sentences met). Trim only there — a global punctuation squash would
  // rewrite the identifiers this summary exists to show, turning
  // "duplicate_of_CTL-1385" into "duplicate_of_CTL 1385".
  out = out
    .replace(/\.{2,}/g, ".")
    .replace(/^[\s.;,:—–]+/, "")
    .replace(/[\s.;,:—–]+$/, "");
  // Nothing but punctuation left → it was a pure pointer.
  if (!/[\p{L}\p{N}]/u.test(out)) return null;
  return nonEmptyString(out);
}

/**
 * The recovery pass's REPORTING notes, keyed on the verb its own templates use.
 * `is working this` / `unstuck this` / `resolved …` / `reviewed this` all say what
 * the PASS did; none asks the operator for anything.
 */
const RECOVERY_STATUS_HEADER =
  /^\s*[^\p{L}\p{N}]*\*{0,2}recovery-pass\*{0,2}\s+(?:is working this|unstuck this|resolved\b|reviewed this)/u;

/**
 * The one carve-out: `🔍 reviewed this — needs-human VALID: …` is a leave-alone
 * verdict for the PASS but a confirmation for the OPERATOR — it means "I checked,
 * you really are needed, here is why". Its "No action needed; leaving as-is"
 * trailer is about the pass's own next tick, not about the operator, so treating
 * the whole note as status buries the blocker it just named.
 */
// ⛔ CTL-2161: this matches HISTORICAL COMMENT TEXT, not the deleted label. The
// recovery-pass bot wrote "🔍 reviewed this — needs-human VALID: …" into Linear
// comments that still exist and still render in the inbox. Deleting this pattern
// with the label would silently start swallowing those verdicts, which is the one
// case the carve-out exists for. It retires when the comments age out, not now.
const RECOVERY_VERDICT_CONFIRMED = /\bneeds-human VALID\b/i;

/** Is this the recovery pass reporting rather than asking? Exported for testing. */
export function isRecoveryStatusNote(body) {
  const s = nonEmptyString(body);
  if (s == null) return false;
  if (!RECOVERY_STATUS_HEADER.test(s)) return false;
  return !RECOVERY_VERDICT_CONFIRMED.test(s);
}

/**
 * A named FAILURE with no question attached. These come from the escalation
 * templates (`**Reason:**` / `Failure reason:`) and the leave-alone verdict
 * (`needs-human VALID`, `Left for operator`), so they are the producer's words for
 * "here is what is wrong", never a request the operator can answer by replying.
 */
const BLOCKER_MARKERS = [
  /\bfailure reason\s*:/i,
  /\*{2}reason\s*:?\*{2}/i,
  /^\s*reason\s*:/im,
  /\bneeds-human VALID\b/i,
  /\bleft for (?:the )?operator\b/i,
];

/**
 * An explicit operator-directed requirement, wherever it appears — including
 * inside a phase status report, which is where the pipeline actually writes it:
 *
 *     **⚠️ Required pre-merge operator migration (ordering is load-bearing):**
 *     apply `parked-by-human` to SLI-17, confirm it appears in
 *     `details.sanctioned` on BOTH minis' `recovery.board-scan`, then remove …
 *
 * That paragraph is the ticket's own act-then-confirm example, and it was being
 * discarded with the report that carries it. This is prose-shaped rather than
 * template-shaped, so the markers are deliberately narrow — "required"/"must"
 * within one line of "operator", or a literal "action required" — and a miss costs
 * only the honest absence the ask block already renders.
 */
const OPERATOR_ACTION_MARKERS = [
  /\brequired\b[^\n]{0,80}\boperator\b/i,
  /\boperator\b[^\n]{0,80}\b(?:required|must)\b/i,
  /\baction required\b/i,
];

/** The paragraph stating an explicit operator requirement, or null. Returns just
 *  that paragraph — the surrounding report is bookkeeping the operator hasn't been
 *  asked about. Exported for direct testing. */
export function extractOperatorActionBlock(body) {
  const s = nonEmptyString(body);
  if (s == null) return null;
  for (const para of s.split(/\n\s*\n/)) {
    const p = nonEmptyString(para);
    if (p != null && matchesAny(p, OPERATOR_ACTION_MARKERS)) return p;
  }
  return null;
}

/**
 * Markers of a PHASE STATUS REPORT — the per-phase bookkeeping the pipeline posts
 * ("**Phase Implement** · Branch · Commits: 7 · Diff: 29 files changed").
 *
 * These are machine status posts, not questions. They are often the newest
 * substantive agent comment, so without this filter they become the derived ask —
 * and the classifier then reads their imperative bullets as an instruction,
 * producing nonsense like `act-then-confirm: "Phase Implement — Commits: 7"`.
 * Anchored to the leading phase header so ordinary prose that merely mentions a
 * phase is unaffected.
 *
 * The separator is `[\s-]+`, not `\s+`: the phase agents post under BOTH spellings
 * ("**Phase Implement**" and "phase-implement mirror test — see phase summary"),
 * and a whitespace-only separator let the hyphenated one through as an ask
 * candidate — where, being ordinary prose, it outranked nothing but still won on a
 * ticket whose real blocker was an older comment.
 */
const PHASE_REPORT_PATTERNS = [
  // `remediate` included deliberately: phase-remediate posts `**Phase Remediate**`
  // mirrors, and an unavailable field rendering as `?` made them classify as an ASK
  // — putting pipeline bookkeeping under "What this needs from you".
  /^\s*\**\s*phase[\s-]+(?:triage|research|plan|implement|verify|review|remediate|pr|monitor-merge|monitor-deploy|teardown)\b/i,
  /^\s*\**\s*(?:plan|research|implement|verify|review|remediate)[\s-]+phase\s*[—–-]/i,
];

/** Is this body a phase status report rather than an ask? Exported for testing. */
export function isPhaseStatusReport(body) {
  const s = nonEmptyString(body);
  if (s == null) return false;
  return matchesAny(s, PHASE_REPORT_PATTERNS);
}

/**
 * Markers that a comment states a REAL request rather than merely announcing that
 * one exists. A standalone escalation pointer asks nothing and enumerates nothing;
 * an actual ask does one of these.
 */
const SUBSTANTIVE_ASK_MARKERS = [
  /\?/, // a literal question — the strongest signal a decision is being requested
  /\b(?:option|choose|pick|select|either)\b/i,
  /(?:^|\s)(?:A\)|1\))\s/m, // enumerated alternatives
  /\breply\s+(?:with\s+)?["'`]?\w/i, // "reply approve" / "reply done"
];

/** Does this body state an actual ask, beyond announcing that one exists? */
export function hasSubstantiveAsk(body) {
  const s = nonEmptyString(body);
  if (s == null) return false;
  return matchesAny(s, SUBSTANTIVE_ASK_MARKERS);
}

/** What an agent comment can be as an ask candidate, STRONGEST FIRST — the array
 *  order IS the selection ranking (pickAskCandidate walks it). */
export const ASK_CANDIDATE_CLASSES = ["action", "ask", "blocker", "prose", "status", "none"];

/** The prefix of ASK_CANDIDATE_CLASSES that can carry an ask — everything ahead of
 *  the two classes that never can. Sliced rather than re-listed so the ranking has
 *  exactly one definition. */
const USABLE_CANDIDATE_CLASSES = ASK_CANDIDATE_CLASSES.slice(
  0,
  ASK_CANDIDATE_CLASSES.indexOf("status"),
);

/**
 * Classify one agent comment as an ask candidate: `{ class, text }`, where `text`
 * is the informative residue to summarize (null for `status`/`none`).
 *
 * Order is precedence, and each step earns its place:
 *   1. an explicit operator requirement wins ANYWHERE, even inside a status report
 *      — it is the least ambiguous signal a human is being asked for something;
 *   2. the pass's own reporting notes and the phase reports are never asks;
 *   3. strip the boilerplate — nothing left means it was a pure pointer;
 *   4. a question / options / "reply <x>" in the residue is a real `ask`;
 *   5. a named failure with no question is a `blocker` — real work, not a reply;
 *   6. anything else is ordinary `prose`: still the agent's words, and still the
 *      best evidence available on a ticket parked before any producer change — but
 *      ranked BELOW a blocker, because a stray one-liner ("phase-implement mirror
 *      test — see phase summary") must never outrank "PR #212 CONFLICTING/DIRTY".
 */
export function classifyAskCandidate(body) {
  const s = nonEmptyString(body);
  if (s == null) return { class: "none", text: null };

  const actionBlock = extractOperatorActionBlock(s);
  // A distinct class, NOT plain "ask": an operator-action block states work the
  // human must perform, and routing it through the general text classifier yields
  // e.g. `clarify` for "Action required: rotate the credentials." — telling the
  // operator a written reply alone resolves it, which is the single costliest
  // misclassification this module can make.
  if (actionBlock != null) return { class: "action", text: actionBlock };

  if (isRecoveryStatusNote(s) || isPhaseStatusReport(s)) return { class: "status", text: null };

  const residue = stripEscalationBoilerplate(s);
  if (residue == null) return { class: "none", text: null };
  if (hasSubstantiveAsk(residue)) return { class: "ask", text: residue };
  if (matchesAny(residue, BLOCKER_MARKERS)) return { class: "blocker", text: residue };
  return { class: "prose", text: residue };
}

/**
 * Is this body unusable as an ask — a status report, a pass verdict, or a
 * content-free escalation pointer? Exported for direct testing.
 *
 * (Kept under the original name because it has always been the ask-candidate
 * rejection test; the escalation pointer was simply the first non-ask we found.)
 */
export function isEscalationNotice(body) {
  const cls = classifyAskCandidate(body).class;
  return cls === "status" || cls === "none";
}

/**
 * Pick the candidate that best carries the ask, from a NEWEST-FIRST list of agent
 * comment bodies: the newest `ask`, else the newest `blocker`, else the newest
 * `prose`, else null.
 *
 * There is deliberately NO fallback to the newest BODY — see the section header.
 * Ranking by class before recency is what lets a real ask beat a newer pointer and
 * an older blocker beat a newer throwaway line, without ever promoting the
 * pipeline's own bookkeeping to an ask.
 */
export function pickAskCandidate(agentComments) {
  const candidates = (Array.isArray(agentComments) ? agentComments : [])
    .map((b) => classifyAskCandidate(b))
    .filter((c) => c.text != null);
  for (const cls of USABLE_CANDIDATE_CLASSES) {
    const hit = candidates.find((c) => c.class === cls);
    if (hit) return hit;
  }
  return null;
}

/** The BODY TEXT of the best ask candidate (the residue, not the raw comment), or
 *  null when no comment carries one. */
export function pickAskComment(agentComments) {
  return pickAskCandidate(agentComments)?.text ?? null;
}

// ── the public entry point ───────────────────────────────────────────────────

/**
 * Derive the ask summary for a parked ticket, walking the preference chain:
 *   structured `ask` → explanation fields → newest agent comment → null.
 *
 * `explanation` is the CTL-1110 escalation object passed VERBATIM (never through
 * board-data.mjs::deriveExplanation, which projects only the six legacy string
 * fields and would strip both `ask` and `options` — see
 * inbox-conversation.mjs::deriveRichExplanation), optionally extended with an `ask`
 * object. For the comment fallback, prefer `agentComments` (a NEWEST-FIRST list, so
 * the ranked candidate pick can apply); the single `lastAgentComment` remains
 * accepted for callers that have only one body.
 *
 * Returns null when NO source yields usable text — including when every agent
 * comment is a status note or a bare pointer. The pane then renders no ask block at
 * all, which is honest; the alternative it replaced put "✅ recovery-pass unstuck
 * this — now running" under the heading "What this needs from you".
 */
export function deriveAsk({
  explanation = null,
  agentComments = null,
  lastAgentComment = null,
} = {}) {
  const candidate =
    (Array.isArray(agentComments) ? pickAskCandidate(agentComments) : null) ??
    classifyAskCandidate(lastAgentComment);
  return (
    askFromStructured(explanation) ??
    askFromExplanation(explanation) ??
    askFromCandidate(candidate) ??
    null
  );
}
