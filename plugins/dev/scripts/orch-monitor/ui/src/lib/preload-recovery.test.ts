// preload-recovery.test.ts — CTL-1374. Unit-tests the vite:preloadError self-recovery
// without jsdom by injecting a fake window + a controllable clock.
import { describe, it, expect } from "bun:test";
import {
  installPreloadRecovery,
  RELOAD_WINDOW_MS,
  type PreloadRecoveryWindow,
} from "./preload-recovery";

const START = 1_000_000;
const NOOP = (_ev: Event): void => {};
const fakeEvent = (onPreventDefault: () => void = () => {}): Event =>
  ({ preventDefault: onPreventDefault }) as unknown as Event;

interface FakeWin {
  win: PreloadRecoveryWindow;
  /** the handler installPreloadRecovery registered (defaults to a no-op until install) */
  handler: (ev: Event) => void;
  reloads: () => number;
}

// Build a fake window. `sessionStorage` controls the storage seam: a Map (default),
// `null` (absent), or a thrower (private mode).
function makeWin(storage: "map" | "none" | "throws" = "map"): FakeWin {
  let handler: (ev: Event) => void = NOOP;
  let reloads = 0;
  const map = new Map<string, string>();
  const sessionStorage =
    storage === "none"
      ? undefined
      : storage === "throws"
        ? {
            getItem: () => {
              throw new Error("blocked");
            },
            setItem: () => {
              throw new Error("blocked");
            },
          }
        : {
            getItem: (k: string) => map.get(k) ?? null,
            setItem: (k: string, v: string) => {
              map.set(k, v);
            },
          };
  const ref: FakeWin = {
    win: {
      addEventListener: (type, listener) => {
        if (type === "vite:preloadError") ref.handler = listener;
      },
      location: {
        reload: () => {
          reloads++;
        },
      },
      sessionStorage,
    },
    handler: NOOP,
    reloads: () => reloads,
  };
  return ref;
}

describe("installPreloadRecovery (CTL-1374)", () => {
  it("reloads once and suppresses the default on the first preloadError", () => {
    const f = makeWin();
    installPreloadRecovery(f.win, () => START);
    let prevented = 0;
    f.handler(fakeEvent(() => prevented++));
    expect(f.reloads()).toBe(1);
    expect(prevented).toBe(1);
  });

  it("does NOT reload again within the guard window (no reload-storm)", () => {
    const f = makeWin();
    installPreloadRecovery(f.win, () => START);
    f.handler(fakeEvent());
    f.handler(fakeEvent()); // same instant — inside the 10s window
    expect(f.reloads()).toBe(1);
  });

  it("reloads again once the guard window has elapsed (multi-redeploy recovery)", () => {
    const f = makeWin();
    let now = START;
    installPreloadRecovery(f.win, () => now);
    f.handler(fakeEvent());
    now = START + RELOAD_WINDOW_MS + 1;
    f.handler(fakeEvent());
    expect(f.reloads()).toBe(2);
  });

  it("still reloads when sessionStorage is unavailable (degrades gracefully)", () => {
    const f = makeWin("none");
    installPreloadRecovery(f.win, () => START);
    f.handler(fakeEvent());
    expect(f.reloads()).toBe(1);
  });

  it("does not throw when sessionStorage throws (private mode) and still reloads", () => {
    const f = makeWin("throws");
    installPreloadRecovery(f.win, () => START);
    expect(() => f.handler(fakeEvent())).not.toThrow();
    expect(f.reloads()).toBe(1); // getItem throwing → treated as never-reloaded → reloads
  });
});
