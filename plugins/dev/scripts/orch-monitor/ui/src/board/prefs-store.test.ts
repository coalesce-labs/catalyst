// prefs-store.test.ts — units for the BOARD2 (CTL-906) board-display-prefs
// store: the persisted `boardPrefsAtom` + its defaults + the merge-on-read
// robustness. Mirrors nav-store.test.ts's jotai+localStorage pattern (this file
// imports jotai/utils which resolves from THIS module's own `ui/node_modules`).
//   Run from the ui package:  cd ui && bun test src/board/prefs-store.test.ts
//
// Each `describe` maps to a BOARD2 Gherkin scenario:
//   - "Display choices persist"  → the atom round-trips localStorage on reload
//   - merge-on-read robustness   → a stale/garbage blob never crashes, defaults fill
import { describe, it, expect, beforeEach } from "bun:test";
import { createStore } from "jotai";
import {
  boardPrefsAtom,
  DEFAULT_BOARD_PREFS,
  BOARD_PREFS_STORAGE_KEY,
  patchBoardPrefs,
  type BoardPrefs,
} from "./prefs-store";

// Minimal in-memory localStorage so atomWithStorage's storage (which reads
// `window.localStorage`) has a backing store under bun — same shim as
// nav-store.test.ts.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  get length() { return this.m.size; }
}

function installWindowStorage(): MemStorage {
  const mem = new MemStorage();
  const win = {
    localStorage: mem,
    Storage: MemStorage,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  (globalThis as unknown as { window: unknown }).window = win;
  return mem;
}

function seed(raw: string): MemStorage {
  const mem = installWindowStorage();
  mem.setItem(BOARD_PREFS_STORAGE_KEY, raw);
  return mem;
}

beforeEach(() => {
  installWindowStorage();
});

describe("prefs-store — DEFAULT_BOARD_PREFS (the SURF3 first-visit defaults)", () => {
  it("is dense (comfortable) + Status grouping + priority order + show-empty + no swimlane + board layout", () => {
    expect(DEFAULT_BOARD_PREFS).toEqual({
      density: "comfortable",
      groupBy: "linear",
      colorBy: "phase",
      order: "priority",
      showEmptyColumns: true,
      swimlane: "none",
      layout: "board",
    });
  });

  it("does NOT carry a repo field — repo scope is the shared repoScopeAtom (nav-store)", () => {
    expect("repo" in DEFAULT_BOARD_PREFS).toBe(false);
  });
});

describe("prefs-store — patchBoardPrefs field-level update", () => {
  it("merges a partial patch over the prior prefs without dropping siblings", () => {
    const next = patchBoardPrefs(DEFAULT_BOARD_PREFS, { density: "compact" });
    expect(next.density).toBe("compact");
    // every other field is preserved.
    expect(next.groupBy).toBe(DEFAULT_BOARD_PREFS.groupBy);
    expect(next.showEmptyColumns).toBe(DEFAULT_BOARD_PREFS.showEmptyColumns);
    // pure — does not mutate the input.
    expect(DEFAULT_BOARD_PREFS.density).toBe("comfortable");
  });
});

describe("prefs-store — boardPrefsAtom defaults + persistence (Display choices persist)", () => {
  it("a fresh store reads the defaults when localStorage is empty", () => {
    const store = createStore();
    expect(store.get(boardPrefsAtom)).toEqual(DEFAULT_BOARD_PREFS);
  });

  it("persists density=compact, grouping=phase, swimlane=host and rehydrates after a reload", () => {
    // session 1 — atomWithStorage only writes through while mounted, so subscribe
    // first (what useAtom does in the real app).
    const store1 = createStore();
    const unsub = store1.sub(boardPrefsAtom, () => {});
    store1.set(boardPrefsAtom, (p) =>
      patchBoardPrefs(p, { density: "compact", groupBy: "phase", swimlane: "host" }),
    );

    const raw = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.getItem(
      BOARD_PREFS_STORAGE_KEY,
    );
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!) as BoardPrefs;
    expect(stored.density).toBe("compact");
    expect(stored.groupBy).toBe("phase");
    expect(stored.swimlane).toBe("host");
    unsub();

    // reload — a brand-new store reading the SAME localStorage restores exactly
    // those choices (the "restores exactly those choices" Gherkin).
    const store2 = createStore();
    const unsub2 = store2.sub(boardPrefsAtom, () => {});
    const restored = store2.get(boardPrefsAtom);
    expect(restored.density).toBe("compact");
    expect(restored.groupBy).toBe("phase");
    expect(restored.swimlane).toBe("host");
    unsub2();
  });
});

describe("prefs-store — merge-on-read robustness (never crash on a stale/garbage blob)", () => {
  it("a v1 blob missing a newer field (order) reads back with the default, never undefined", () => {
    // Simulate a blob persisted before `order` existed.
    seed(JSON.stringify({ density: "compact", groupBy: "phase", colorBy: "repo", showEmptyColumns: false, swimlane: "none", layout: "board" }));
    const store = createStore();
    const unsub = store.sub(boardPrefsAtom, () => {});
    const prefs = store.get(boardPrefsAtom);
    expect(prefs.order).toBe("priority"); // default spread fills the gap
    expect(prefs.density).toBe("compact"); // the stored field still wins
    expect(prefs.showEmptyColumns).toBe(false);
    unsub();
  });

  it("a non-JSON / garbage stored value falls back to defaults, never throws", () => {
    seed("{not valid json");
    const store = createStore();
    const unsub = store.sub(boardPrefsAtom, () => {});
    expect(() => store.get(boardPrefsAtom)).not.toThrow();
    expect(store.get(boardPrefsAtom)).toEqual(DEFAULT_BOARD_PREFS);
    unsub();
  });

  it("a stored `null` falls back to defaults", () => {
    seed("null");
    const store = createStore();
    const unsub = store.sub(boardPrefsAtom, () => {});
    expect(store.get(boardPrefsAtom)).toEqual(DEFAULT_BOARD_PREFS);
    unsub();
  });

  it("a stored value with an out-of-range enum is replaced by the default for that field", () => {
    seed(JSON.stringify({ ...DEFAULT_BOARD_PREFS, density: "ludicrous", order: "chaos" }));
    const store = createStore();
    const unsub = store.sub(boardPrefsAtom, () => {});
    const prefs = store.get(boardPrefsAtom);
    expect(prefs.density).toBe("comfortable");
    expect(prefs.order).toBe("priority");
    unsub();
  });
});
