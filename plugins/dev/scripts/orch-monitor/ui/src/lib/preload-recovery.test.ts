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

// Build a fake window. `storage` controls the seam: a Map (default), `null` (absent), or a
// thrower (private mode). `navType` injects a Navigation Timing stub — "reload" marks the
// current load as a reload (guard #3), "navigate" a fresh load; undefined omits `performance`
// entirely (currentLoadWasReload → false).
function makeWin(
  storage: "map" | "none" | "throws" = "map",
  navType?: "reload" | "navigate",
): FakeWin {
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
      ...(navType ? { performance: { getEntriesByType: () => [{ type: navType }] } } : {}),
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

  // CTL-1374, Codex P2: with blocked storage the persisted timestamp is lost, so without an
  // in-memory fallback a persistently-404ing chunk would reload-loop. The in-memory guard
  // keeps the one-per-window rule holding within the page load.
  it("with throwing sessionStorage, the in-memory fallback still enforces the guard within the window", () => {
    const f = makeWin("throws");
    installPreloadRecovery(f.win, () => START);
    f.handler(fakeEvent()); // first → reloads, records the timestamp in memory
    f.handler(fakeEvent()); // second, same instant → in-memory guard blocks the reload-storm
    expect(f.reloads()).toBe(1);
  });

  it("with throwing sessionStorage, it reloads again only after the window elapses", () => {
    const f = makeWin("throws");
    let now = START;
    installPreloadRecovery(f.win, () => now);
    f.handler(fakeEvent());
    now = START + RELOAD_WINDOW_MS + 1;
    f.handler(fakeEvent());
    expect(f.reloads()).toBe(2);
  });

  // CTL-1374, Codex P2 (re-review): the closure timestamp is wiped by location.reload(), so
  // with blocked storage a still-missing chunk would reload-loop ACROSS reloads. Guard #3
  // (navigation-type) breaks it: when there's no persisted timestamp AND this load is itself
  // a reload, suppress.
  it("blocked storage + current load IS a reload → suppresses (storage-free loop breaker)", () => {
    const f = makeWin("throws", "reload");
    installPreloadRecovery(f.win, () => START);
    f.handler(fakeEvent());
    expect(f.reloads()).toBe(0); // we've already auto-reloaded once → don't loop
  });

  it("blocked storage + fresh (navigate) load → still reloads on the first error", () => {
    const f = makeWin("throws", "navigate");
    installPreloadRecovery(f.win, () => START);
    f.handler(fakeEvent());
    expect(f.reloads()).toBe(1);
  });

  it("supports the legacy performance.navigation.type === 1 (reload) loop breaker", () => {
    let reloads = 0;
    let handler: (ev: Event) => void = NOOP;
    const win: PreloadRecoveryWindow = {
      addEventListener: (type, listener) => {
        if (type === "vite:preloadError") handler = listener;
      },
      location: { reload: () => { reloads++; } },
      sessionStorage: {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      },
      performance: { navigation: { type: 1 } }, // legacy TYPE_RELOAD, no getEntriesByType
    };
    installPreloadRecovery(win, () => START);
    handler(fakeEvent());
    expect(reloads).toBe(0);
  });

  it("a reload load with no recorded reload suppresses (manual reload defers to the banner), even with working storage", () => {
    // A page that LOADED via reload (manual Cmd-R or our own) with no persisted timestamp
    // yet → guard #3 suppresses an immediate auto-reload regardless of storage working. This
    // is intentional: re-reloading right after a reload that didn't fix the chunk would loop;
    // the manual "Reload" banner (CTL-1373) stays the escape hatch.
    const f = makeWin("map", "reload");
    installPreloadRecovery(f.win, () => START);
    f.handler(fakeEvent());
    expect(f.reloads()).toBe(0);
  });

  it("a fresh (navigate) load with working storage reloads normally", () => {
    const f = makeWin("map", "navigate");
    installPreloadRecovery(f.win, () => START);
    f.handler(fakeEvent());
    expect(f.reloads()).toBe(1);
  });
});
