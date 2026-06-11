// nav-sections.test.ts — CTL-1034: collapse-state persistence for the sidebar's
// top-level sections (Overall + Observe), proving the "collapsed state persists
// across reloads" Gherkin end-to-end against the real atomWithStorage +
// localStorage round-trip (the same discipline nav-store.test.ts uses for
// recentlyViewedAtom).
//
// Run from the ui package:  `cd ui && bun test src/board/nav-sections.test.ts`.
import { describe, it, expect, beforeEach } from "bun:test";
import { createStore } from "jotai";
import { navOverallOpenAtom, navObserveOpenAtom } from "./nav-store";

// Minimal in-memory localStorage so atomWithStorage's default storage (which
// reads `window.localStorage`) has a backing store under bun (no `window` in
// bun's runtime). Mirrors nav-store.test.ts.
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

function readLs(key: string): string | null {
  return (
    globalThis as unknown as { window: { localStorage: Storage } }
  ).window.localStorage.getItem(key);
}

beforeEach(() => {
  installWindowStorage();
});

describe("CTL-1034 — section open-state defaults", () => {
  it("the Overall section defaults OPEN (true)", () => {
    const store = createStore();
    expect(store.get(navOverallOpenAtom)).toBe(true);
  });

  it("the Observe section defaults OPEN (true)", () => {
    // CTL-1034: every section now starts expanded — Observe is no longer defaulted
    // collapsed (the old ephemeral useState(false) is gone).
    const store = createStore();
    expect(store.get(navObserveOpenAtom)).toBe(true);
  });
});

describe("CTL-1034 — section collapse persists across reloads", () => {
  it("collapsing Overall writes through to localStorage and rehydrates after a reload", () => {
    // session 1: collapse Overall. atomWithStorage only writes through while the
    // atom is mounted, so subscribe first (what React's useAtom does).
    const store1 = createStore();
    const unsub = store1.sub(navOverallOpenAtom, () => {});
    store1.set(navOverallOpenAtom, false);
    expect(readLs("catalyst-nav-overall-v1")).toBe(JSON.stringify(false));
    unsub();

    // reload: a brand-new store over the SAME localStorage sees the collapsed bit.
    const store2 = createStore();
    const unsub2 = store2.sub(navOverallOpenAtom, () => {});
    expect(store2.get(navOverallOpenAtom)).toBe(false);
    unsub2();
  });

  it("collapsing Observe persists independently of Overall", () => {
    const store1 = createStore();
    const unsubA = store1.sub(navOverallOpenAtom, () => {});
    const unsubB = store1.sub(navObserveOpenAtom, () => {});
    // Collapse ONLY Observe; Overall stays open.
    store1.set(navObserveOpenAtom, false);
    expect(readLs("catalyst-nav-observe-v1")).toBe(JSON.stringify(false));
    unsubA();
    unsubB();

    const store2 = createStore();
    const unsub2A = store2.sub(navOverallOpenAtom, () => {});
    const unsub2B = store2.sub(navObserveOpenAtom, () => {});
    expect(store2.get(navObserveOpenAtom)).toBe(false);
    expect(store2.get(navOverallOpenAtom)).toBe(true);
    unsub2A();
    unsub2B();
  });

  it("re-expanding a section persists the open bit", () => {
    const store1 = createStore();
    const unsub = store1.sub(navObserveOpenAtom, () => {});
    store1.set(navObserveOpenAtom, false);
    store1.set(navObserveOpenAtom, true);
    expect(readLs("catalyst-nav-observe-v1")).toBe(JSON.stringify(true));
    unsub();

    const store2 = createStore();
    const unsub2 = store2.sub(navObserveOpenAtom, () => {});
    expect(store2.get(navObserveOpenAtom)).toBe(true);
    unsub2();
  });
});
