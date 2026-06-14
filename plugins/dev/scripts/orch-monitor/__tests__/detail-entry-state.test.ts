// detail-entry-state.test.ts — CTL-1049 back-stack entry state model units.
//
// The convention (CTL-1049 Gherkin): a fresh PUSH lands on a brand-new history
// entry key → no stored state → the page renders the DEFAULTS (Spec tab, all rail
// sections expanded, top of scroll). A back/forward traverse re-presents the SAME
// key → its stored {activeTab, railExpanded, scrollY} is restored verbatim.
//
// `bun test` has no DOM/jotai runtime, so the React/router glue (use-detail-entry-
// state.ts, the family in nav-store.ts, the Shell scroll wiring) is exercised by
// the structural source-grep suite below + the live app; THIS file unit-tests the
// PURE, runtime-free model that owns the default rules, the rail resolution, and
// the LRU eviction arithmetic — the same discipline as route-search.test.ts.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DETAIL_ENTRY_DEFAULTS,
  DETAIL_ENTRY_LRU_MAX,
  freshEntryState,
  railSectionExpanded,
  setRailSection,
  touchEntryLRU,
  type DetailEntryState,
} from "../ui/src/board/detail-entry-state";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");

// ── the fresh-push DEFAULTS (forward navigation = defaults) ───────────────────
describe("DETAIL_ENTRY_DEFAULTS — the fresh-push defaults (CTL-1049)", () => {
  it("opens on the Spec tab, all rail sections expanded, scrolled to top", () => {
    expect(DETAIL_ENTRY_DEFAULTS.activeTab).toBe("spec");
    expect(DETAIL_ENTRY_DEFAULTS.railExpanded).toEqual({});
    expect(DETAIL_ENTRY_DEFAULTS.scrollY).toBe(0);
  });

  it("freshEntryState() returns an INDEPENDENT copy (never a shared reference)", () => {
    const a = freshEntryState();
    const b = freshEntryState();
    expect(a).not.toBe(b);
    expect(a.railExpanded).not.toBe(b.railExpanded);
    a.railExpanded.properties = false;
    // mutating one fresh copy never leaks into another (or the defaults singleton).
    expect(b.railExpanded.properties).toBeUndefined();
    expect(DETAIL_ENTRY_DEFAULTS.railExpanded.properties).toBeUndefined();
  });

  it("a fresh key starting from defaults renders the Spec tab (tab-default rule)", () => {
    // A brand-new history entry has NO stored state, so the page reads the fresh
    // defaults — the active tab is always "spec" regardless of what tab the PRIOR
    // entry was on. This is the "no sticky last-tab leak across tickets" Gherkin.
    const fresh = freshEntryState();
    expect(fresh.activeTab).toBe("spec");
  });
});

// ── rail-section resolution (all-open default; explicit collapse) ─────────────
describe("railSectionExpanded — all-open default, explicit collapse (CTL-1049)", () => {
  it("a never-touched section is EXPANDED (absent from the map = open)", () => {
    const s = freshEntryState();
    for (const id of ["properties", "labels", "project", "relations", "dependencies"]) {
      expect(railSectionExpanded(s, id)).toBe(true);
    }
  });

  it("an explicit stored `false` collapses ONLY that section", () => {
    const s = setRailSection(freshEntryState(), "relations", false);
    expect(railSectionExpanded(s, "relations")).toBe(false);
    expect(railSectionExpanded(s, "properties")).toBe(true); // siblings stay open
  });

  it("setRailSection is immutable (returns a new state, leaves the input alone)", () => {
    const before = freshEntryState();
    const after = setRailSection(before, "labels", false);
    expect(after).not.toBe(before);
    expect(before.railExpanded.labels).toBeUndefined(); // input untouched
    expect(after.railExpanded.labels).toBe(false);
  });

  it("re-expanding a collapsed section restores the open resolution", () => {
    let s: DetailEntryState = setRailSection(freshEntryState(), "project", false);
    expect(railSectionExpanded(s, "project")).toBe(false);
    s = setRailSection(s, "project", true);
    expect(railSectionExpanded(s, "project")).toBe(true);
  });
});

// ── bounded memory (LRU over live entry keys) ────────────────────────────────
describe("touchEntryLRU — bounded family memory (CTL-1049)", () => {
  it("an empty order + a new key yields just that key, nothing evicted", () => {
    expect(touchEntryLRU([], "k1")).toEqual({ order: ["k1"], evicted: [] });
  });

  it("touching an existing key moves it to the most-recent end (de-duped)", () => {
    const { order, evicted } = touchEntryLRU(["a", "b", "c"], "a");
    expect(order).toEqual(["b", "c", "a"]);
    expect(evicted).toEqual([]);
  });

  it("evicts the oldest keys once the cap is exceeded (caller calls family.remove)", () => {
    // cap of 3: a fourth distinct key pushes the oldest ("a") off the front.
    const { order, evicted } = touchEntryLRU(["a", "b", "c"], "d", 3);
    expect(order).toEqual(["b", "c", "d"]);
    expect(evicted).toEqual(["a"]);
  });

  it("evicts MULTIPLE keys when the order overflows the cap by more than one", () => {
    const { order, evicted } = touchEntryLRU(["a", "b", "c", "d"], "e", 2);
    expect(order).toEqual(["d", "e"]);
    expect(evicted).toEqual(["a", "b", "c"]);
  });

  it("the currently-touched key is never evicted (it's at the recent end)", () => {
    const { order, evicted } = touchEntryLRU(["a", "b", "c"], "z", 1);
    expect(order).toEqual(["z"]);
    expect(evicted).toEqual(["a", "b", "c"]);
    expect(evicted).not.toContain("z");
  });

  it("the default cap is a generous, finite bound", () => {
    expect(DETAIL_ENTRY_LRU_MAX).toBeGreaterThan(0);
    expect(Number.isFinite(DETAIL_ENTRY_LRU_MAX)).toBe(true);
  });
});

// ── structural: the family + hook + Shell consume the model (shared scaffolding)
describe("the back-stack entry state is wired as SHARED scaffolding (CTL-1049)", () => {
  const navStoreSrc = read("board/nav-store.ts");
  const hookSrc = read("hooks/use-detail-entry-state.ts");
  const shellSrc = read("board/Shell.tsx");

  it("the jotai family is keyed per-entry (atomFamily, seeded from freshEntryState)", () => {
    expect(navStoreSrc).toContain("detailEntryStateFamily");
    expect(navStoreSrc).toContain("atomFamily");
    expect(navStoreSrc).toContain("freshEntryState()");
  });

  it("the hook reads the TanStack per-entry key off location.state.__TSR_key", () => {
    expect(hookSrc).toContain("__TSR_key");
    expect(hookSrc).toContain("detailEntryStateFamily");
  });

  it("the hook bounds the family via the LRU (calls family.remove on eviction)", () => {
    expect(hookSrc).toContain("touchEntryLRU");
    expect(hookSrc).toContain("detailEntryStateFamily.remove");
  });

  it("the Shell saves + restores scrollY through the entry state (back-restoration)", () => {
    expect(shellSrc).toContain("useDetailEntryState");
    expect(shellSrc).toContain("scrollY");
    expect(shellSrc).toContain("data-shell-scroll");
  });
});
