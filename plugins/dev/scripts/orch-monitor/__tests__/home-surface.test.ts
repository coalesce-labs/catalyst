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
// prominent home), the row (the quieter verb + overflow), the surface (the
// optimistic state + reconcile), and the use-respond hook (the only place the
// fetch-bearing client is called from).
const readingPaneSrc = read("components/home/reading-pane.tsx");
const useRespondSrc = read("hooks/use-respond.ts");

function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const homeCode = stripComments(homeSurfaceSrc);
const rowCode = stripComments(inboxRowSrc);
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

  it("the row's verb is a real ACTION button that fires onAct (not just selects)", () => {
    // The verb is a <button> carrying the action hook, and clicking it stops
    // propagation so it acts instead of selecting the row.
    expect(inboxRowSrc).toContain("data-row-verb");
    expect(inboxRowSrc).toContain("onAct?.(row.id)");
    expect(rowCode).toContain("stopPropagation");
    // The verb word comes from the typed action model, not a re-derivation.
    expect(inboxRowSrc).toContain("verbActionFor");
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

  // Scenario: Exactly one bright verb per row
  it("exactly ONE bright verb per row; the rest are a hover/overflow `⋯` menu", () => {
    // ONE primary verb (data-row-verb) + the demoted set behind the overflow
    // trigger (data-row-overflow) drawn from the closed OVERFLOW_ACTIONS list.
    expect(inboxRowSrc).toContain("data-row-verb");
    expect(inboxRowSrc).toContain("data-row-overflow");
    expect(inboxRowSrc).toContain("OVERFLOW_ACTIONS");
    expect(inboxRowSrc).toContain("DropdownMenu");
    // The overflow trigger is hover-revealed (opacity-0 → group-hover:opacity-100),
    // keeping the row calm with one bright button.
    expect(inboxRowSrc).toContain("group-hover:opacity-100");
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

  it("the row surfaces the optimistic state: resuming… then 'didn't take' on rollback", () => {
    expect(inboxRowSrc).toContain("resuming…");
    expect(inboxRowSrc).toContain("data-row-resuming");
    expect(inboxRowSrc).toContain("data-row-did-not-take");
    expect(inboxRowSrc).toContain("respondStatus");
  });

  it("the ONLY place the write client (fetch) is reached is the use-respond hook / its pure client", () => {
    // The home tree's no-fetch invariant is preserved: home-surface / row / pane
    // carry NO literal fetch/EventSource — the fetch is isolated in
    // respond-client.ts and reached only via the use-respond hook.
    for (const code of [homeCode, rowCode, readingPaneCode]) {
      expect(code).not.toMatch(/\bfetch\(/);
      expect(code).not.toMatch(/\bnew EventSource\b/);
    }
    // The hook calls the pure client (respondTicket), not a raw fetch of its own.
    expect(useRespondSrc).toContain("respondTicket");
    expect(useRespondCode).not.toMatch(/\bfetch\(/);
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
