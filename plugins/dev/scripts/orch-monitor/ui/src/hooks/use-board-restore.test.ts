// use-board-restore.test.ts — CTL-951: the board scroll/focus-restore helper.
//
// `bun test` has no DOM, so (matching the repo's DOM-free discipline) we test the
// ONE pure-ish branch — `resolveScrollEl` — with a tiny duck-typed stub instead of
// a DOM rig. The snapshot parse/age logic + the restore round-trip are covered by
// detail-nav.test.ts (parseListContext); this guards the scroll-container lookup
// that the kanban / list / queue bodies all share.
import { describe, it, expect } from "bun:test";
import { resolveScrollEl } from "./use-board-restore";

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
