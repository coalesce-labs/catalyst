// inbox-conversation.test.mjs — CTL-1569: the inbox conversation surface.
//
// Covers the three pure/injectable modules behind the feature:
//   • inbox-ask.mjs      — "what this needs from you" derivation + kind classification
//   • linear-thread.mjs  — replica-only thread read (newest-first, fail-open)
//   • linear-comment.mjs — the operator-authorship gate + the real comment post
//   • reply-ticket.mjs   — orchestration + the restore-the-row failure contract
//
// Every test is offline: no Linear API, no real replica, no worker dir.
// Fixtures use the PROJ prefix per AGENTS.md → Version Control.

import { describe, expect, it } from "bun:test";

import {
  ASK_KINDS,
  askFromComment,
  askFromExplanation,
  askFromStructured,
  classifyAskText,
  condenseSummary,
  deriveAsk,
} from "./inbox-ask.mjs";
import {
  classifyAskCandidate,
  extractOperatorActionBlock,
  isEscalationNotice,
  isPhaseStatusReport,
  isRecoveryStatusNote,
  pickAskCandidate,
  pickAskComment,
  stripEscalationBoilerplate,
} from "./inbox-ask.mjs";
import { normalizeComment, readTicketThread } from "./linear-thread.mjs";
import {
  knownBotUserIds,
  postOperatorComment,
  resolveAuthorIdentity,
  resolveLinearToken,
} from "./linear-comment.mjs";
import { replyToTicket } from "./reply-ticket.mjs";

// ── test doubles ─────────────────────────────────────────────────────────────

/** A fake bun:sqlite-shaped handle over canned rows, keyed by SQL fragment. */
function fakeDb({ comments = [], issue = null, throwOn = null }) {
  return () => ({
    prepare(sql) {
      if (throwOn && sql.includes(throwOn)) {
        throw new Error("database is locked");
      }
      const isIssueQuery = sql.includes("FROM issues");
      return {
        all: (_t, lim) =>
          isIssueQuery ? [] : comments.slice(0, typeof lim === "number" ? lim : comments.length),
        get: () => (isIssueQuery ? issue : comments[0] ?? null),
      };
    },
    run() {},
    close() {},
  });
}

/** A fetch double that dispatches on the GraphQL operation in the body. */
function fakeFetch(handlers) {
  return async (_url, init) => {
    const parsed = JSON.parse(init.body);
    const q = parsed.query;
    const which = q.includes("viewer")
      ? "viewer"
      : q.includes("issue(id:")
        ? "issue"
        : q.includes("commentCreate")
          ? "commentCreate"
          : "unknown";
    const handler = handlers[which];
    if (!handler) throw new Error(`unexpected operation: ${which}`);
    return handler(parsed.variables);
  };
}

const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const HUMAN_VIEWER = jsonRes({
  data: { viewer: { id: "human-uuid", name: "Ryan Rozich", email: "ryan@example.com", isMe: true } },
});
const APP_VIEWER = jsonRes({
  data: { viewer: { id: "bot-uuid", name: "Catalyst Orchestrator", email: null, isMe: false } },
});

// ═══════════════════════════════════════════════════════════════════════════
// inbox-ask.mjs — the ask summary (§1)
// ═══════════════════════════════════════════════════════════════════════════

describe("classifyAskText — the four kinds", () => {
  it("classifies an approve ask (a yes/no is enough)", () => {
    expect(classifyAskText("Approve publishing SDK 0.7.1?")).toBe("approve");
    expect(classifyAskText("Ok to proceed with the merge?")).toBe("approve");
    expect(classifyAskText("I need permission to delete the stale branch.")).toBe("approve");
  });

  it("classifies a decide ask (choose between options)", () => {
    expect(classifyAskText("Which option do you want?")).toBe("decide");
    expect(classifyAskText("Either close it as superseded or keep it for later.")).toBe("decide");
    expect(classifyAskText("Choose between A and B.")).toBe("decide");
  });

  it("classifies an act-then-confirm ask (you must DO something first)", () => {
    expect(
      classifyAskText("Create the parked-by-human label in Linear, then reply done."),
    ).toBe("act-then-confirm");
    expect(classifyAskText("Reply 'done' once you have rotated the token.")).toBe(
      "act-then-confirm",
    );
    expect(classifyAskText("Manually create the missing workflow state.")).toBe(
      "act-then-confirm",
    );
  });

  it("falls back to clarify for unrecognized free text (the honest default)", () => {
    expect(classifyAskText("The findings are ambiguous.")).toBe("clarify");
    expect(classifyAskText("")).toBe("clarify");
    expect(classifyAskText(null)).toBe("clarify");
  });

  it("prefers act-then-confirm over approve when BOTH markers appear", () => {
    // The costly error is telling the operator a bare "yes" suffices when they must
    // first go do something. That precedence is load-bearing, so pin it.
    const text = "Approve the change, then reply done once you have applied the label.";
    expect(classifyAskText(text)).toBe("act-then-confirm");
  });

  it("only ever returns one of the four documented kinds", () => {
    for (const text of ["approve?", "which one", "then reply done", "hmm", "", "  "]) {
      expect(ASK_KINDS).toContain(classifyAskText(text));
    }
  });
});

