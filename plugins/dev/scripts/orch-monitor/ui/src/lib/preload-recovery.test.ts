// preload-recovery.test.ts — CTL-1374. Unit-tests the vite:preloadError self-recovery
// without jsdom by injecting a fake window (storage + location.href + history) and a clock.
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
  /** the current URL (so a test can carry it across a simulated reload) */
  href: () => string;
}

// Build a fake window. `storage` controls the seam: a Map (default), `null` (absent), or a
// thrower (private mode). `href` seeds the initial URL (so a test can replay a reload that
// carried the recovery marker). history.replaceState mutates the URL in place (no navigation).
function makeWin(
  storage: "map" | "none" | "throws" = "map",
  opts: { href?: string } = {},
): FakeWin {
  let reloads = 0;
  let href = opts.href ?? "https://monitor.test/board";
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
        get href() {
          return href;
        },
        reload: () => {
          reloads++;
        },
      },
      history: {
        replaceState: (_data, _unused, url) => {
          href = new URL(url, href).href;
        },
      },
      sessionStorage,
    },
    handler: NOOP,
    reloads: () => reloads,
    href: () => href,
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

  // CTL-1374, Codex P2 (re-review #2): preventDefault() stops Vite re-throwing the import
  // error, so it must fire ONLY on the reload branch — a suppressed error must propagate to
  // the router retry UI / an error boundary, not be silently swallowed.
  it("does NOT preventDefault when it SUPPRESSES the reload (lets the app's error UI surface it)", () => {
    const f = makeWin();
    installPreloadRecovery(f.win, () => START);
    f.handler(fakeEvent()); // first → reloads (this one DOES preventDefault)
    let prevented = 0;
    f.handler(fakeEvent(() => prevented++)); // second, same instant → suppressed
    expect(f.reloads()).toBe(1);
    expect(prevented).toBe(0); // default NOT prevented → the chunk error can surface
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
    expect(f.reloads()).toBe(1);
  });

  it("with throwing sessionStorage, the in-memory fallback still enforces the guard within the window", () => {
    const f = makeWin("throws");
    installPreloadRecovery(f.win, () => START);
    f.handler(fakeEvent()); // first → reloads, records the timestamp in memory
    f.handler(fakeEvent()); // second, same instant → in-memory guard blocks the reload-storm
    expect(f.reloads()).toBe(1);
  });

  // ── URL-marker cross-reload guard (Codex P2 re-review #1/#3/#4) ───────────────────────
  // The in-memory timestamp is wiped by the reload, so the cross-reload loop guard rides a
  // URL marker we set right before reloading and adopt+strip on the next load. It is set
  // ONLY by us, so a tab the user opened via the browser Reload button is not mistaken for
  // our reload (that was the bug with the Navigation Timing approach).

  it("writes the recovery marker to the URL before reloading", () => {
    const f = makeWin();
    installPreloadRecovery(f.win, () => START);
    f.handler(fakeEvent());
    expect(f.href()).toContain(`__catalyst_plr=${START}`);
  });

  it("adopts the URL marker on the next load and STRIPS it (router never sees it)", () => {
    // Simulate a load that arrived via a recovery reload (marker present in the URL).
    const seeded = `https://monitor.test/board?__catalyst_plr=${START}`;
    const f = makeWin("map", { href: seeded });
    installPreloadRecovery(f.win, () => START);
    expect(f.href()).not.toContain("__catalyst_plr"); // stripped on adopt, before render
    // …and the adopted marker suppresses an immediate re-error within the window.
    f.handler(fakeEvent());
    expect(f.reloads()).toBe(0);
  });

  it("the marker survives a simulated reload and breaks the loop even with BLOCKED storage", () => {
    // 1st page load, storage blocked: the error reloads and stamps the URL marker.
    const f1 = makeWin("throws");
    installPreloadRecovery(f1.win, () => START);
    f1.handler(fakeEvent());
    expect(f1.reloads()).toBe(1);
    const urlAfterReload = f1.href();
    expect(urlAfterReload).toContain("__catalyst_plr=");

    // 2nd load lands on that URL (still blocked storage): the adopted marker suppresses the
    // immediate re-error → no cross-reload loop.
    const f2 = makeWin("throws", { href: urlAfterReload });
    installPreloadRecovery(f2.win, () => START);
    f2.handler(fakeEvent());
    expect(f2.reloads()).toBe(0);
  });

  it("a tab loaded via the browser Reload button (no marker) STILL recovers on a later redeploy", () => {
    // The regression the Navigation Timing approach caused: a reload-loaded tab must still
    // self-recover. With the marker-only signal it does, because we never set the marker.
    const f = makeWin("map", { href: "https://monitor.test/board" }); // no marker
    installPreloadRecovery(f.win, () => START);
    f.handler(fakeEvent());
    expect(f.reloads()).toBe(1);
  });

  it("after the window elapses, a blocked-storage session reloads again (paced, not stormed)", () => {
    const f1 = makeWin("throws");
    let now = START;
    installPreloadRecovery(f1.win, () => now);
    f1.handler(fakeEvent());
    const url = f1.href();

    const f2 = makeWin("throws", { href: url });
    now = START + RELOAD_WINDOW_MS + 1;
    installPreloadRecovery(f2.win, () => now);
    f2.handler(fakeEvent());
    expect(f2.reloads()).toBe(1); // window elapsed → one more paced reload
  });
});
