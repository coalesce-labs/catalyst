// overlay-scroll.test.ts — CTL-1036: the ONE shared overlay-scrollbar behaviour.
// Drives the global listener's class-toggle + fade debounce with an injected fake
// window + fake clock (no real DOM/timers), so the three Gherkin invariants hold:
//   • at rest, no marker (bars hidden) — the CSS reveals the thumb only while the
//     element carries `cat-scrolling`;
//   • scrolling adds the marker (thumb appears);
//   • the marker is removed ~1s after the LAST scroll event (thumb fades), with
//     each new scroll resetting the timer.
import { describe, it, expect } from "bun:test";
import {
  installOverlayScroll,
  shouldTrackScroll,
  OVERLAY_CLASS,
  SCROLLING_CLASS,
} from "./overlay-scroll";

// A minimal classList stand-in tracking the class set.
function mkEl(initial: string[] = []): Element {
  const set = new Set(initial);
  return {
    classList: {
      contains: (c: string) => set.has(c),
      add: (c: string) => set.add(c),
      remove: (c: string) => set.delete(c),
    },
    // test-only peek
    _has: (c: string) => set.has(c),
  } as unknown as Element & { _has: (c: string) => boolean };
}

// A fake window capturing the single scroll listener, and a fake clock.
function harness() {
  let handler: ((e: Event) => void) | null = null;
  const win = {
    addEventListener: (type: string, cb: EventListenerOrEventListenerObject) => {
      if (type === "scroll") handler = cb as (e: Event) => void;
    },
    removeEventListener: (type: string) => {
      if (type === "scroll") handler = null;
    },
  };
  let nextId = 1;
  const queue = new Map<number, { cb: () => void; at: number }>();
  let clock = 0;
  const timers = {
    set: (cb: () => void, ms: number) => {
      const id = nextId++;
      queue.set(id, { cb, at: clock + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (h: ReturnType<typeof setTimeout>) => {
      queue.delete(h as unknown as number);
    },
  };
  const advance = (ms: number) => {
    clock += ms;
    for (const [id, t] of [...queue.entries()]) {
      if (t.at <= clock) {
        queue.delete(id);
        t.cb();
      }
    }
  };
  const fire = (target: Element | null) => handler?.({ target } as unknown as Event);
  return { win, timers, advance, fire };
}

describe("shouldTrackScroll — only opted-in elements participate", () => {
  it("is true for an element carrying the overlay class", () => {
    expect(shouldTrackScroll(mkEl([OVERLAY_CLASS]))).toBe(true);
  });
  it("is false for an element without the class", () => {
    expect(shouldTrackScroll(mkEl([]))).toBe(false);
  });
  it("is false for null / non-element targets (document/window scroll)", () => {
    expect(shouldTrackScroll(null)).toBe(false);
    expect(shouldTrackScroll({} as EventTarget)).toBe(false);
  });
});

describe("installOverlayScroll — marker toggles around the gesture (CTL-1036)", () => {
  it("adds the scrolling marker on a scroll and removes it after the fade window", () => {
    const h = harness();
    installOverlayScroll(h.win, h.timers, 1000);
    const el = mkEl([OVERLAY_CLASS]) as Element & { _has: (c: string) => boolean };

    expect(el._has(SCROLLING_CLASS)).toBe(false); // at rest: no marker
    h.fire(el);
    expect(el._has(SCROLLING_CLASS)).toBe(true); // scrolling: marker present
    h.advance(999);
    expect(el._has(SCROLLING_CLASS)).toBe(true); // still within the window
    h.advance(2);
    expect(el._has(SCROLLING_CLASS)).toBe(false); // faded ~1s after the gesture
  });

  it("a continued gesture resets the fade timer (debounce)", () => {
    const h = harness();
    installOverlayScroll(h.win, h.timers, 1000);
    const el = mkEl([OVERLAY_CLASS]) as Element & { _has: (c: string) => boolean };

    h.fire(el);
    h.advance(800);
    h.fire(el); // another scroll resets the 1s window
    h.advance(800);
    expect(el._has(SCROLLING_CLASS)).toBe(true); // would have fired at 1000 without the reset
    h.advance(300);
    expect(el._has(SCROLLING_CLASS)).toBe(false); // 1000ms after the LAST scroll
  });

  it("ignores scrolls on elements that did not opt in", () => {
    const h = harness();
    installOverlayScroll(h.win, h.timers, 1000);
    const el = mkEl([]) as Element & { _has: (c: string) => boolean };
    h.fire(el);
    expect(el._has(SCROLLING_CLASS)).toBe(false);
  });

  it("teardown removes the listener and clears pending timers", () => {
    const h = harness();
    const teardown = installOverlayScroll(h.win, h.timers, 1000);
    const el = mkEl([OVERLAY_CLASS]) as Element & { _has: (c: string) => boolean };
    h.fire(el);
    teardown();
    // listener gone: a post-teardown scroll is a no-op
    h.fire(el);
    // the pending fade timer was cleared, so advancing does not throw / re-toggle
    h.advance(2000);
    expect(el._has(SCROLLING_CLASS)).toBe(true); // class stays as last set; timer cleared, not run
  });
});
