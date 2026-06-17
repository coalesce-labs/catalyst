// nav-store.test.ts — units for the jotai nav store (CTL-882 / FND2): the
// list-context / peek / palette atoms + the persisted recentlyViewedAtom.
//
// This file imports jotai (`atom`, `createStore`) and `jotai/utils`
// (`atomWithStorage`), which resolve from THIS module's own `ui/node_modules`.
// Run it from the ui package:  `cd ui && bun test src/board/nav-store.test.ts`.
// The main orch-monitor `bun test` does not load jotai, so the jotai-free
// recency logic is also covered there via __tests__/recents.test.ts; this file
// proves the atom wiring + the real localStorage round-trip behind
// `recentlyViewedAtom` (the "survives a reload" Gherkin, end-to-end).
import { describe, it, expect, beforeEach } from "bun:test";
import { createStore } from "jotai";
import {
  listContextAtom,
  EMPTY_LIST_CONTEXT,
  peekAtom,
  PEEK_CLOSED,
  paletteOpenAtom,
  recentlyViewedAtom,
  recordRecentAtom,
  RECENTLY_VIEWED_KEY,
  navProjectOrderAtom,
} from "./nav-store";

// Minimal in-memory localStorage so atomWithStorage's default storage — which
// reads `window.localStorage` (jotai createJSONStorage, verified in
// node_modules/jotai/vanilla/utils.js:421) — has a backing store under bun
// (there is no `window` in bun's runtime). `Storage` + `addEventListener` are
// shimmed too because jotai's default storage feature-detects them for its
// cross-tab `storage`-event subscriber.
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

beforeEach(() => {
  // Fresh, isolated storage per test (jotai's default storage reads it lazily).
  installWindowStorage();
});

describe("nav-store — list context / peek / palette atoms", () => {
  it("listContextAtom starts at the empty cold-link context", () => {
    const store = createStore();
    expect(store.get(listContextAtom)).toEqual(EMPTY_LIST_CONTEXT);
    expect(store.get(listContextAtom).ids).toEqual([]);
  });

  it("listContextAtom holds {ids, kind, lens, col} when the shell resolves a list", () => {
    const store = createStore();
    store.set(listContextAtom, {
      ids: ["CTL-845", "CTL-877", "CTL-880"],
      kind: "ticket",
      lens: "linear",
      col: "Implement",
    });
    const ctx = store.get(listContextAtom);
    expect(ctx.ids).toEqual(["CTL-845", "CTL-877", "CTL-880"]);
    expect(ctx.kind).toBe("ticket");
    expect(ctx.lens).toBe("linear");
    expect(ctx.col).toBe("Implement");
  });

  it("peekAtom starts closed and round-trips a neighbour preview", () => {
    const store = createStore();
    expect(store.get(peekAtom)).toEqual(PEEK_CLOSED);
    store.set(peekAtom, { open: true, leftId: "CTL-845", onId: "CTL-877", nextId: "CTL-880" });
    expect(store.get(peekAtom)).toEqual({
      open: true, leftId: "CTL-845", onId: "CTL-877", nextId: "CTL-880",
    });
  });

  it("paletteOpenAtom toggles", () => {
    const store = createStore();
    expect(store.get(paletteOpenAtom)).toBe(false);
    store.set(paletteOpenAtom, true);
    expect(store.get(paletteOpenAtom)).toBe(true);
  });
});

describe("nav-store — recentlyViewedAtom persistence (survives a reload)", () => {
  it("records visits most-recent-first via recordRecentAtom", () => {
    const store = createStore();
    store.set(recordRecentAtom, "CTL-845");
    store.set(recordRecentAtom, "CTL-831");
    expect(store.get(recentlyViewedAtom)).toEqual(["CTL-831", "CTL-845"]);
  });

  it("de-dupes a re-visit to the front", () => {
    const store = createStore();
    store.set(recordRecentAtom, "CTL-845");
    store.set(recordRecentAtom, "CTL-831");
    store.set(recordRecentAtom, "CTL-845");
    expect(store.get(recentlyViewedAtom)).toEqual(["CTL-845", "CTL-831"]);
  });

  it("persists to localStorage and rehydrates in recency order after a reload", () => {
    // session 1: visit CTL-845 then CTL-831. atomWithStorage only writes through
    // to localStorage while the atom is mounted, so subscribe first (this is
    // what React's <Provider>/useAtom does in the real app).
    const store1 = createStore();
    const unsub = store1.sub(recentlyViewedAtom, () => {});
    store1.set(recordRecentAtom, "CTL-845");
    store1.set(recordRecentAtom, "CTL-831");

    // it actually wrote to our backing window.localStorage under the key.
    const raw = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.getItem(
      RECENTLY_VIEWED_KEY,
    );
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(["CTL-831", "CTL-845"]);
    unsub();

    // reload: a brand-new store reading the SAME localStorage sees the list.
    // atomWithStorage hydrates from storage on mount (subscribe), exactly as the
    // React app does when the component first renders.
    const store2 = createStore();
    const unsub2 = store2.sub(recentlyViewedAtom, () => {});
    expect(store2.get(recentlyViewedAtom)).toEqual(["CTL-831", "CTL-845"]);
    unsub2();
  });
});

// ── CTL-1248: navProjectOrderAtom ────────────────────────────────────────────

describe("nav-store — navProjectOrderAtom (CTL-1248)", () => {
  it("defaults to an empty array", () => {
    const store = createStore();
    expect(store.get(navProjectOrderAtom)).toEqual([]);
  });

  it("round-trips a project order array (set + get)", () => {
    const store = createStore();
    const unsub = store.sub(navProjectOrderAtom, () => {});
    store.set(navProjectOrderAtom, ["catalyst", "adva"]);
    expect(store.get(navProjectOrderAtom)).toEqual(["catalyst", "adva"]);
    unsub();
  });

  it("persists to localStorage under the catalyst-nav-project-order-v1 key", () => {
    const store = createStore();
    const unsub = store.sub(navProjectOrderAtom, () => {});
    store.set(navProjectOrderAtom, ["adva", "catalyst"]);
    const raw = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.getItem(
      "catalyst-nav-project-order-v1",
    );
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual(["adva", "catalyst"]);
    unsub();
  });

  it("does not collide with the catalyst-nav-groups-v1 key", () => {
    const store = createStore();
    const unsub = store.sub(navProjectOrderAtom, () => {});
    store.set(navProjectOrderAtom, ["catalyst"]);
    const groupsRaw = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.getItem(
      "catalyst-nav-groups-v1",
    );
    // groups key should NOT be set by the order atom
    expect(groupsRaw).toBeNull();
    unsub();
  });
});
