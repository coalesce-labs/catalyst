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

const appSrc = read("App.tsx");
const homeSurfaceSrc = read("components/home/home-surface.tsx");
const inboxRowSrc = read("components/home/inbox-row.tsx");
const splitSrc = read("components/home/resizable-split.tsx");
const useBoardSnapshotSrc = read("hooks/use-board-snapshot.ts");

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

// ── Scenario: App wires Home into the shell's "home" surface ──────────────────
describe("App wiring — Home mounts into the shell home surface (CTL-899)", () => {
  it("App renders HomeSurface when the active surface is 'home'", () => {
    expect(appSrc).toContain("HomeSurface");
    expect(appSrc).toContain("useSurface");
    expect(appSrc).toMatch(/surface === "home"/);
  });

  it("keeps the dashboard as the fall-through for the other surfaces (no regression)", () => {
    // The dashboard body is still present and still mounts the Dashboard.
    expect(appSrc).toContain("dashboardBody");
    expect(appSrc).toContain("Dashboard");
  });

  it("does not introduce a centered gutter on the home path (edge-to-edge)", () => {
    expect(homeCode).not.toMatch(/\bmx-auto\b/);
    expect(appCode).not.toMatch(/\bmx-auto\b/);
  });
});