describe("condenseSummary", () => {
  it("collapses whitespace", () => {
    expect(condenseSummary("a\n\n  b   c")).toBe("a b c");
  });
  it("returns null for empty/absent input (never fabricates)", () => {
    expect(condenseSummary("")).toBeNull();
    expect(condenseSummary("   ")).toBeNull();
    expect(condenseSummary(null)).toBeNull();
  });
  it("truncates long prose with an ellipsis", () => {
    const out = condenseSummary("x".repeat(500), 100);
    expect(out.length).toBe(100);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("askFromStructured — the producer-authored path (preferred)", () => {
  it("uses a complete producer ask verbatim", () => {
    const ask = askFromStructured({
      ask: {
        kind: "approve",
        summary: "Reply approve to publish, or no to hold.",
        suggested_replies: ["approve", "no"],
      },
    });
    expect(ask.kind).toBe("approve");
    expect(ask.summary).toBe("Reply approve to publish, or no to hold.");
    expect(ask.suggestedReplies).toEqual(["approve", "no"]);
    expect(ask.canResolveByReply).toBe(true);
    expect(ask.source).toBe("structured");
  });

  it("accepts the camelCase alias for suggested replies", () => {
    const ask = askFromStructured({
      ask: { kind: "decide", summary: "A or B?", suggestedReplies: ["A", "B"] },
    });
    expect(ask.suggestedReplies).toEqual(["A", "B"]);
  });

  it("treats a HALF-written ask as absent so the derived path can still work", () => {
    expect(askFromStructured({ ask: { kind: "approve" } })).toBeNull(); // no summary
    expect(askFromStructured({ ask: { summary: "hi" } })).toBeNull(); // no kind
    expect(askFromStructured({ ask: { kind: "nonsense", summary: "hi" } })).toBeNull();
  });

  it("returns null when there is no ask object at all", () => {
    expect(askFromStructured(null)).toBeNull();
    expect(askFromStructured({})).toBeNull();
  });

  it("derives canResolveByReply from the kind, never from the producer", () => {
    // An act-then-confirm can NEVER claim reply-alone, even if a producer said so.
    const ask = askFromStructured({
      ask: { kind: "act-then-confirm", summary: "Do the thing, then confirm.", canResolveByReply: true },
    });
    expect(ask.canResolveByReply).toBe(false);
  });
});

describe("askFromExplanation — derived from CTL-1110 fields", () => {
  it("treats 2+ enumerated options as a decision, with the labels as chips", () => {
    const ask = askFromExplanation({
      call_to_action: "Pick how to handle PROJ-17.",
      options: [
        { label: "close as superseded", detail: "drop it" },
        { label: "keep for Preferences", detail: "retain" },
      ],
    });
    expect(ask.kind).toBe("decide");
    expect(ask.suggestedReplies).toEqual(["close as superseded", "keep for Preferences"]);
    expect(ask.canResolveByReply).toBe(true);
    expect(ask.source).toBe("explanation");
  });

  it("classifies the CTA prose when there are no enumerated options", () => {
    const ask = askFromExplanation({ call_to_action: "Approve the rollout?" });
    expect(ask.kind).toBe("approve");
    expect(ask.summary).toBe("Approve the rollout?");
    expect(ask.suggestedReplies).toEqual([]);
  });

  it("reads what_to_do for the act-then-confirm marker the CTA lacks", () => {
    // The "…then reply done" instruction usually lives in what_to_do; missing it
    // would wrongly promise the operator that replying alone is enough.
    const ask = askFromExplanation({
      call_to_action: "The label is missing.",
      what_to_do: "Create the label in Linear, then reply done.",
    });
    expect(ask.kind).toBe("act-then-confirm");
    expect(ask.canResolveByReply).toBe(false);
    // The CTA still leads the summary (shorter, more imperative).
    expect(ask.summary).toBe("The label is missing.");
  });

  it("never invents reply chips from prose", () => {
    const ask = askFromExplanation({ call_to_action: "Reply approve or no." });
    expect(ask.suggestedReplies).toEqual([]);
  });

  it("returns null when the explanation carries no usable text", () => {
    expect(askFromExplanation({ outcome: null, problem: null })).toBeNull();
    expect(askFromExplanation({})).toBeNull();
    expect(askFromExplanation(null)).toBeNull();
  });

  it("does not treat a SINGLE option as a decision", () => {
    const ask = askFromExplanation({
      call_to_action: "Approve this?",
      options: [{ label: "yes" }],
    });
    expect(ask.kind).toBe("approve");
    expect(ask.suggestedReplies).toEqual([]);
  });

  it("honors the producer's DECLARED escalation_type over the prose reading", () => {
    // `escalation_type` is an existing documented tagged union (decision |
    // authorization | manual) — the producer's own word for what it is asking.
    // The live `authorization` escalations read as `clarify` to the text
    // classifier ("free-text answer needed") when the producer said yes/no.
    const cta = "authorize another recovery cycle (clear its ledger latch), or take it over?";
    expect(askFromExplanation({ call_to_action: cta }).kind).toBe("clarify");
    expect(
      askFromExplanation({ call_to_action: cta, escalation_type: "authorization" }).kind,
    ).toBe("approve");
    expect(
      askFromExplanation({ call_to_action: "Pick a lockfile.", escalation_type: "decision" }).kind,
    ).toBe("decide");
  });

  it("ignores `manual` — it is the producer's DEFAULT, not a declaration", () => {
    // Mapping it would turn "unspecified" into a claim about the ask.
    expect(
      askFromExplanation({ call_to_action: "The lockfile is wrong.", escalation_type: "manual" })
        .kind,
    ).toBe("clarify");
  });

  it("lets a classified act-then-confirm OVERRIDE the declared type", () => {
    // The one asymmetry worth hard-coding: honoring `authorization` here would
    // promise the operator that a bare "yes" finishes a manual step.
    const ask = askFromExplanation({
      call_to_action: "The label is missing.",
      what_to_do: "Create the label in Linear, then reply done.",
      escalation_type: "authorization",
    });
    expect(ask.kind).toBe("act-then-confirm");
    expect(ask.canResolveByReply).toBe(false);
  });
});

describe("askFromComment — the last-resort fallback for tickets parked TODAY", () => {
  it("derives kind + summary from the newest agent comment", () => {
    const ask = askFromComment("Which of the 13 findings actually matter?");
    expect(ask.kind).toBe("decide");
    expect(ask.source).toBe("comment");
  });
  it("never produces chips (a guessed chip is worse than none)", () => {
    expect(askFromComment("Reply approve or hold.").suggestedReplies).toEqual([]);
  });
  it("returns null for an empty comment", () => {
    expect(askFromComment("")).toBeNull();
    expect(askFromComment(null)).toBeNull();
  });
  it("returns null for a comment that carries no ask at all", () => {
    expect(askFromComment("✅ **recovery-pass** unstuck this — re-dispatched.")).toBeNull();
    expect(askFromComment("**Phase Implement**\n- **Commits**: 7")).toBeNull();
  });
});

describe("deriveAsk — the preference chain", () => {
  const structured = {
    ask: { kind: "approve", summary: "structured wins", suggested_replies: ["yes"] },
    call_to_action: "explanation loses",
  };

  it("prefers structured over explanation over comment", () => {
    expect(deriveAsk({ explanation: structured }).summary).toBe("structured wins");
    expect(
      deriveAsk({ explanation: { call_to_action: "explanation wins" } }).summary,
    ).toBe("explanation wins");
    expect(
      deriveAsk({ explanation: null, lastAgentComment: "comment wins" }).summary,
    ).toBe("comment wins");
  });

  it("returns null when NO source yields text (the pane renders absent)", () => {
    expect(deriveAsk({})).toBeNull();
    expect(deriveAsk({ explanation: {}, lastAgentComment: "" })).toBeNull();
  });

  it("falls through a half-written structured ask to the explanation fields", () => {
    const ask = deriveAsk({
      explanation: { ask: { kind: "approve" }, call_to_action: "fell through" },
    });
    expect(ask.summary).toBe("fell through");
    expect(ask.source).toBe("explanation");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// linear-thread.mjs — the replica thread read (§2/§3)
// ═══════════════════════════════════════════════════════════════════════════

// ── strip-then-classify: which agent comment carries the ask ─────────────────
//
// Every fixture below is a real production comment body with the ticket keys
// re-keyed to PROJ (AGENTS.md → Version Control). They are the six parked tickets
// the live inbox held on 2026-07-30 — the newest agent comment was the ask on
// NONE of them, which is what this ladder exists to survive.

/** The pointer the recovery pass posts as its final word (recovery-reasoning.mjs).
 *  Every clause is escalation bookkeeping; rendered as the ask it tells the
 *  operator to "see your inbox" while they are looking at their inbox. */
const POINTER =
  "🔼 **recovery-pass** self-heal attempts exhausted on this ticket — escalated to " +
  "the operator. self-heal attempts exhausted (2 dispatches without a recorded " +
  "verdict). (See your inbox.)";

/** recovery-reasoning.mjs::formatEscalationComment — the comment that names the
 *  REAL blocker, and the one a phrase blacklist discarded (it matches both
 *  "requires human judgment" and "marked for human review", at 188 chars). */
const ESCALATION_WITH_REASON =
  "## PROJ-1176 Recovery Escalation\n\n" +
  "Reasoning pass determined this requires human judgment.\n\n" +
  "**Reason:** Failure reason: rebase_refused_dirty_tree\n\n" +
  "This ticket is now marked for human review.";

describe("stripEscalationBoilerplate", () => {
  it("reduces the pure pointer to nothing", () => {
    expect(stripEscalationBoilerplate(POINTER)).toBeNull();
  });

  it("keeps the REASON when it strips the escalation template around it", () => {
    // The whole point of strip-then-classify: the phrases are boilerplate to
    // REMOVE, not evidence to reject the comment on.
    expect(stripEscalationBoilerplate(ESCALATION_WITH_REASON)).toBe(
      "**Reason:** Failure reason: rebase_refused_dirty_tree",
    );
  });

  it("never rewrites identifiers while trimming orphaned punctuation", () => {
    // A global punctuation squash turned "duplicate_of_PROJ-1385" into
    // "duplicate_of_PROJ 1385" — the summary exists to show exactly that string.
    const residue = stripEscalationBoilerplate(
      "## PROJ-1176 Recovery Escalation\n\n**Reason:** Failure reason: " +
        "duplicate_of_PROJ-1385:fix_already_merged_no_code_change\n\n" +
        "This ticket is now marked for human review.",
    );
    expect(residue).toContain("duplicate_of_PROJ-1385:fix_already_merged_no_code_change");
  });

  it("leaves a comment with no boilerplate untouched", () => {
    expect(stripEscalationBoilerplate("Which of the 13 findings actually matter?")).toBe(
      "Which of the 13 findings actually matter?",
    );
  });
});

describe("isRecoveryStatusNote", () => {
  it("recognizes the pass REPORTING rather than asking", () => {
    expect(
      isRecoveryStatusNote(
        "✅ **recovery-pass** unstuck this — the 29-day Triage stall was a gen-1 " +
          "triage worker that hit its turn cap. Re-dispatched triage → now running.",
      ),
    ).toBe(true);
    expect(
      isRecoveryStatusNote("🔧 **recovery-pass** is working this — triage completed 29 days ago."),
    ).toBe(true);
    expect(
      isRecoveryStatusNote(
        "🔍 **recovery-pass** reviewed this — PROJ-63 is healthy and progressing. " +
          "No action needed on the ticket.. No action needed; leaving as-is (re-checks).",
      ),
    ).toBe(true);
  });

  it("does NOT swallow the `needs-human VALID` verdict — it names a blocker", () => {
    // "No action needed; leaving as-is" is about the PASS's next tick, not the
    // operator's. Treating the whole note as status buries the blocker it names.
    expect(
      isRecoveryStatusNote(
        "🔍 **recovery-pass** reviewed this — needs-human VALID: PR #212 " +
          "CONFLICTING/DIRTY + 2 codex P2 findings. Left for operator.. " +
          "No action needed; leaving as-is (re-checks).",
      ),
    ).toBe(false);
  });

  it("ignores comments that are not recovery-pass notes at all", () => {
    expect(isRecoveryStatusNote("Which of the 13 findings actually matter?")).toBe(false);
  });
});

describe("extractOperatorActionBlock", () => {
  it("lifts the operator requirement out of the phase report carrying it", () => {
    // The ticket's own act-then-confirm example, and it lives INSIDE a phase
    // status report — the report is bookkeeping, that paragraph is the ask.
    const report =
      "**Phase Implement**\n\n- **Commits**: 7\n\n" +
      "Implemented the 6-phase plan. All grep-gates clean.\n\n" +
      "**⚠️ Required pre-merge operator migration (ordering is load-bearing):** " +
      "apply `parked-by-human` to PROJ-17, confirm it appears in " +
      "`details.sanctioned` on BOTH hosts, then remove PROJ-17 from the host env.";
    expect(extractOperatorActionBlock(report)).toStartWith(
      "**⚠️ Required pre-merge operator migration",
    );
  });

  it("returns null for a report with no operator requirement", () => {
    expect(
      extractOperatorActionBlock("**Phase Verify**\n\n- **Result**: PASS\n- **Findings**: 4"),
    ).toBeNull();
  });
});

describe("classifyAskCandidate", () => {
  it("classes the content-free pointer as `none`", () => {
    expect(classifyAskCandidate(POINTER)).toEqual({ class: "none", text: null });
  });

  it("classes a phase status report and a pass verdict as `status`", () => {
    // Machine bookkeeping posts. Left in, the classifier reads their imperative
    // bullets as instructions and emits nonsense like
    // `act-then-confirm: "Phase Implement — Commits: 7"`.
    const report = "**Phase Implement**\n- **Branch**: `PROJ-1`\n- **Commits**: 7";
    expect(classifyAskCandidate(report).class).toBe("status");
    expect(classifyAskCandidate("phase-implement mirror test — see phase summary").class).toBe(
      "status",
    );
    expect(classifyAskCandidate("✅ **recovery-pass** unstuck this — re-dispatched.").class).toBe(
      "status",
    );
  });

  it("classes a named failure with no question as a `blocker`", () => {
    expect(classifyAskCandidate(ESCALATION_WITH_REASON).class).toBe("blocker");
    expect(
      classifyAskCandidate(
        "🔍 **recovery-pass** reviewed this — needs-human VALID: PR #212 " +
          "CONFLICTING/DIRTY + 2 codex P2 findings. Left for operator.",
      ).class,
    ).toBe("blocker");
  });

  it("classes a question / options / reply-with as an `ask`", () => {
    expect(classifyAskCandidate("Which of the 13 findings actually matter?").class).toBe("ask");
    expect(classifyAskCandidate("Reply approve to publish, or no to hold.").class).toBe("ask");
  });

  it("classes ordinary agent prose as `prose` — real, but the weakest candidate", () => {
    expect(classifyAskCandidate("The lockfile situation needs a human eye.").class).toBe("prose");
  });

  it("keeps isEscalationNotice as the rejection test over the same ladder", () => {
    expect(isEscalationNotice(POINTER)).toBe(true);
    expect(isEscalationNotice("**Phase Implement**\n- **Commits**: 7")).toBe(true);
    expect(isEscalationNotice(ESCALATION_WITH_REASON)).toBe(false);
    // Prose that merely mentions a phase is not a report.
    const prose = "The implement phase needs a decision about which lockfile to keep.";
    expect(isPhaseStatusReport(prose)).toBe(false);
    expect(isEscalationNotice(prose)).toBe(false);
  });
});

describe("pickAskCandidate / pickAskComment — ranked, never `bodies[0]`", () => {
  it("prefers a real question over a phase report, even a newer one", () => {
    expect(
      pickAskComment([
        "**Phase Verify**\n- **Result**: PASS\n- **Findings**: 4",
        "Which of the 13 findings actually matter?",
      ]),
    ).toBe("Which of the 13 findings actually matter?");
  });

  it("picks the older BLOCKER over the newer pointer that hid it", () => {
    // The exact production shape: the pointer is newest, every phase report is
    // rejected, and the reason sits two comments down.
    const picked = pickAskCandidate([
      POINTER,
      "**Phase Review**\n- **Result**: PASS",
      ESCALATION_WITH_REASON,
    ]);
    expect(picked.class).toBe("blocker");
    expect(picked.text).toBe("**Reason:** Failure reason: rebase_refused_dirty_tree");
  });

  it("ranks a blocker ABOVE a newer throwaway prose line", () => {
    const picked = pickAskCandidate([
      "mirror test — see summary",
      "**Reason:** Failure reason: rebase_refused_dirty_tree",
    ]);
    expect(picked.class).toBe("blocker");
  });

  it("returns NULL when every comment is a status note or a pointer", () => {
    // The defect this replaced fell back to `bodies[0]` here, which put
    // "✅ recovery-pass unstuck this — now running" under the heading
    // "What this needs from you" and claimed a written answer would resolve it.
    expect(
      pickAskComment([
        POINTER,
        "✅ **recovery-pass** unstuck this — re-dispatched triage → now running.",
        "🔧 **recovery-pass** is working this — re-dispatching triage.",
        "**Phase Plan**\n- **Phases**: 3",
      ]),
    ).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickAskComment([])).toBeNull();
    expect(pickAskComment(null)).toBeNull();
  });
});

describe("deriveAsk over real parked-ticket threads", () => {
  it("skips the pointer and renders the question", () => {
    const ask = deriveAsk({
      agentComments: [POINTER, "Which of the 13 findings actually matter?"],
    });
    expect(ask.summary).toBe("Which of the 13 findings actually matter?");
    expect(ask.kind).toBe("decide");
  });

  it("renders a BLOCKER as act-then-confirm, never as `clarify`", () => {
    // `clarify` renders "a written answer resolves this; there is no default" —
    // false on a ticket blocked by a dirty tree, and the expensive direction of
    // the error (the operator types a reply and nothing clears).
    const ask = deriveAsk({ agentComments: [POINTER, ESCALATION_WITH_REASON] });
    expect(ask.kind).toBe("act-then-confirm");
    expect(ask.canResolveByReply).toBe(false);
    expect(ask.summary).toBe("**Reason:** Failure reason: rebase_refused_dirty_tree");
  });

  it("renders NO ask when the agent only reported progress", () => {
    // The agent said it fixed the ticket and re-dispatched. Demanding an answer
    // there states the opposite of the truth; absence is honest.
    expect(
      deriveAsk({
        agentComments: [
          POINTER,
          "✅ **recovery-pass** unstuck this — re-dispatched triage → now running.",
        ],
      }),
    ).toBeNull();
  });

  it("lifts an operator requirement out of a phase report as act-then-confirm", () => {
    const ask = deriveAsk({
      agentComments: [
        POINTER,
        "**Phase Implement**\n\n- **Commits**: 7\n\n" +
          "**⚠️ Required pre-merge operator migration:** apply `parked-by-human` to " +
          "PROJ-17, confirm it on BOTH hosts, then remove PROJ-17 from the host env.",
      ],
    });
    expect(ask.kind).toBe("act-then-confirm");
    expect(ask.canResolveByReply).toBe(false);
    expect(ask.summary).toContain("apply `parked-by-human` to PROJ-17");
  });
});

describe("normalizeComment", () => {
  it("maps is_bot 1 to isAgent true", () => {
    expect(normalizeComment({ id: "c1", body: "x", is_bot: 1 }).isAgent).toBe(true);
  });

  it("treats a CATALYST APP ACTOR as the agent even though is_bot is 0", () => {
    // The load-bearing case: Linear models an app actor as a user, so the agent's
    // own comments arrive with is_bot=0. Classifying them as human would render
    // every agent question as if the operator had written it.
    const row = { id: "c1", body: "x", is_bot: 0, author_id: "bot-uuid", author_name: "Catalyst" };
    expect(normalizeComment(row).isAgent).toBe(false); // no ids configured → is_bot only
    expect(normalizeComment(row, { botUserIds: new Set(["bot-uuid"]) }).isAgent).toBe(true);
  });

  it("classes GitHub/Linear plumbing as INTEGRATION, never as the Catalyst agent", () => {
    // The defect this prevents, seen live: GitHub's "this thread is synced to a
    // corresponding GitHub issue" notice was treated as the agent, so it became
    // the derived ask — the inbox told the operator a sync notice was the question.
    const gh = normalizeComment({ id: "c1", body: "synced to a GitHub issue", is_bot: 1, author_id: null, author_name: "GitHub" });
    expect(gh.isIntegration).toBe(true);
    expect(gh.isCatalystAgent).toBe(false);
    expect(gh.isAgent).toBe(true); // not the operator → still styled as "not you"
  });

  it("classes a Catalyst app actor as the agent, and NOT as integration", () => {
    const c = normalizeComment(
      { id: "c1", body: "x", is_bot: 0, author_id: "bot-uuid", author_name: "Catalyst" },
      { botUserIds: new Set(["bot-uuid"]) },
    );
    expect(c.isCatalystAgent).toBe(true);
    expect(c.isIntegration).toBe(false);
  });

  it("keeps a real human human even when bot ids are configured", () => {
    const row = { id: "c2", body: "x", is_bot: 0, author_id: "human-uuid" };
    expect(normalizeComment(row, { botUserIds: new Set(["bot-uuid"]) }).isAgent).toBe(false);
  });

  it("treats a null is_bot as human (the conservative display split)", () => {
    expect(normalizeComment({ id: "c1", body: "x", is_bot: null }).isAgent).toBe(false);
  });
  it("flags a long body as truncated so the UI can clamp it", () => {
    expect(normalizeComment({ id: "c1", body: "x".repeat(900) }).truncated).toBe(true);
    expect(normalizeComment({ id: "c1", body: "short" }).truncated).toBe(false);
  });
  it("omits a timestamp rather than fabricating one", () => {
    expect(normalizeComment({ id: "c1", body: "x" }).at).toBeNull();
    expect(normalizeComment({ id: "c1", body: "x", created_at: 42 }).at).toBe(42);
  });
  it("drops a row with no id", () => {
    expect(normalizeComment({ body: "x" })).toBeNull();
    expect(normalizeComment(null)).toBeNull();
  });
});

describe("readTicketThread", () => {
  it("returns the thread and lifts the newest AGENT comment", async () => {
    // Rows arrive newest-first from SQL; the newest agent entry is the ask.
    const out = await readTicketThread("PROJ-1", {
      openDb: fakeDb({
        comments: [
          // A Catalyst app actor: is_bot=0 with a configured botUserId. That is
          // how the real agent's comments actually arrive.
          { id: "c3", body: "agent asks the question", is_bot: 0, author_id: "bot-uuid", updated_at: 300 },
          { id: "c2", body: "human replied earlier", is_bot: 0, author_id: "human-uuid", updated_at: 200 },
          { id: "c1", body: "older agent note", is_bot: 0, author_id: "bot-uuid", updated_at: 100 },
        ],
        issue: { identifier: "PROJ-1", title: "T", url: "https://linear.app/x/PROJ-1" },
      }),
      botUserIds: new Set(["bot-uuid"]),
    });
    expect(out.available).toBe(true);
    expect(out.comments.map((c) => c.id)).toEqual(["c3", "c2", "c1"]);
    expect(out.lastAgentComment).toBe("agent asks the question");
    // LIVE candidates stop at the operator's last reply (c2): the older agent note
    // below it was already answered, so it must not be re-surfaced as an ask.
    expect(out.agentComments).toEqual(["agent asks the question"]);
    // The unbounded history is still available.
    expect(out.allAgentComments).toEqual(["agent asks the question", "older agent note"]);
    expect(out.url).toBe("https://linear.app/x/PROJ-1");
  });

  it("EXCLUDES integration plumbing from the ask candidates but keeps it in the thread", async () => {
    const out = await readTicketThread("PROJ-1", {
      openDb: fakeDb({
        comments: [
          { id: "c2", body: "synced to a GitHub issue", is_bot: 1, author_id: null, author_name: "GitHub", updated_at: 200 },
          { id: "c1", body: "Approve the rollout?", is_bot: 0, author_id: "bot-uuid", author_name: "Catalyst", updated_at: 100 },
        ],
        issue: { url: "u" },
      }),
      botUserIds: new Set(["bot-uuid"]),
    });
    // Both render in the thread (context is preserved) …
    expect(out.comments).toHaveLength(2);
    // … but only the Catalyst agent's words are ask candidates.
    expect(out.agentComments).toEqual(["Approve the rollout?"]);
    expect(out.lastAgentComment).toBe("Approve the rollout?");
  });

  it("distinguishes a GENUINELY EMPTY thread from an UNREADABLE one", async () => {
    const emptyThread = await readTicketThread("PROJ-2", {
      openDb: fakeDb({ comments: [], issue: { url: "u" } }),
    });
    expect(emptyThread.available).toBe(true);
    expect(emptyThread.comments).toEqual([]);
    expect(emptyThread.reason).toBeNull();

    const broken = await readTicketThread("PROJ-2", {
      openDb: fakeDb({ throwOn: "FROM comments" }),
    });
    expect(broken.available).toBe(false);
    expect(broken.reason).toContain("replica-error");
  });

  it("fails OPEN — a locked/absent replica never throws into a request", async () => {
    const out = await readTicketThread("PROJ-3", {
      openDb: () => {
        throw new Error("unable to open database file");
      },
    });
    expect(out.available).toBe(false);
    expect(out.comments).toEqual([]);
    expect(out.lastAgentComment).toBeNull();
  });

  it("rejects an absent ticket without opening anything", async () => {
    const out = await readTicketThread("", {
      openDb: () => {
        throw new Error("should not have opened");
      },
    });
    expect(out.reason).toBe("no-ticket");
  });

  it("reports null url when the issue row is absent (a synthesized row)", async () => {
    const out = await readTicketThread("PROJ-4", {
      openDb: fakeDb({ comments: [], issue: null }),
    });
    expect(out.available).toBe(true);
    expect(out.url).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// linear-comment.mjs — the authorship gate (§4, the ships-inert risk)
// ═══════════════════════════════════════════════════════════════════════════

describe("resolveLinearToken", () => {
  it("prefers LINEAR_API_TOKEN, falls back to LINEAR_API_KEY", () => {
    expect(resolveLinearToken({ LINEAR_API_TOKEN: "a", LINEAR_API_KEY: "b" })).toBe("a");
    expect(resolveLinearToken({ LINEAR_API_KEY: "b" })).toBe("b");
    expect(resolveLinearToken({})).toBeNull();
    expect(resolveLinearToken({ LINEAR_API_TOKEN: "   " })).toBeNull();
  });
});

describe("knownBotUserIds", () => {
  it("collects every configured app-actor id", () => {
    const ids = knownBotUserIds({
      config: {
        catalyst: {
          linear: {
            bot: { orchestrator: { botUserId: "orch-id" }, worker: { botUserId: "worker-id" } },
          },
        },
      },
    });
    expect([...ids].sort()).toEqual(["orch-id", "worker-id"]);
  });
  it("returns an empty set when config is absent (the viewer check still guards)", () => {
    expect(knownBotUserIds({}).size).toBe(0);
    expect(knownBotUserIds({ config: {} }).size).toBe(0);
  });
});

describe("resolveAuthorIdentity", () => {
  it("identifies a human personal key as NOT a bot", async () => {
    const id = await resolveAuthorIdentity(
      { token: "lin_api_x" },
      { fetchImpl: fakeFetch({ viewer: () => HUMAN_VIEWER }) },
    );
    expect(id.ok).toBe(true);
    expect(id.isBot).toBe(false);
    expect(id.email).toBe("ryan@example.com");
  });

  it("flags an app-actor token by SHAPE (no email + isMe false)", async () => {
    const id = await resolveAuthorIdentity(
      { token: "lin_oauth_x" },
      { fetchImpl: fakeFetch({ viewer: () => APP_VIEWER }) },
    );
    expect(id.isBot).toBe(true);
  });

  it("flags a token whose id matches a configured botUserId", async () => {
    // Belt-and-braces: even a user-LOOKING viewer is caught by the id list.
    const id = await resolveAuthorIdentity(
      { token: "t", botUserIds: new Set(["human-uuid"]) },
      { fetchImpl: fakeFetch({ viewer: () => HUMAN_VIEWER }) },
    );
    expect(id.isBot).toBe(true);
  });

  it("surfaces a transport failure instead of guessing", async () => {
    const id = await resolveAuthorIdentity(
      { token: "t" },
      {
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
    );
    expect(id.ok).toBe(false);
    expect(id.error).toContain("ECONNREFUSED");
  });

  it("treats an HTTP 200 with a GraphQL errors array as a failure", async () => {
    // Linear returns 200 + errors on schema drift; a 200 alone is not success.
    const id = await resolveAuthorIdentity(
      { token: "t" },
      { fetchImpl: fakeFetch({ viewer: () => jsonRes({ errors: [{ message: "bad field" }] }) }) },
    );
    expect(id.ok).toBe(false);
    expect(id.error).toContain("bad field");
  });
});

describe("postOperatorComment", () => {
  const happyFetch = fakeFetch({
    viewer: () => HUMAN_VIEWER,
    issue: () => jsonRes({ data: { issue: { id: "issue-uuid", identifier: "PROJ-9" } } }),
    commentCreate: () =>
      jsonRes({
        data: {
          commentCreate: {
            success: true,
            comment: {
              id: "comment-uuid",
              createdAt: "2026-07-30T12:00:00Z",
              user: { id: "human-uuid", name: "Ryan Rozich", email: "ryan@example.com" },
            },
          },
        },
      }),
  });

  it("posts as the operator and reports the SERVER-recorded author", async () => {
    const out = await postOperatorComment(
      { ticket: "PROJ-9", body: "approve" },
      { fetchImpl: happyFetch, env: { LINEAR_API_TOKEN: "lin_api_x" } },
    );
    expect(out.status).toBe("posted");
    expect(out.commentId).toBe("comment-uuid");
    expect(out.author).toEqual({ id: "human-uuid", name: "Ryan Rozich" });
  });

  it("REFUSES to post as an app actor, and posts NOTHING", async () => {
    // The whole point: an app-actor reply is ignored by CTL-1567, so it must never
    // be sent and must never look like success.
    let mutated = false;
    const out = await postOperatorComment(
      { ticket: "PROJ-9", body: "approve" },
      {
        fetchImpl: fakeFetch({
          viewer: () => APP_VIEWER,
          commentCreate: () => {
            mutated = true;
            return jsonRes({ data: { commentCreate: { success: true } } });
          },
        }),
        env: { LINEAR_API_TOKEN: "lin_oauth_x" },
      },
    );
    expect(out.status).toBe("bot_identity");
    expect(mutated).toBe(false);
    expect(out.message).toContain("app actor");
  });

  it("rejects an empty body without any network call", async () => {
    const out = await postOperatorComment(
      { ticket: "PROJ-9", body: "   " },
      {
        fetchImpl: () => {
          throw new Error("should not fetch");
        },
        env: { LINEAR_API_TOKEN: "x" },
      },
    );
    expect(out.status).toBe("empty_body");
  });

  it("reports no_token when the node has no Linear credential", async () => {
    const out = await postOperatorComment({ ticket: "PROJ-9", body: "hi" }, { env: {} });
    expect(out.status).toBe("no_token");
  });

  it("reports not_found for an unknown issue (e.g. a synthesized row)", async () => {
    const out = await postOperatorComment(
      { ticket: "PROJ-404", body: "hi" },
      {
        fetchImpl: fakeFetch({
          viewer: () => HUMAN_VIEWER,
          issue: () => jsonRes({ data: { issue: null } }),
        }),
        env: { LINEAR_API_TOKEN: "lin_api_x" },
      },
    );
    expect(out.status).toBe("not_found");
  });

  it("never reports success when the mutation does not confirm it", async () => {
    const out = await postOperatorComment(
      { ticket: "PROJ-9", body: "hi" },
      {
        fetchImpl: fakeFetch({
          viewer: () => HUMAN_VIEWER,
          issue: () => jsonRes({ data: { issue: { id: "i" } } }),
          commentCreate: () => jsonRes({ data: { commentCreate: { success: false } } }),
        }),
        env: { LINEAR_API_TOKEN: "lin_api_x" },
      },
    );
    expect(out.status).toBe("error");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// reply-ticket.mjs — orchestration + the restore-the-row contract (§4)
// ═══════════════════════════════════════════════════════════════════════════

describe("replyToTicket", () => {
  const posted = { status: "posted", commentId: "c1", author: { id: "h", name: "Ryan" } };

  it("succeeds for a ticket with NO worker dir (the case this feature exists for)", async () => {
    // findHeldRun throwing/returning null must NOT fail the reply — the parked
    // tickets that most need answering have no worker dir at all.
    const out = await replyToTicket(
      { ticket: "PROJ-63", body: "yes, go ahead" },
      {
        post: async () => posted,
        findHeld: () => null,
        record: () => {
          throw new Error("must not record without a phase");
        },
        clearMarker: () => [],
      },
    );
    expect(out.status).toBe("replied");
    expect(out.phase).toBeNull();
    expect(out.commentId).toBe("c1");
  });

  it("records the response next to the phase signal when a held run DOES exist", async () => {
    const recorded = [];
    const out = await replyToTicket(
      { ticket: "PROJ-7", body: "option B" },
      {
        post: async () => posted,
        findHeld: () => ({ phase: "implement", signal: {} }),
        record: (a) => recorded.push(a),
        clearMarker: () => [],
      },
    );
    expect(out.phase).toBe("implement");
    expect(recorded[0]).toMatchObject({ ticket: "PROJ-7", phase: "implement", response: "option B" });
  });

  it("does NOT mutate local state when the post fails (row is restored)", async () => {
    let touched = false;
    const out = await replyToTicket(
      { ticket: "PROJ-7", body: "hi" },
      {
        post: async () => ({ status: "error", message: "boom" }),
        findHeld: () => ({ phase: "implement", signal: {} }),
        record: () => {
          touched = true;
        },
        clearMarker: () => {
          touched = true;
        },
      },
    );
    expect(out.status).toBe("error");
    expect(touched).toBe(false);
  });

  it("passes a bot-identity refusal through verbatim (never a false success)", async () => {
    const out = await replyToTicket(
      { ticket: "PROJ-7", body: "hi" },
      { post: async () => ({ status: "bot_identity", message: "app actor" }) },
    );
    expect(out.status).toBe("bot_identity");
    expect(out.ticket).toBe("PROJ-7");
  });

  it("rejects an empty reply before calling Linear", async () => {
    const out = await replyToTicket(
      { ticket: "PROJ-7", body: "   " },
      {
        post: async () => {
          throw new Error("should not post");
        },
      },
    );
    expect(out.status).toBe("empty_body");
  });

  it("survives best-effort local hygiene throwing after a successful post", async () => {
    // A post that landed must never be reported as failed because a local
    // breadcrumb write threw — the comment is already live in Linear.
    const out = await replyToTicket(
      { ticket: "PROJ-7", body: "hi" },
      {
        post: async () => posted,
        findHeld: () => {
          throw new Error("unreadable worker dir");
        },
        clearMarker: () => {
          throw new Error("permission denied");
        },
      },
    );
    expect(out.status).toBe("replied");
  });
});

// ── Codex round-3 remediation ────────────────────────────────────────────────

describe("round-3 P2 — an operator-action block always requires action", () => {
  it("classifies an explicit action block as `action`, not plain `ask`", async () => {
    const { classifyAskCandidate } = await import("./inbox-ask.mjs");
    expect(classifyAskCandidate("Action required: rotate the credentials.").class).toBe("action");
  });

  it("forces act-then-confirm, so the UI never promises a reply alone suffices", async () => {
    const { deriveAsk: derive } = await import("./inbox-ask.mjs");
    // The general classifier would call this `clarify` (no act-then-confirm marker),
    // telling the operator a written reply resolves it — the costliest error here.
    const ask = derive({ agentComments: ["Action required: rotate the credentials."] });
    expect(ask.kind).toBe("act-then-confirm");
    expect(ask.canResolveByReply).toBe(false);
  });

  it("still ranks an action block above ordinary prose", async () => {
    const { pickAskCandidate } = await import("./inbox-ask.mjs");
    const picked = pickAskCandidate([
      "just some prose about the phase",
      "Action required: rotate the credentials.",
    ]);
    expect(picked.class).toBe("action");
  });
});

describe("round-3 P2 — the ask is found beyond the DISPLAY window", () => {
  it("scans deeper than the display limit for the agent's question", async () => {
    // INTEGRATION chatter must not hide the agent's ask. (Human replies are a
    // different case entirely — they mark the question ANSWERED, and the
    // answered-turn boundary deliberately drops it.)
    const humans = Array.from({ length: 8 }, (_, i) => ({
      id: `g${i}`, body: `synced to a GitHub issue ${i}`, is_bot: 1, author_id: null,
      author_name: "GitHub", updated_at: 1000 - i,
    }));
    const agent = {
      id: "a1", body: "Which of the 13 findings actually matter?",
      is_bot: 0, author_id: "bot-uuid", updated_at: 100,
    };
    const out = await readTicketThread("PROJ-1", {
      limit: 4,
      botUserIds: new Set(["bot-uuid"]),
      openDb: fakeDb({ comments: [...humans, agent], issue: { url: "u" } }),
    });
    // Only the display slice is rendered …
    expect(out.comments).toHaveLength(4);
    // … but the agent's question, outside that window, still drives the ask.
    expect(out.agentComments).toEqual(["Which of the 13 findings actually matter?"]);
  });
});

// ── Codex round-4 remediation ────────────────────────────────────────────────

describe("round-4 — the answered-turn boundary", () => {
  it("never re-surfaces a question the operator already answered", async () => {
    const { readTicketThread: read } = await import("./linear-thread.mjs");
    const db = () => ({
      prepare: (sql) => ({
        all: () =>
          sql.includes("FROM issues")
            ? []
            : [
                { id: "a2", body: "Failure reason: rebase_refused_dirty_tree", is_bot: 0, author_id: "bot", updated_at: 300 },
                { id: "h1", body: "yes go ahead", is_bot: 0, author_id: "human", updated_at: 200 },
                { id: "a1", body: "Approve the rollout?", is_bot: 0, author_id: "bot", updated_at: 100 },
              ],
        get: () => (sql.includes("FROM issues") ? { url: "u" } : null),
      }),
      run() {},
      close() {},
    });
    const out = await read("PROJ-1", { openDb: db, botUserIds: new Set(["bot"]) });
    // Class-first ranking would otherwise let the older APPROVAL question outrank
    // the newer blocker, prompting the operator to re-answer the previous cycle.
    expect(out.agentComments).toEqual(["Failure reason: rebase_refused_dirty_tree"]);
    expect(out.allAgentComments).toHaveLength(2);
  });

  it("treats every agent comment as live when the operator has never replied", async () => {
    const { readTicketThread: read } = await import("./linear-thread.mjs");
    const db = () => ({
      prepare: (sql) => ({
        all: () =>
          sql.includes("FROM issues")
            ? []
            : [
                { id: "a2", body: "newer agent", is_bot: 0, author_id: "bot", updated_at: 200 },
                { id: "a1", body: "older agent", is_bot: 0, author_id: "bot", updated_at: 100 },
              ],
        get: () => (sql.includes("FROM issues") ? { url: "u" } : null),
      }),
      run() {},
      close() {},
    });
    const out = await read("PROJ-1", { openDb: db, botUserIds: new Set(["bot"]) });
    expect(out.agentComments).toEqual(["newer agent", "older agent"]);
  });
});

describe("round-4 — a validated manual escalation requires action", () => {
  it("forces act-then-confirm for a validated manual payload", async () => {
    const { deriveAsk: d } = await import("./inbox-ask.mjs");
    const ask = d({
      explanation: {
        escalation_type: "manual",
        call_to_action: "Rotate the expired API credential.",
        instructions: "open the console and rotate it",
      },
    });
    expect(ask.kind).toBe("act-then-confirm");
    expect(ask.canResolveByReply).toBe(false);
  });

  it("does NOT force it for a legacy payload that merely defaulted to manual", async () => {
    const { deriveAsk: d } = await import("./inbox-ask.mjs");
    expect(
      d({ explanation: { escalation_type: "manual", call_to_action: "Approve the rollout?" } }).kind,
    ).not.toBe("act-then-confirm");
  });
});

describe("round-4 — phase-remediate mirrors are status reports", () => {
  it("filters the remediate mirror out of ask candidates", async () => {
    const { isPhaseStatusReport: isRep } = await import("./inbox-ask.mjs");
    expect(isRep("**Phase Remediate**\n- **Commits**: ?")).toBe(true);
    expect(isRep("**Remediate phase — disposition: fixed**")).toBe(true);
  });
});
