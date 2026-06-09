// display-options-popover.test.ts — BOARD2 (CTL-906) behavior at the store layer
// (the repo has no DOM/testing-library; component behavior is exercised through
// the jotai store + the exported option arrays, mirroring nav-store.test.ts).
// Run from the ui package:  cd ui && bun test src/board/display-options-popover.test.ts
//
// Asserts the popover's contract WITHOUT a DOM: the option arrays it renders are
// complete + value-correct, and the patch path it uses (patchBoardPrefs through
// boardPrefsAtom) writes the chosen value while preserving siblings — the
// mechanism behind "selecting Compact writes density:'compact'" and "choices
// persist".
import { describe, it, expect, beforeEach } from "bun:test";
import { createStore } from "jotai";
import {
  DENSITY_OPTIONS,
  GROUP_BY_OPTIONS,
  COLOR_BY_OPTIONS,
  ORDER_OPTIONS,
  LAYOUT_OPTIONS,
} from "./display-options-popover";
import {
  boardPrefsAtom,
  DEFAULT_BOARD_PREFS,
  patchBoardPrefs,
} from "./prefs-store";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}
function installWindowStorage() {
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: new MemStorage(),
    Storage: MemStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
beforeEach(() => installWindowStorage());

describe("display-options-popover — the rows it renders", () => {
  it("offers the full Density / Group-by / Order / Color option sets", () => {
    expect(DENSITY_OPTIONS.map((o) => o.k)).toEqual(["comfortable", "compact"]);
    expect(GROUP_BY_OPTIONS.map((o) => o.k)).toEqual(["linear", "phase"]);
    // the Gherkin labels the grouping "Status / Phase" — linear renders as Status.
    expect(GROUP_BY_OPTIONS.find((o) => o.k === "linear")?.label).toBe("Status");
    expect(GROUP_BY_OPTIONS.find((o) => o.k === "phase")?.label).toBe("Pipeline");
    expect(ORDER_OPTIONS.map((o) => o.k)).toEqual(["priority", "recent", "live"]);
    expect(COLOR_BY_OPTIONS.map((o) => o.k)).toEqual(["phase", "status", "repo", "type"]);
    // the Density control is labelled Comfortable / Compact (the brief's wording).
    expect(DENSITY_OPTIONS.map((o) => o.label)).toEqual(["Comfortable", "Compact"]);
  });

  // BOARD4 / CTL-908: the Layout (Board ⇄ List) toggle the popover now renders.
  it("offers the BOARD4 Layout option set (Board | List), labelled for the brief", () => {
    expect(LAYOUT_OPTIONS.map((o) => o.k)).toEqual(["board", "list"]);
    expect(LAYOUT_OPTIONS.map((o) => o.label)).toEqual(["Board", "List"]);
  });
});

describe("display-options-popover — selecting an option writes the atom (the patch path)", () => {
  it("selecting 'Compact' writes density:'compact' and preserves the other prefs", () => {
    const store = createStore();
    const unsub = store.sub(boardPrefsAtom, () => {});
    // the popover's patch handler is `setPrefs(p => patchBoardPrefs(p, {density}))`.
    store.set(boardPrefsAtom, (p) => patchBoardPrefs(p, { density: "compact" }));
    const prefs = store.get(boardPrefsAtom);
    expect(prefs.density).toBe("compact");
    expect(prefs.groupBy).toBe(DEFAULT_BOARD_PREFS.groupBy);
    expect(prefs.colorBy).toBe(DEFAULT_BOARD_PREFS.colorBy);
    unsub();
  });

  it("switching density back to 'comfortable' restores the full-anatomy default", () => {
    const store = createStore();
    const unsub = store.sub(boardPrefsAtom, () => {});
    store.set(boardPrefsAtom, (p) => patchBoardPrefs(p, { density: "compact" }));
    store.set(boardPrefsAtom, (p) => patchBoardPrefs(p, { density: "comfortable" }));
    expect(store.get(boardPrefsAtom).density).toBe("comfortable");
    unsub();
  });

  it("toggling Show empty columns off persists showEmptyColumns:false", () => {
    const store = createStore();
    const unsub = store.sub(boardPrefsAtom, () => {});
    store.set(boardPrefsAtom, (p) => patchBoardPrefs(p, { showEmptyColumns: false }));
    expect(store.get(boardPrefsAtom).showEmptyColumns).toBe(false);
    unsub();
  });

  // BOARD4 / CTL-908 Gherkin: "Flip to List view" then "Flip back to Board". At the
  // store layer (this repo's no-DOM convention): selecting List writes layout:"list"
  // and preserves siblings (the filters/lens live in the same atom → "same filters
  // and live cards" on flip-back), and selecting Board restores layout:"board".
  it("selecting 'List' writes layout:'list' and preserves the other prefs (filters survive the flip)", () => {
    const store = createStore();
    const unsub = store.sub(boardPrefsAtom, () => {});
    store.set(boardPrefsAtom, (p) => patchBoardPrefs(p, { groupBy: "phase", swimlane: "project" }));
    store.set(boardPrefsAtom, (p) => patchBoardPrefs(p, { layout: "list" }));
    const prefs = store.get(boardPrefsAtom);
    expect(prefs.layout).toBe("list");
    // the lens + swimlane the kanban used are untouched, so flipping back restores them.
    expect(prefs.groupBy).toBe("phase");
    expect(prefs.swimlane).toBe("project");
    unsub();
  });

  it("flipping back to 'Board' restores layout:'board' with the same prefs intact", () => {
    const store = createStore();
    const unsub = store.sub(boardPrefsAtom, () => {});
    store.set(boardPrefsAtom, (p) => patchBoardPrefs(p, { layout: "list", swimlane: "project" }));
    store.set(boardPrefsAtom, (p) => patchBoardPrefs(p, { layout: "board" }));
    const prefs = store.get(boardPrefsAtom);
    expect(prefs.layout).toBe("board");
    expect(prefs.swimlane).toBe("project");
    unsub();
  });
});

describe("display-options-popover — the 'customized' indicator predicate", () => {
  // The popover shows a dot when any pref differs from default — the predicate is
  // a JSON deep-compare against DEFAULT_BOARD_PREFS.
  const customized = (prefs: unknown) =>
    JSON.stringify(prefs) !== JSON.stringify(DEFAULT_BOARD_PREFS);

  it("is false at defaults and true once any pref differs", () => {
    expect(customized(DEFAULT_BOARD_PREFS)).toBe(false);
    expect(customized(patchBoardPrefs(DEFAULT_BOARD_PREFS, { density: "compact" }))).toBe(true);
  });
});
