// reading-pane-model.test.ts — units for the HOME4 reading-pane PURE core
// (CTL-902): the hero "What's needed now" kind + ask, the decision options, the
// blocker detail, the About block, the tint accent, and the View-in-Claude deep
// link. Encodes the four CTL-902 Gherkin scenarios against the React-free module
// ui/src/board/reading-pane-model.ts (same pattern as home-inbox.test.ts — no
// React/jotai/router runtime needed).
//
// The load-bearing acceptance criteria these lock in:
//   • "reading pane shows what's needed now for a decision" → heroKindFor is
//     "decision", askFor is the full ask, optionsFor is label+trade-off pairs,
//     aboutBlockFor carries summary + goal + the phase-strip read.
//   • "reading pane shows the blocker for a blocked item" → heroKindFor is
//     "blocked" and blockerFor is the plain-language blocker (no options).
//   • "View in Claude deep-links to the agent's session" → viewInClaudeFor builds
//     https://claude.ai/code/<sessionId> from the matching worker, and is null
//     (action hidden) when no session id is available.
//   • "context emphasis uses tint, never a nested card" → accentFor is amber/red
//     for the needs-you sets and never any other (notably never cyan) value.
import { describe, it, expect } from "bun:test";
import {
  viewInClaudeFor,
  heroKindFor,
  askFor,
  optionsFor,
  blockerFor,
  accentFor,
  aboutBlockFor,
  escalationExplanationFor,
} from "../ui/src/board/reading-pane-model";
import { deriveInbox, type InboxRow } from "../ui/src/board/home-inbox";
import type { BoardPayload, BoardTicket, BoardWorker, DecisionOption } from "../ui/src/board/types";

// ── fixtures (only the fields the pane derivation reads) ────────────────────
function mkTicket(id: string, over: Partial<BoardTicket> = {}): BoardTicket {
  return {
    id,
    title: `${id} title`,
    type: "feature",
    repo: "catalyst",
    team: "CTL",
    phase: "implement",
    status: "active",
    model: null,
    linearState: "Implement",
    workerStatus: null,
    activeState: "active",
    working: true,
    lastActiveMs: null,
    priority: 2,
    estimate: null,
    scope: null,
    project: null,
    costUSD: null,
    tokens: null,
    turns: null,
    phaseCosts: null,
    phaseSummary: [],
    pr: null,
    updatedAt: "",
    held: null,
    blockers: [],
    ...over,
  };
}

function mkWorker(over: Partial<BoardWorker> = {}): BoardWorker {
  return {
    name: "worker-1",
    ticket: "CTL-642",
    tickets: ["CTL-642"],
    phase: "implement",
    status: "active",
    activeState: "active",
    working: true,
    lastActiveMs: null,
    repo: "catalyst",
    team: "CTL",
    runtimeMs: null,
    costUSD: null,
    ...over,
  };
}

/** Build a one-row inbox model and return the single row, so the tests exercise
 *  the exact InboxRow the surface feeds the pane (section classification + the
 *  ticket carried through). */
function rowFor(ticket: BoardTicket): InboxRow {
  const payload: BoardPayload = {
    generatedAt: "2026-06-09T00:00:00Z",
    config: { maxParallel: 0, inFlight: 0, freeSlots: 0, active: 0, working: 0, stuck: 0 },
    repos: ["catalyst"],
    workers: [],
    tickets: [ticket],
    queue: [],
  };
  const model = deriveInbox(payload);
  const row = model.order[0];
  if (row == null) throw new Error("fixture produced no row");
  return row;
}

// stub phase resolvers (the real ones live in phase-model; injected so this stays
// outside the ui module graph).
const phaseIndexOf = (phase: string) =>
  ["triage", "research", "plan", "implement", "verify", "review", "pr"].indexOf(phase);
const isDoneStatus = (status: string) => status === "done";

