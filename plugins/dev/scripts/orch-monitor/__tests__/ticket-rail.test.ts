// ticket-rail.test.ts — CTL-1003 §B1/§B2 pure-helper units for the floating rail
// cards + relations list. `bun test` has no DOM, so the React structure is
// asserted via static source analysis and the PURE helpers (state-icon mapping,
// collapse-persistence round-trip, relation slice/show-more arithmetic) are
// unit-tested directly.
import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stateIconSpec } from "../ui/src/components/relation-state-icon";
import {
  railCollapseKey,
  readRailCollapsed,
  writeRailCollapsed,
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

// ── collapse persistence — localStorage round-trip (§B1) ─────────────────────
describe("rail collapse persistence — localStorage round-trip (CTL-1003)", () => {
  // Minimal in-memory localStorage shim for the bun (no-DOM) runner.
  beforeEach(() => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  });

  it("namespaces the key per section", () => {
    expect(railCollapseKey("relations")).toBe("catalyst.ticket-rail.relations.collapsed");
    expect(railCollapseKey("properties")).toBe("catalyst.ticket-rail.properties.collapsed");
  });

  it("defaults to open (not collapsed) when nothing is stored", () => {
    expect(readRailCollapsed("relations")).toBe(false);
  });

  it("round-trips collapsed=true and back to open", () => {
    writeRailCollapsed("relations", true);
    expect(readRailCollapsed("relations")).toBe(true);
    writeRailCollapsed("relations", false);
    expect(readRailCollapsed("relations")).toBe(false);
  });

  it("fails open (default) when localStorage throws", () => {
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(readRailCollapsed("relations")).toBe(false);
    expect(() => writeRailCollapsed("relations", true)).not.toThrow();
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

  it("each card is a collapsible floating card (bordered surface-1, persisted)", () => {
    expect(railSrc).toContain("rounded-lg border border-border bg-surface-1");
    expect(railSrc).toContain("CollapsibleTrigger");
    expect(railSrc).toContain("writeRailCollapsed");
  });

  it("the rail aside is transparent + no-scrollbar (floating cards, no rail panel)", () => {
    expect(railSrc).toContain('className="no-scrollbar"');
    expect(railSrc).toMatch(/background: "transparent"/);
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
