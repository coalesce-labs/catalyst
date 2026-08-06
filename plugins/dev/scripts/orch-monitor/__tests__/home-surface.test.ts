// home-surface.test.ts — CTL-899 / HOME1 acceptance guards for the React tree.
//
// The PURE inbox derivation (grouping / walk order / default-select / calm
// header) is unit-tested in home-inbox.test.ts. `bun test` has no DOM, so — the
// same way app-shell.test.ts guards SHELL1 — the STRUCTURAL Gherkin scenarios
// (master-detail split with firm floors, bare rows not cards, j/k wiring,
// read-model-not-Linear data source, App surface wiring) are asserted by static
// source analysis: read the .tsx/.ts as text and assert the load-bearing wiring.
// PLUS the pure split-clamp floor math (clampListWidth) is unit-tested directly.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  clampListWidth,
  shouldStack,
  LIST_FLOOR_PX,
  READING_FLOOR_PX,
  STACK_BELOW_PX,
} from "../ui/src/board/home-split";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");

// CTL-989: App.tsx is retired — Home is wired into the unified router. The home
// route ("/") in app-router.tsx mounts HomeSurface inside the AppShell layout;
// the rich monitor dashboard moved to dashboard-surface.tsx. The App-wiring
// guards read those two files.
const appSrc = read("app-router.tsx") + "\n" + read("components/dashboard-surface.tsx");
const homeSurfaceSrc = read("components/home/home-surface.tsx");
const inboxRowSrc = read("components/home/inbox-row.tsx");
const splitSrc = read("components/home/resizable-split.tsx");
const useBoardSnapshotSrc = read("hooks/use-board-snapshot.ts");
const allClearHeroSrc = read("components/home/all-clear-hero.tsx");
// CTL-903 / HOME5: the write-path wiring lives in the reading pane (the verb's
// SOLE home — CTL-1127 made the row select-only, relocating the bright verb +
// its optimistic state to the pane's PaneVerb), the surface (the optimistic
// state + reconcile), and the use-respond hook (the only place the fetch-bearing
// client is called from).
const readingPaneSrc = read("components/home/reading-pane.tsx");
const useRespondSrc = read("hooks/use-respond.ts");
// CTL-1569: the conversation surface joins the home tree (same no-fetch invariant).
const conversationSrc = read("components/home/conversation.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const homeCode = stripComments(homeSurfaceSrc);
const rowCode = stripComments(inboxRowSrc);
const conversationCode = stripComments(conversationSrc);
const homeSurfaceCode = stripComments(homeSurfaceSrc);
const appCode = stripComments(appSrc);

// ── Scenario: The split survives an iPad-landscape width (firm floors) ────────
describe("master-detail split — firm iPad floors (CTL-899)", () => {
  it("declares list ≥320px and reading ≥360px floors", () => {
    expect(LIST_FLOOR_PX).toBe(320);
    expect(READING_FLOOR_PX).toBe(360);
  });

  it("clampListWidth keeps BOTH floors across the iPad-landscape range (1024–1366)", () => {
    for (const container of [1024, 1112, 1180, 1280, 1366]) {
      // A greedy desired width still leaves the reading pane its floor.
      const wide = clampListWidth(99999, container);
      expect(wide).toBeLessThanOrEqual(container - READING_FLOOR_PX);
      expect(container - wide).toBeGreaterThanOrEqual(READING_FLOOR_PX);
      // A tiny desired width still gives the list its floor.
      const narrow = clampListWidth(0, container);
      expect(narrow).toBeGreaterThanOrEqual(LIST_FLOOR_PX);
      // No split ever exceeds the container (⇒ no horizontal overflow).
      expect(wide).toBeLessThanOrEqual(container);
    }
  });

  it("falls back to the list floor when the container is narrower than both floors", () => {
    expect(clampListWidth(500, LIST_FLOOR_PX + READING_FLOOR_PX - 10)).toBe(LIST_FLOOR_PX);
  });

  it("stacks the panes only below the combined floor (portrait), not in landscape", () => {
    expect(STACK_BELOW_PX).toBe(LIST_FLOOR_PX + READING_FLOOR_PX); // 680
    expect(shouldStack(0)).toBe(false); // unmeasured container — don't stack yet
    expect(shouldStack(640)).toBe(true); // below 680 → stack (portrait)
    for (const landscape of [1024, 1112, 1180, 1280, 1366]) {
      expect(shouldStack(landscape)).toBe(false); // iPad-landscape stays split
    }
  });

  it("the split container is min-w-0 / overflow-hidden so a wide pane never overflows", () => {
    expect(splitSrc).toContain("min-w-0");
    expect(splitSrc).toContain("overflow-hidden");
    expect(splitSrc).toContain("ResizableSplit");
  });
});

// ── Scenario: Home renders the calm inbox, not the dense board ────────────────
describe("calm inbox surface — bare rows, calm header, master-detail (CTL-899)", () => {
  it("HomeSurface composes the resizable split with a list and a reading pane", () => {
    expect(homeSurfaceSrc).toContain("ResizableSplit");
    expect(homeSurfaceSrc).toContain("ReadingPane");
    expect(homeSurfaceSrc).toMatch(/list=\{/);
    expect(homeSurfaceSrc).toMatch(/reading=\{/);
  });

  it("renders ONE calm header sentence (not a KPI grid)", () => {
    expect(homeSurfaceSrc).toContain("calmHeaderSentence");
    expect(homeSurfaceSrc).toContain("data-calm-header");
  });

  it("the inbox row is a flat <button> row, NOT a bordered card", () => {
    // It IS a button row keyed by the ticket id.
    expect(inboxRowSrc).toContain("data-inbox-row");
    // No card-in-card: the row must not use the Card primitive or a boxed border
    // around itself. (Selection is a subtle surface, not a card outline.)
    expect(rowCode).not.toContain("components/ui/card");
    expect(rowCode).not.toMatch(/\bborder\b\s+rounded/); // no boxed card border
  });

  it("rows are hairline-divided in the list (the list is the container)", () => {
    expect(homeSurfaceSrc).toMatch(/divide-y/);
    expect(homeSurfaceSrc).toContain("InboxRow");
  });
});

// ── Scenario: Selecting a row updates the reading pane + default-select top ────
describe("selection — click + j/k drive the one reading pane (CTL-899)", () => {
  it("default-selects the top item via the derived defaultSelectedId", () => {
    expect(homeSurfaceSrc).toContain("defaultSelectedId");
  });

  it("binds j / k to walk the flat order through moveSelection", () => {
    expect(homeSurfaceSrc).toContain("moveSelection");
    expect(homeSurfaceSrc).toMatch(/=== "j"/);
    expect(homeSurfaceSrc).toMatch(/=== "k"/);
    // j/k must not steal typing — guarded by isTypingTarget (the SHELL contract).
    expect(homeSurfaceSrc).toContain("isTypingTarget");
  });

  it("the reading pane is driven by the selected row (rowById)", () => {
    expect(homeSurfaceSrc).toContain("rowById");
    expect(homeSurfaceSrc).toMatch(/row=\{selectedRow\}/);
  });
});

// ── Scenario: Inbox data comes from the read-model, never a live Linear call ──
describe("data plane — read-model SSE, never a synchronous Linear call (CTL-899)", () => {
  it("HomeSurface sources data from the board read-model snapshot hook", () => {
    expect(homeSurfaceSrc).toContain("useBoardSnapshot");
    expect(homeSurfaceSrc).toContain("deriveInbox");
  });

  it("the snapshot hook subscribes via connectBoard (the SSE board transport)", () => {
    expect(useBoardSnapshotSrc).toContain("connectBoard");
    expect(useBoardSnapshotSrc).toContain("/board/board-client");
  });

  it("NO part of the Home tree reaches for Linear / linearis / a per-load fetch", () => {
    // Strip comments first so the prose that EXPLAINS the no-Linear contract
    // (the word "linearis" appears in a doc comment) can't false-positive — only
    // real CODE is checked, mirroring app-shell.test.ts's edge-to-edge guard.
    for (const src of [homeSurfaceSrc, inboxRowSrc, splitSrc, useBoardSnapshotSrc].map(
      stripComments,
    )) {
      expect(src.toLowerCase()).not.toContain("linearis");
      expect(src).not.toContain("/api/linear");
      // The home tree must not open its own fetch/EventSource — it rides the
      // shared connectBoard transport (which the board already proves).
      expect(src).not.toMatch(/\bnew EventSource\b/);
      expect(src).not.toMatch(/\bfetch\(/);
    }
  });
});

// ── CTL-901 (HOME3): reframed groups + per-row durations + collapsed reassurance
describe("HOME3 — per-row durations are wired honestly into the row (CTL-901)", () => {
  it("the row computes its duration from the pure rowDurationMs + fmtRelativeDuration", () => {
    // The row derives the elapsed ms (rowDurationMs) and formats it with the
    // quiet single-unit formatter — not the dense board's fmtDuration.
    expect(inboxRowSrc).toContain("rowDurationMs");
    expect(inboxRowSrc).toContain("fmtRelativeDuration");
  });

  it("the row OMITS the duration cell when there is no honest backing timestamp", () => {
    // The "never fabricated" Gherkin: duration is rendered only when non-null;
    // the absent branch carries the unavailable marker, never a fabricated time.
    expect(rowCode).toMatch(/duration\s*!=\s*null/);
    expect(rowCode).toContain("data-row-duration-unavailable");
  });

  it("the row threads a shared `now` clock (rows agree on one time)", () => {
    expect(inboxRowSrc).toContain("now");
  });
});

describe("HOME3 — reframed groups read in plain operator language (CTL-901)", () => {
  // The three sections are the plain-language reframe. The labels live in the
  // pure home-inbox module (SECTION_LABEL); guard them at the source of truth.
  const homeInboxSrc = read("board/home-inbox.ts");
  it("titles the sections 'What's blocked' / 'What's waiting' / 'Running on its own'", () => {
    expect(homeInboxSrc).toContain('"What\'s blocked"');
    expect(homeInboxSrc).toContain('"What\'s waiting"');
    expect(homeInboxSrc).toContain('"Running on its own"');
  });
});

describe("HOME3 — 'Running on its own' is a collapsed reassurance count by default (CTL-901)", () => {
  it("the section block collapses the non-needs-you (reassurance) sets by default", () => {
    // A reassurance section starts collapsed (open === !collapsible) and exposes
    // a count toggle; needs-you sections (blocked/waiting) stay open.
    expect(homeSurfaceSrc).toContain("isNeedsYouSection");
    expect(homeSurfaceSrc).toContain("data-section-toggle");
    expect(homeSurfaceSrc).toMatch(/data-collapsed/);
  });

  it("the surface ticks a `now` clock and passes it down to the rows", () => {
    expect(homeSurfaceSrc).toContain("setNow");
    expect(homeSurfaceSrc).toMatch(/now=\{now\}/);
  });
});

// ── CTL-904 / HOME6: the calm all-clear empty state (the relief payoff) ───────
const heroCode = stripComments(allClearHeroSrc);

describe("all-clear empty state — the calm relief payoff (CTL-904)", () => {
  // Scenario: All-clear hero when nothing needs you
  it("HomeSurface gates the all-clear state on the read-model emptiness (isAllClear)", () => {
    // The gate is the SAME read-model emptiness the inbox derives — NOT a mock
    // toggle. isAllClear reads the derived counts (zero blocked + zero waiting).
    expect(homeSurfaceSrc).toContain("isAllClear");
    expect(homeSurfaceSrc).toContain("model.counts");
  });

  it("swaps the calm all-clear HERO into the reading pane (not a blank pane)", () => {
    expect(homeSurfaceSrc).toContain("AllClearHero");
    // The reading slot conditionally renders the hero vs. the per-row ReadingPane.
    // (HOME4 wrapped the ternary across lines with parens once ReadingPane grew a
    // `workers` prop, so allow the optional `(` + intervening whitespace/newline.)
    expect(homeSurfaceSrc).toMatch(/allClear\s*\?\s*\(?\s*<AllClearHero/);
    // The hero is keyed by a stable data hook and is NOT an inert blank.
    expect(allClearHeroSrc).toContain("data-all-clear-hero");
    expect(allClearHeroSrc).toContain("All clear");
  });

  it('the list shows an "All clear" message with how many shipped while you were away', () => {
    expect(homeSurfaceSrc).toContain("AllClearList");
    expect(homeSurfaceSrc).toContain("data-all-clear-list");
    // The shipped count flows from the derived counts, never a hardcoded number.
    expect(homeSurfaceSrc).toContain("shippedWhileAwaySummary");
  });

  it("the header reads as everything-handled (no alarm count) in the all-clear state", () => {
    // The all-clear header is the headline constant, NOT the alarm-count sentence.
    expect(homeSurfaceSrc).toContain("ALL_CLEAR_HEADLINE");
    expect(homeSurfaceSrc).toMatch(/allClear\s*\?\s*ALL_CLEAR_HEADLINE\s*:\s*calmHeaderSentence/);
  });

  // Scenario: All-clear still reassures about autonomous work
  it("reassures that agents are running on their own (allClearReassurance)", () => {
    expect(homeSurfaceSrc).toContain("allClearReassurance");
    expect(allClearHeroSrc).toContain("allClearReassurance");
  });

  // Scenario: Reduced-motion users get the calm state without animation
  it("the celebratory entrance collapses to instant under prefers-reduced-motion", () => {
    // The entrance is a CSS fade; motion-reduce: collapses it to none (no library).
    expect(heroCode).toContain("animate-fade-in");
    expect(heroCode).toContain("motion-reduce:animate-none");
    // The all-clear list entrance is honored the same way.
    expect(stripComments(homeSurfaceSrc)).toContain("motion-reduce:animate-none");
  });

  it("the all-clear hero does NOT reach for Linear / a per-load fetch (read-model only)", () => {
    expect(heroCode.toLowerCase()).not.toContain("linearis");
    expect(heroCode).not.toMatch(/\bnew EventSource\b/);
    expect(heroCode).not.toMatch(/\bfetch\(/);
  });
});

// ── CTL-903 / HOME5: one verb clears the item + resumes the agent ─────────────
const readingPaneCode = stripComments(readingPaneSrc);
const useRespondCode = stripComments(useRespondSrc);

describe("HOME5 — the bright verb fires the read-model write + resume (CTL-903)", () => {
  // Scenario: Answering a decision resumes the agent
  // Scenario: Unblocking a blocked item resumes the agent
  it("the surface wires the write path through the useRespond hook (record + resume)", () => {
    expect(homeSurfaceSrc).toContain("useRespond");
    // The verb's onClick fires respond(...) — the record-response + resume call.
    expect(homeSurfaceSrc).toContain("respond(");
    expect(homeSurfaceSrc).toMatch(/onAct=\{onAct\}/);
  });

  it("the row is SELECT-ONLY — it fires onSelect, never an action verb (CTL-1127)", () => {
    // CTL-1127: the row carries NO action affordance. Its only interaction is
    // selection (onSelect); the bright verb moved to the reading pane's PaneVerb,
    // so the list stays calm. The row therefore wires no onAct / verbActionFor /
    // data-row-verb — clicking the row selects it, nothing more.
    expect(inboxRowSrc).toContain("onSelect(row.id)");
    expect(inboxRowSrc).not.toContain("data-row-verb");
    expect(inboxRowSrc).not.toContain("verbActionFor");
    expect(rowCode).not.toContain("onAct");
  });

  it("the reading pane carries the PROMINENT primary verb (the verb's home)", () => {
    expect(readingPaneSrc).toContain("data-pane-verb");
    expect(readingPaneSrc).toContain("verbActionFor");
    expect(readingPaneSrc).toContain("onAct");
  });

  it("the write client targets the BFF12 read-model endpoint (POST .../respond)", () => {
    // The fetch is isolated in respond-client.ts; the hook calls respondTicket,
    // which posts to /api/ticket/<ticket>/respond (the resume-loop entry point).
    const clientSrc = read("board/respond-client.ts");
    expect(clientSrc).toContain("/api/ticket/");
    expect(clientSrc).toContain("/respond");
    expect(clientSrc).toMatch(/method:\s*"POST"/);
  });

  // Scenario: Exactly one bright verb — and it lives in the pane, not the row
  it("there is exactly ONE bright verb, and it lives in the pane (no row overflow `⋯`)", () => {
    // CTL-1127: the row-level verb cluster (one bright verb + a hover `⋯`
    // overflow of demoted actions) was removed. The single primary verb now
    // lives in the reading pane's PaneVerb; the row carries no overflow trigger /
    // DropdownMenu. One PaneVerb = one bright verb.
    expect(inboxRowSrc).not.toContain("data-row-overflow");
    expect(inboxRowSrc).not.toContain("OVERFLOW_ACTIONS");
    expect(inboxRowSrc).not.toContain("DropdownMenu");
    expect(inboxRowSrc).not.toContain("group-hover:opacity-100");
    // The one bright verb's home is the pane (the typed action drives the word).
    expect(readingPaneSrc).toContain("data-pane-verb");
    expect(readingPaneSrc).toContain("verbActionFor");
  });

  // Scenario: The mutation is fence-aware in a cluster
  it("fence-awareness lives server-side; the surface never reads hosts.json (single-node = no-op)", () => {
    // HOME5's hot path adds NO cluster code: the fence-check is the endpoint's
    // job (single-host identity no-op pass), surfaced to the client only as a
    // rejected outcome. Neither the surface nor the client reaches for the roster.
    for (const code of [homeCode, useRespondCode, stripComments(read("board/respond-client.ts"))]) {
      expect(code).not.toContain("hosts.json");
      expect(code).not.toContain("cluster-claim");
    }
  });

  // Scenario: Optimistic action rolls back if the agent does not resume
  it("the surface reconciles optimistic marks against each frame (rollback after the grace window)", () => {
    expect(homeSurfaceSrc).toContain("reconcile");
    // The still-waiting set is the model's needs-you rows (the exact "still shows
    // the item waiting" the scenario re-checks) — driven off the read-model frame.
    expect(homeSurfaceSrc).toContain("stillWaitingIds");
    expect(homeSurfaceSrc).toContain("isNeedsYouSection");
  });

  it("the PANE surfaces the optimistic state: Resuming… then 'didn't take' on rollback", () => {
    // CTL-1127: the optimistic write state moved off the row and onto the pane's
    // PaneVerb — it shows `Resuming…` (data-pane-resuming) while the write is in
    // flight, then reinstates the verb + a quiet "did not resume" note
    // (data-pane-did-not-take) on rollback, driven off the respondStatus prop.
    expect(readingPaneSrc).toContain("Resuming…");
    expect(readingPaneSrc).toContain("data-pane-resuming");
    expect(readingPaneSrc).toContain("data-pane-did-not-take");
    expect(readingPaneSrc).toContain("respondStatus");
  });

  it("the ONLY place the write client (fetch) is reached is the use-respond hook / its pure client", () => {
    // The home tree's no-fetch invariant is preserved: home-surface / row / pane /
    // conversation carry NO literal fetch/EventSource — the fetch is isolated in
    // respond-client.ts / conversation-client.ts and reached only via a hook.
    // CTL-1569 adds conversation.tsx to the tree, so it is held to the same rule.
    for (const code of [homeCode, rowCode, readingPaneCode, conversationCode]) {
      expect(code).not.toMatch(/\bfetch\(/);
      expect(code).not.toMatch(/\bnew EventSource\b/);
    }
    // The hook calls the pure client (respondTicket), not a raw fetch of its own.
    expect(useRespondSrc).toContain("respondTicket");
    expect(useRespondCode).not.toMatch(/\bfetch\(/);
    // The conversation reaches the network only through its isolated client.
    expect(conversationSrc).toContain("fetchConversation");
    expect(conversationSrc).toContain("postReply");
  });
});

// ── CTL-1569: the inbox as a conversation surface ────────────────────────────
describe("Inbox conversation surface (CTL-1569)", () => {
  it("the pane mounts the conversation for needs-you rows only", () => {
    // Running/done rows stay calm — the conversation is gated on needsYou.
    expect(readingPaneSrc).toContain("Conversation");
    expect(readingPaneSrc).toMatch(/needsYou &&\s*\(?\s*<Conversation/);
  });

  it("the thread renders NEWEST FIRST, in the order the server sent", () => {
    // §2: the agent's question is almost always newest and the operator's prior
    // reply the one before it — chronological order buries both. The server sorts
    // DESC and the component must not re-sort.
    expect(conversationSrc).toContain("newest-first");
    expect(conversationCode).not.toMatch(/\.reverse\(\)/);
    expect(conversationCode).not.toMatch(/\.sort\(/);
  });

  it("agent, human and integration comments are visually distinct", () => {
    // THREE classes, not two. Collapsing them styled a GitHub sync notice as the
    // agent speaking, which made automation chatter look like a question needing
    // an answer (and made it the derived ask).
    expect(conversationSrc).toContain("data-thread-author");
    expect(conversationSrc).toContain("isCatalystAgent");
    expect(conversationSrc).toContain("isIntegration");
    expect(conversationSrc).toContain("integration");
  });

  it("long comment bodies clamp with expand-in-place", () => {
    expect(conversationSrc).toContain("data-thread-expand");
    expect(conversationSrc).toContain("line-clamp-4");
  });

  it("the ask summary states the kind AND whether replying alone is enough", () => {
    // §1: the two things that must be unambiguous at a glance.
    expect(conversationSrc).toContain("data-ask-kind");
    expect(conversationSrc).toContain("data-ask-resolution");
    expect(conversationSrc).toContain("requiresAction");
  });

  it("suggested replies PREFILL the box rather than auto-sending", () => {
    // A chip is a shortcut, not a submit — the operator can still edit.
    expect(conversationSrc).toContain("data-ask-suggestion");
    expect(conversationSrc).toContain("onUseSuggestion");
    expect(conversationSrc).toContain("setDraft");
  });

  it("every row links directly to its Linear ticket", () => {
    expect(conversationSrc).toContain("data-linear-link");
  });

  it("a row with no underlying ticket shows NO reply affordance", () => {
    // Orphan-PR rows are synthesized with no Linear issue — nothing to reply to.
    expect(conversationSrc).toContain("canReply");
    expect(conversationSrc).toContain("data-no-reply-affordance");
  });

  it("a failed post KEEPS the draft and surfaces the reason (never loses the item)", () => {
    // §4: a failed post, or one whose label clear is suppressed, must restore the
    // row. The draft is only cleared on a CONFIRMED post.
    expect(conversationSrc).toContain("data-reply-failure");
    expect(conversationSrc).toMatch(/status === "replied"/);
  });

  it("P1 #3 — a ticket switch must not mix the previous ticket's context", () => {
    // Preserving the loaded conversation across a selection change rendered
    // ticket A's ask/thread/URL around a ReplyBox bound to ticket B, so an
    // operator acting in that window could post A's answer onto B.
    expect(conversationSrc).toContain("loadedFor");
    expect(conversationSrc).toMatch(/sameTicket/);
  });

  it("P2 #10 — a failed thread read must NOT remove the reply composer", () => {
    // Posting is a separate endpoint and the thread is non-load-bearing; returning
    // null on a read error stranded the operator until the row was reselected.
    expect(conversationSrc).toContain("read-failed");
    expect(conversationCode).not.toMatch(/state\.kind !== "loaded"\) return null/);
  });

  it("P2 #11 — a successful post clears ONLY the submitted text", () => {
    expect(conversationSrc).toContain("draftAtSend");
  });

  it("P2 #16 — the posted turn appears without racing the replica sync", () => {
    // A one-shot refetch after the POST loses the race with the webhook, so the
    // operator's own turn stayed invisible. The confirmed comment id is shown.
    expect(conversationSrc).toContain("ownTurns");
    expect(conversationSrc).toContain("ownReplyEntry");
    expect(conversationSrc).toContain("mergedComments");
  });

  it("P2 #6 — a replied row is projected OUT of the inbox model", () => {
    // The optimistic mark alone only changed pane rendering; sections/order still
    // carried the row, so it stayed visible and selected with a live reply box.
    expect(homeSurfaceSrc).toContain("resolvedIds");
    expect(homeSurfaceSrc).toContain("rawModel");
    // Reconcile must read the RAW model, or a hidden row could never roll back.
    expect(homeSurfaceSrc).toMatch(/for \(const row of rawModel\.order\)/);
  });

  it("re-review P2 — filtering resolved rows RECOMPUTES the dependent metadata", () => {
    // Copying defaultSelectedId/counts from the raw model left the selection
    // effect reselecting a hidden row and the calm header still counting it.
    expect(homeSurfaceSrc).toContain("defaultSelectedId: order.length > 0");
    expect(homeSurfaceSrc).toContain("perSection");
  });

  it("re-review P2 — the resolving reply is offered ONLY on a true attention row", () => {
    // needsYou also covers the scheduler's blocked/queued rows, where comment-wake
    // never clears the admission-gate label — replying there would optimistically
    // hide the row and then roll it back.
    expect(readingPaneSrc).toContain("canResolveByReply");
    expect(readingPaneSrc).toMatch(/row\.section === "attention"/);
    expect(conversationSrc).toContain("canResolveByReply");
  });

  it("re-review P2 — the CLIENT posts the untrimmed draft", () => {
    // Sending draft.trim() defeated the server's verbatim postBody fix.
    expect(conversationSrc).toContain("const body = draft;");
    expect(conversationCode).not.toMatch(/const body = draft\.trim\(\)/);
  });

  it("re-review P1 — async reply state is scoped to the CURRENT selection", () => {
    // A reply to A landing after switching to B must not append A's comment to B.
    // Comparing against the closure-captured `ticket` does NOT work — ReplyBox
    // invokes the callback captured during A's render, so both values are A and
    // the guard always passes. Only a ref reads the current selection.
    expect(conversationSrc).toContain("submittedFor");
    expect(conversationSrc).toMatch(/submittedFor === currentTicket\.current/);
    expect(conversationSrc).toContain("currentTicket.current = ticket");
  });

  it("round-3 P2 — the aggregate needsYou count is recomputed too", () => {
    // isAllClear and calmHeaderSentence read the AGGREGATE, not the components,
    // so resolving the last attention row must flip the all-clear immediately.
    expect(homeSurfaceSrc).toMatch(/needsYou: perSection\("attention"\)/);
  });

  it("round-4 P2 — an UNSENT reply is not reported as a failed resume", () => {
    // no_token / bot_identity / not_found / network: nothing was sent and no
    // resume was attempted, so "The agent did not resume — try again" would be a
    // second, wrong diagnosis beside the reply box's accurate one.
    expect(homeSurfaceCode).not.toMatch(/markDidNotTake\(/);
    expect(homeSurfaceSrc).toContain("no comment was sent");
  });

  it("round-4 P2 — the draft clear is scoped to ticket AND edit version", () => {
    // Value equality cannot prove no edit or ticket switch occurred.
    expect(conversationSrc).toContain("sendTicket");
    expect(conversationSrc).toContain("editVersion");
  });

  it("round-5 P2 — a reply failure does not leak across ticket selections", () => {
    // ReplyBox is REUSED across selections, so A's "Not sent" would otherwise
    // render under B for a reply never attempted on B.
    expect(conversationSrc).toMatch(/useEffect\(\(\) => \{\s*setFailure\(null\);\s*\}, \[ticket\]\)/);
  });

  it("round-5 P2 — suggestion prefills count as draft edits", () => {
    // Chips call setDraft too; if only typing bumped the version, prefilling B with
    // text submitted on A would let A's late success clear B's draft.
    expect(conversationSrc).toContain("applyDraft");
    expect(conversationSrc).toMatch(/onUseSuggestion=\{applyDraft\}/);
    expect(conversationSrc).toMatch(/setDraft=\{applyDraft\}/);
  });

  it("the surface routes a reply outcome through the ONE optimistic-rollback rule", () => {
    // Reusing the verb's mark + grace window (rather than a second optimistic
    // path) keeps one reconcile rule deciding when a row truly leaves the inbox.
    expect(homeSurfaceSrc).toContain("onReplied");
    expect(homeSurfaceSrc).toContain("markResolved");
  });
});

// ── Scenario: the router wires Home into the shell's home route ───────────────
describe("Router wiring — Home mounts into the shell home route (CTL-899 / CTL-989)", () => {
  it("the home route mounts HomeSurface inside the AppShell layout", () => {
    // CTL-989: Home is the "/" route; AppShell is the rootRoute layout, so
    // HomeSurface renders inside the layout's <Outlet/>. Route paths are string
    // LITERALS (TanStack infers the typed route tree from them) — the home route
    // is `path: "/"` and honors the persisted landing pref via surfaceToPath.
    expect(appSrc).toContain("HomeSurface");
    expect(appSrc).toContain("AppShell");
    expect(appSrc).toMatch(/path:\s*"\/"/);
    expect(appSrc).toContain("surfaceToPath");
  });

  it("keeps the rich monitor dashboard reachable (no regression)", () => {
    // CTL-989: the dashboard body moved out of App.tsx into dashboard-surface.tsx
    // (the /devops route) — it still mounts the Dashboard.
    expect(appSrc).toContain("DashboardSurface");
    expect(appSrc).toContain("Dashboard");
  });

  it("does not introduce a centered gutter on the home path (edge-to-edge)", () => {
    expect(homeCode).not.toMatch(/\bmx-auto\b/);
    expect(appCode).not.toMatch(/\bmx-auto\b/);
  });
});
