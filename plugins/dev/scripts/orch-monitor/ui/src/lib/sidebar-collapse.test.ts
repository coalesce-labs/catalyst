// sidebar-collapse.test.ts — units for the SHELL4 collapse-interaction core
// (CTL-894). These encode the ticket's Gherkin acceptance scenarios at the pure
// logic layer (no DOM), the same way nav-store.test.ts proves the persistence
// round-trip behind a localStorage shim.
//
// `readSidebarOpen` / `writeSidebarOpen` read `window.localStorage` lazily, so —
// like nav-store.test.ts — we install a minimal in-memory `window.localStorage`
// under bun (which has no `window`). `shouldToggleSidebar` is pure and needs no
// shim.
//
// Run from the ui package:  `cd ui && bun test src/lib/sidebar-collapse.test.ts`.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  SIDEBAR_STORAGE_KEY,
  readSidebarOpen,
  writeSidebarOpen,
  shouldToggleSidebar,
  type SidebarToggleKeyEvent,
} from "./sidebar-collapse";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  get length() {
    return this.m.size;
  }
}

function installWindowStorage(): MemStorage {
  const mem = new MemStorage();
  (globalThis as unknown as { window: unknown }).window = { localStorage: mem };
  return mem;
}

function removeWindow() {
  delete (globalThis as unknown as { window?: unknown }).window;
}

// ── shouldToggleSidebar — the `[` binding + "typing is never stolen" guard ─────
describe("shouldToggleSidebar — `[` toggles the rail, never steals typing", () => {
  const press = (over: Partial<SidebarToggleKeyEvent>): SidebarToggleKeyEvent => ({
    key: "[",
    target: null,
    ...over,
  });

  it("Scenario: `[` toggles the rail — a bare `[` outside a field toggles", () => {
    // Given focus is not in a text input, When I press `[`
    expect(shouldToggleSidebar(press({}))).toBe(true);
  });

  it("Scenario: Typing is never stolen — `[` inside an <input> is left alone", () => {
    expect(shouldToggleSidebar(press({ target: { tagName: "INPUT" } }))).toBe(
      false,
    );
  });

  it("Scenario: Typing is never stolen — `[` inside a <textarea> is left alone", () => {
    expect(shouldToggleSidebar(press({ target: { tagName: "TEXTAREA" } }))).toBe(
      false,
    );
  });

  it("Scenario: Typing is never stolen — `[` in a contenteditable is left alone", () => {
    expect(
      shouldToggleSidebar(
        press({ target: { tagName: "DIV", isContentEditable: true } }),
      ),
    ).toBe(false);
  });

  it("does not fire for a non-`[` key", () => {
    expect(shouldToggleSidebar(press({ key: "]" }))).toBe(false);
    expect(shouldToggleSidebar(press({ key: "b" }))).toBe(false);
  });

  it("ignores `[` with a meta/ctrl/alt modifier (those are not the `[` binding)", () => {
    expect(shouldToggleSidebar(press({ metaKey: true }))).toBe(false);
    expect(shouldToggleSidebar(press({ ctrlKey: true }))).toBe(false);
    expect(shouldToggleSidebar(press({ altKey: true }))).toBe(false);
  });

  it("still fires for `[` with only shift held (shift does not gate the toggle)", () => {
    // shift isn't one of the disqualifying modifiers — `[` is a base-row key.
    expect(shouldToggleSidebar(press({ shiftKey: true }))).toBe(true);
  });
});

// ── persistence — the "Collapse state persists across reloads" scenario ────────
describe("sidebar collapse persistence (survives a reload)", () => {
  beforeEach(() => {
    installWindowStorage();
  });
  afterEach(() => {
    removeWindow();
  });

  it("defaults OPEN when nothing is stored", () => {
    expect(readSidebarOpen()).toBe(true);
  });

  it("Scenario: Collapse state persists — collapse writes false, next read is collapsed", () => {
    // Given I collapsed the rail (open -> false is persisted)…
    writeSidebarOpen(false);
    // …When I reload the page (a fresh read) Then the rail is still collapsed.
    expect(readSidebarOpen()).toBe(false);
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("false");
  });

  it("re-expanding persists open again (round-trip both directions)", () => {
    writeSidebarOpen(false);
    expect(readSidebarOpen()).toBe(false);
    writeSidebarOpen(true);
    expect(readSidebarOpen()).toBe(true);
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("true");
  });

  it("only an explicit \"false\" collapses — any other stored value reads open", () => {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, "garbage");
    expect(readSidebarOpen()).toBe(true);
  });
});

// ── SSR / no-window safety — readers/writers must not throw without a DOM ───────
describe("sidebar collapse — no-window safety", () => {
  beforeEach(() => {
    removeWindow();
  });

  it("readSidebarOpen defaults open with no window", () => {
    expect(readSidebarOpen()).toBe(true);
  });

  it("writeSidebarOpen is a no-op (does not throw) with no window", () => {
    expect(() => writeSidebarOpen(false)).not.toThrow();
  });
});