// ════════════════════════════════════════════════════════════════════════════
// Scenario: The reading pane shows what's needed now for a decision
// ════════════════════════════════════════════════════════════════════════════
describe("decision item — hero ask + options + About (CTL-902 scenario 1)", () => {
  const options: DecisionOption[] = [
    { label: "Path A", detail: "safe but slower — keep the existing guard" },
    { label: "Path B", detail: "faster but riskier — rewrite the reclaim probe" },
  ];
  const ticket = mkTicket("CTL-642", {
    held: "waiting",
    ask: "Two valid fix paths for the reclaim bug — which do you want?",
    summary: "The reclaim probe can prematurely declare a live worker dead.",
    goal: "Stop the premature implement-complete on the first commit.",
    options,
    phase: "implement",
  });
  const row = rowFor(ticket);

  it("the hero block is a decision (not a blocker)", () => {
    expect(row.section).toBe("waiting");
    expect(heroKindFor(row)).toBe("decision");
  });

  it("the hero shows the full ask in plain language", () => {
    expect(askFor(row)).toBe("Two valid fix paths for the reclaim bug — which do you want?");
  });

  it("each option is a label + a one-line trade-off detail", () => {
    const out = optionsFor(row);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ label: "Path A", detail: "safe but slower — keep the existing guard" });
    expect(out[1]).toEqual({
      label: "Path B",
      detail: "faster but riskier — rewrite the reclaim probe",
    });
  });

  it("a decision item shows no blocker", () => {
    expect(blockerFor(row)).toBeNull();
  });

  it("the About block carries the summary, the goal, and the phase-strip read", () => {
    const about = aboutBlockFor(row, phaseIndexOf, isDoneStatus);
    expect(about.summary).toBe("The reclaim probe can prematurely declare a live worker dead.");
    expect(about.goal).toBe("Stop the premature implement-complete on the first commit.");
    expect(about.phaseIndex).toBe(3); // implement is index 3
    expect(about.done).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario: The reading pane shows the blocker for a blocked item
// ════════════════════════════════════════════════════════════════════════════
describe("blocked item — blocker detail instead of options (CTL-902 scenario 2)", () => {
  const ticket = mkTicket("CTL-867", {
    held: "blocked",
    blockers: ["CTL-853"],
    ask: "Can't read the registry — the agent needs host credentials to proceed.",
    blocker: "Registry read blocked: missing host credentials for the Mac-mini node.",
  });
  const row = rowFor(ticket);

  it("the hero block is a blocker (not a decision)", () => {
    expect(row.section).toBe("blocked");
    expect(heroKindFor(row)).toBe("blocked");
  });

  it("the hero describes the blocker in plain language", () => {
    expect(blockerFor(row)).toBe("Registry read blocked: missing host credentials for the Mac-mini node.");
  });

  it("a blocked item shows NO decision options", () => {
    expect(optionsFor(row)).toEqual([]);
  });

  it("the ask still surfaces for the blocked hero", () => {
    expect(askFor(row)).toBe("Can't read the registry — the agent needs host credentials to proceed.");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario: View in Claude deep-links to the agent's session
// ════════════════════════════════════════════════════════════════════════════
describe("View in Claude — session deep link (CTL-902 scenario 3)", () => {
  const row = rowFor(mkTicket("CTL-642", { held: "waiting" }));

  it("opens https://claude.ai/code/<sessionId> for the matching worker", () => {
    const workers = [mkWorker({ ticket: "CTL-642", sessionId: "abc-123-def" })];
    const link = viewInClaudeFor(row, workers);
    expect(link).not.toBeNull();
    expect(link?.href).toBe("https://claude.ai/code/abc-123-def");
    expect(link?.sessionId).toBe("abc-123-def");
  });

  it("matches a worker that carries the ticket in its multi-ticket set", () => {
    const workers = [mkWorker({ ticket: "CTL-999", tickets: ["CTL-999", "CTL-642"], sessionId: "sess-9" })];
    expect(viewInClaudeFor(row, workers)?.href).toBe("https://claude.ai/code/sess-9");
  });

  it("is HIDDEN (null) when no worker matches the ticket — no dead link", () => {
    const workers = [mkWorker({ ticket: "CTL-111", tickets: ["CTL-111"], sessionId: "other" })];
    expect(viewInClaudeFor(row, workers)).toBeNull();
  });

  it("is HIDDEN (null) when the matching worker has no session id", () => {
    const workers = [mkWorker({ ticket: "CTL-642", sessionId: undefined })];
    expect(viewInClaudeFor(row, workers)).toBeNull();
  });

  it("is HIDDEN (null) when there are no workers at all", () => {
    expect(viewInClaudeFor(row, [])).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Scenario: Context emphasis uses tint, never a nested card
// ════════════════════════════════════════════════════════════════════════════
describe("context accent — amber/red only, never cyan (CTL-902 scenario 4)", () => {
  it("a waiting (decision) item accents amber", () => {
    expect(accentFor(rowFor(mkTicket("CTL-642", { held: "waiting" })))).toBe("amber");
  });

  it("a blocked item accents red", () => {
    expect(accentFor(rowFor(mkTicket("CTL-867", { held: "blocked" })))).toBe("red");
  });

  it("a running item carries NO emphasis (neutral resting state)", () => {
    expect(accentFor(rowFor(mkTicket("CTL-900", { held: null })))).toBe("none");
  });

  it("a done item carries NO emphasis", () => {
    expect(accentFor(rowFor(mkTicket("CTL-880", { status: "done" })))).toBe("none");
  });

  it("the accent is NEVER cyan / any non-amber-red-none value", () => {
    for (const held of ["blocked", "waiting", null] as const) {
      const accent = accentFor(rowFor(mkTicket("CTL-1", { held })));
      expect(["amber", "red", "none"]).toContain(accent);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The honesty contract: render-absent, never fabricate
// ════════════════════════════════════════════════════════════════════════════
describe("honesty contract — omitted read-model fields render absent (CTL-902)", () => {
  it("a needs-you item with NO served content renders ask/blocker null + no options", () => {
    const row = rowFor(mkTicket("CTL-642", { held: "waiting" }));
    expect(askFor(row)).toBeNull();
    expect(optionsFor(row)).toEqual([]);
  });

  it("a blocked item with NO served blocker renders blocker null", () => {
    const row = rowFor(mkTicket("CTL-867", { held: "blocked" }));
    expect(blockerFor(row)).toBeNull();
  });

  it("an About block with NO summary/goal renders both null", () => {
    const about = aboutBlockFor(rowFor(mkTicket("CTL-642", { held: "waiting" })), phaseIndexOf, isDoneStatus);
    expect(about.summary).toBeNull();
    expect(about.goal).toBeNull();
  });

  it("the neutral (running/done) sets carry no hero kind or ask", () => {
    const running = rowFor(mkTicket("CTL-900", { held: null }));
    expect(heroKindFor(running)).toBeNull();
    expect(askFor(running)).toBeNull();
  });

  it("an option missing a label is dropped (never a blank line)", () => {
    const row = rowFor(
      mkTicket("CTL-642", {
        held: "waiting",
        options: [
          { label: "", detail: "orphan trade-off" },
          { label: "Keep", detail: "the good one" },
        ],
      }),
    );
    const out = optionsFor(row);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Keep");
  });

  it("an empty-string ask/blocker is treated as absent (null)", () => {
    expect(askFor(rowFor(mkTicket("CTL-642", { held: "waiting", ask: "" })))).toBeNull();
    expect(blockerFor(rowFor(mkTicket("CTL-867", { held: "blocked", blocker: "" })))).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// CTL-1110: escalationExplanationFor — CTA-led card view-model
// ════════════════════════════════════════════════════════════════════════════
const FULL_EXPL = {
  call_to_action: "Decide: finish the fix on this branch, or descope it.",
  outcome: "Operators see real-time cluster capacity.",
  problem: "capacityReader is not passed to assembleClusterView().",
  why_you: "The fixes need human judgment after automation gave up.",
  why_not_auto: "3 fix attempts failed; tests lock in the broken behavior.",
  what_to_do: "Review why the 2 wiring fixes failed; resolve or shrink scope.",
};

describe("CTL-1110: escalationExplanationFor", () => {
  it("returns the camelCase view for a needs-human row with a full explanation", () => {
    const row = rowFor(mkTicket("CTL-1092", { attention: "needs-human", explanation: FULL_EXPL }));
    expect(escalationExplanationFor(row)).toEqual({
      callToAction: FULL_EXPL.call_to_action,
      outcome: FULL_EXPL.outcome,
      problem: FULL_EXPL.problem,
      whyYou: FULL_EXPL.why_you,
      whyNotAuto: FULL_EXPL.why_not_auto,
      whatToDo: FULL_EXPL.what_to_do,
    });
  });

  it("projects absent sub-fields to null (graceful partial)", () => {
    const row = rowFor(mkTicket("CTL-1", {
      attention: "needs-human",
      explanation: { call_to_action: "Decide.", outcome: null, problem: "X.",
                     why_you: null, why_not_auto: null, what_to_do: null },
    }));
    const v = escalationExplanationFor(row)!;
    expect(v.callToAction).toBe("Decide.");
    expect(v.problem).toBe("X.");
    expect(v.outcome).toBeNull();
    expect(v.whatToDo).toBeNull();
  });

  it("returns null for a needs-human row with no explanation (graceful absent → bare hero)", () => {
    const row = rowFor(mkTicket("CTL-2", { attention: "needs-human" }));
    expect(escalationExplanationFor(row)).toBeNull();
  });

  it("returns null when every explanation field is null/empty", () => {
    const row = rowFor(mkTicket("CTL-3", {
      attention: "needs-human",
      explanation: { call_to_action: "", outcome: null, problem: null,
                     why_you: null, why_not_auto: null, what_to_do: null },
    }));
    expect(escalationExplanationFor(row)).toBeNull();
  });

  it("returns null for a waiting-on-you (non-escalated) row even if explanation is present", () => {
    const row = rowFor(mkTicket("CTL-4", { attention: "waiting-on-you", explanation: FULL_EXPL }));
    expect(escalationExplanationFor(row)).toBeNull();
  });
});
