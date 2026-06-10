// use-board-restore.test.ts — CTL-951 + CTL-971: the board scroll/focus-restore.
//
// `bun test` has no DOM, so (matching the repo's DOM-free discipline) we test the
// helpers with tiny duck-typed stubs instead of a DOM rig:
//   - `resolveScrollEl` — the scroll-container lookup the kanban/list/queue share;
//   - `applyBoardRestore` (CTL-971) — the BOTH-AXIS scroll write + focus/flash, with
//     a fake scroller that CLAMPS to its extent (mirroring the browser) so the
//     "applied / retry" signal that drives the double-rAF is exercised honestly.
// The snapshot parse/age logic is covered by detail-nav.test.ts (parseListContext).
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveScrollEl, applyBoardRestore } from "./use-board-restore";

// A minimal stand-in for the board root: only `querySelector` is exercised.
function stubRoot(scrollChild: unknown): HTMLElement {
  return {
    querySelector: (sel: string) => (sel === ".cat-scroll" ? scrollChild : null),
  } as unknown as HTMLElement;
}

describe("resolveScrollEl (CTL-951)", () => {
  it("returns the .cat-scroll overflow container under the board root", () => {
    const scrollEl = { tag: "the scroll div" } as unknown as HTMLElement;
    const root = stubRoot(scrollEl);
    expect(resolveScrollEl(root)).toBe(scrollEl);
  });

  it("falls back to the root itself when no .cat-scroll child exists (never throws)", () => {
    const root = stubRoot(null);
    expect(resolveScrollEl(root)).toBe(root);
  });

  it("returns null for a null root (deep-link with no board mounted)", () => {
    expect(resolveScrollEl(null)).toBeNull();
  });
});

// ── CTL-971: dual-axis restore against a clamping fake scroller ────────────────
// A scroller that CLAMPS scrollLeft/scrollTop to [0, max] — exactly the browser's
// behavior, and the reason the hook double-rAFs (a not-yet-laid-out extent of 0
// clamps every write to 0).
class FakeScroller {
  className = "cat-scroll";
  private _left = 0;
  private _top = 0;
  constructor(
    public maxLeft: number,
    public maxTop: number,
  ) {}
  get scrollLeft() {
    return this._left;
  }
  set scrollLeft(v: number) {
    this._left = Math.max(0, Math.min(v, this.maxLeft));
  }
  get scrollTop() {
    return this._top;
  }
  set scrollTop(v: number) {
    this._top = Math.max(0, Math.min(v, this.maxTop));
  }
}

class FakeCard {
  focused = false;
  focusOpts: { preventScroll?: boolean } | undefined;
  style: Record<string, string> = {};
  focus(opts?: { preventScroll?: boolean }) {
    this.focused = true;
    this.focusOpts = opts;
  }
}

// A fake root whose querySelector returns the scroller for `.cat-scroll` and the
// card for the `[data-card-id="…"]` selector.
function fakeRoot(scroller: FakeScroller | null, card: FakeCard | null): HTMLElement {
  return {
    querySelector(sel: string) {
      if (sel === ".cat-scroll") return scroller;
      if (sel.startsWith("[data-card-id")) return card;
      return null;
    },
  } as unknown as HTMLElement;
}

// `applyBoardRestore` calls window.setTimeout (flashCard) — stub a window + drop
// CSS.escape so the cssEscape fallback (the worker-id ":" path) is exercised.
const realWindow = (globalThis as { window?: unknown }).window;
const realCSS = (globalThis as { CSS?: unknown }).CSS;
beforeEach(() => {
  (globalThis as { window?: unknown }).window = { setTimeout: () => 0 };
  (globalThis as { CSS?: unknown }).CSS = undefined;
});
afterEach(() => {
  (globalThis as { window?: unknown }).window = realWindow;
  (globalThis as { CSS?: unknown }).CSS = realCSS;
});

const SNAP = { scroll: { top: 300, left: 1400 }, focusId: "CTL-774" };

describe("applyBoardRestore — both-axis scroll + focus (CTL-971)", () => {
  it("restores BOTH scrollLeft AND scrollTop when the extent can hold them", () => {
    const sc = new FakeScroller(2000, 600);
    const ok = applyBoardRestore(fakeRoot(sc, new FakeCard()), SNAP);
    expect(sc.scrollLeft).toBe(1400);
    expect(sc.scrollTop).toBe(300);
    expect(ok).toBe(true); // both axes landed → no retry needed
  });

  it("reports NOT-applied when the extent hasn't laid out yet (signals a retry)", () => {
    const sc = new FakeScroller(0, 0); // 0-extent → both writes clamp to 0
    const ok = applyBoardRestore(fakeRoot(sc, null), SNAP);
    expect(sc.scrollLeft).toBe(0);
    expect(sc.scrollTop).toBe(0);
    expect(ok).toBe(false);
  });

  it("treats a {0,0} target as applied (nothing to wait for)", () => {
    const sc = new FakeScroller(0, 0);
    const ok = applyBoardRestore(fakeRoot(sc, null), { scroll: { top: 0, left: 0 }, focusId: "X" });
    expect(ok).toBe(true);
  });

  it("focuses the originating card WITHOUT scrolling it into view (preventScroll)", () => {
    const card = new FakeCard();
    applyBoardRestore(fakeRoot(new FakeScroller(2000, 600), card), SNAP);
    expect(card.focused).toBe(true);
    expect(card.focusOpts?.preventScroll).toBe(true);
  });

  it("never throws when the board root is absent (deep-link, no board) and reports not-applied", () => {
    // A null root → resolveScrollEl returns null → no element to scroll → false
    // (the hook's retry then no-ops; the snapshot is consumed and the deep-linked
    // page simply has no board to restore).
    expect(() => applyBoardRestore(null, SNAP)).not.toThrow();
    expect(applyBoardRestore(null, SNAP)).toBe(false);
  });

  it("flashes the restored card (sets an inline outline)", () => {
    const card = new FakeCard();
    applyBoardRestore(fakeRoot(new FakeScroller(2000, 600), card), SNAP);
    expect(card.style.outline).toContain("solid");
  });
});
