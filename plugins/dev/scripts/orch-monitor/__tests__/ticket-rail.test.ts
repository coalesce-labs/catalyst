// ticket-rail.test.ts — CTL-1003 §B1/§B2 pure-helper units for the floating rail
// cards + relations list. `bun test` has no DOM, so the React structure is
// asserted via static source analysis and the PURE helpers (state-icon mapping,
// collapse-persistence round-trip, relation slice/show-more arithmetic) are
// unit-tested directly.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stateIconSpec } from "../ui/src/components/relation-state-icon";
import {
  relationHiddenCount,
  RELATION_GROUP_LIMIT,
} from "../ui/src/board/ticket-rail-model";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");
const railSrc = read("board/ticket-rail.tsx");

// ── stateIconSpec — the Linear state-icon mapping (§B2) ──────────────────────
describe("stateIconSpec — pure, total Linear-state → icon mapping (CTL-1003)", () => {
  it("maps each workflow state type to its glyph", () => {
    expect(stateIconSpec("backlog").kind).toBe("dotted");
    expect(stateIconSpec("triage").kind).toBe("ring");
    expect(stateIconSpec("unstarted").kind).toBe("ring");
    expect(stateIconSpec("started").kind).toBe("partial");
    expect(stateIconSpec("completed").kind).toBe("check");
    expect(stateIconSpec("canceled").kind).toBe("x");
    expect(stateIconSpec("duplicate").kind).toBe("x");
  });

  it("falls back to a solid ring on an unknown type (never throws)", () => {
    expect(() => stateIconSpec("weird")).not.toThrow();
    expect(stateIconSpec("weird").kind).toBe("ring");
    expect(stateIconSpec("").kind).toBe("ring");
  });

  it("uses meaning-colours: amber started, green completed, dim canceled", () => {
    expect(stateIconSpec("started").color).toBe("#eab308");
    expect(stateIconSpec("completed").color).toBe("#39d07a");
    expect(stateIconSpec("canceled").color).toBe("#5b626f");
  });
});

// ── collapse is per-entry transient state, NOT global localStorage (CTL-1049) ─
describe("rail collapse is back-stack entry state, not the global leak (CTL-1049)", () => {
  it("the rail no longer reads/writes the shared localStorage collapse key", () => {
    // The old `catalyst.ticket-rail.<id>.collapsed` round-trip was GLOBAL: a
    // section collapsed on ticket A stayed collapsed on ticket B. CTL-1049 sources
    // collapse from the per-history-entry entry-state family instead — so the leak
    // helpers and their localStorage key are gone from the rail entirely.
    // (the leak helpers' call sites are gone; the entry-state doc comment may still
    // NAME the retired key/helper, so we assert on the call sites + the import.)
    expect(railSrc).not.toContain("readRailCollapsed(");
    expect(railSrc).not.toContain("writeRailCollapsed(");
    expect(railSrc).not.toMatch(/import[^;]*\bwriteRailCollapsed\b/);
  });

  it("the RailCard open-state comes from the entry-state family (railSectionExpanded)", () => {
    expect(railSrc).toContain("useDetailEntryState");
    expect(railSrc).toContain("railSectionExpanded(entryState, id)");
    expect(railSrc).toContain("setRailSection(prev, id, next)");
  });
});

// ── relation slice / show-more arithmetic (§B2) ──────────────────────────────
describe("relationHiddenCount — first-5 + Show-N-more (CTL-1003)", () => {
  it("renders the first 5 with no expander when there are ≤ 5", () => {
    expect(RELATION_GROUP_LIMIT).toBe(5);
    expect(relationHiddenCount(0)).toBe(0);
    expect(relationHiddenCount(3)).toBe(0);
    expect(relationHiddenCount(5)).toBe(0);
  });

  it("hides the overflow behind a Show-N-more count when there are > 5", () => {
    expect(relationHiddenCount(6)).toBe(1);
    expect(relationHiddenCount(12)).toBe(7); // the Gherkin's 12-related case
  });
});

// ── structural: the floating cards + relation list shape (§B1/§B2) ───────────
describe("ticket-rail.tsx — floating cards + readable relations (CTL-1003)", () => {
  it("renders the five cards in order (Properties · Labels · Project · Relations · Dependencies)", () => {
    const order = ["Properties", "Labels", "Project", "Relations", "Dependencies"].map((t) =>
      railSrc.indexOf(`title="${t}"`),
    );
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("each card is a collapsible floating card (bordered surface-1, entry-state open)", () => {
    expect(railSrc).toContain("rounded-lg border border-border bg-surface-1");
    expect(railSrc).toContain("CollapsibleTrigger");
    // CTL-1049: the open-state now flows through the entry-state family setter.
    expect(railSrc).toContain("setRailSection(prev, id, next)");
  });

  it("the rail aside is transparent (floating cards, no rail panel / nested scroller)", () => {
    // CTL-1048: the rail no longer owns a nested `overflowY:auto` scroller — the
    // whole detail page is ONE scroll context on Shell's `data-shell-scroll`, so the
    // old per-rail `cat-overlay-scroll` aside is gone (its scroll moved to Shell).
    expect(railSrc).toMatch(/background: "transparent"/);
    expect(railSrc).not.toContain('className="cat-overlay-scroll"');
    expect(railSrc).not.toMatch(/borderLeft/);
  });

  it("relations render as a state-icon + title list with HoverCard, not bare-key pills", () => {
    expect(railSrc).toContain("RelationStateIcon");
    expect(railSrc).toContain("HoverCard");
    // no .ticket-ref-pill wall-of-keys class on the relation rows.
    expect(railSrc).not.toContain("ticket-ref-pill");
  });
});

// ── CTL-1012: the rail rows orient by the project icon ───────────────────────
describe("ticket-rail.tsx — Repo/Team/Project rows carry the project icon (CTL-1012)", () => {
  it("resolves the project mark from the resident ticket's repo via the shared icon context", () => {
    expect(railSrc).toContain("useRepoIconMap");
    expect(railSrc).toContain("resolveEntityIcon(ticket?.repo, icons)");
  });

  it("the Properties Repo + Team rows carry the resolved iconSrc", () => {
    // both rows pass the iconSrc through to PropRow (the same brand the lanes show).
    expect(railSrc).toMatch(/label: "Repo", value: ticket\.repo, iconSrc/);
    expect(railSrc).toMatch(/label: "Team", value: ticket\.team, iconSrc/);
  });

  it("PropRow renders a 14px icon before the value when iconSrc + a real value are present", () => {
    // guarded so the icon never shows beside a dimmed em-dash placeholder.
    expect(railSrc).toContain("row.iconSrc != null && row.value != null");
    expect(railSrc).toMatch(/width: 14, height: 14, borderRadius: 3, objectFit: "contain"/);
  });

  it("the Project card prefers the project icon, falling back to the Box glyph", () => {
    // fail-open: an undiscovered icon (iconSrc null) keeps the generic Box.
    expect(railSrc).toContain("iconSrc != null ? (");
    expect(railSrc).toContain('<Box className="size-3.5 text-muted-foreground" />');
  });
});
