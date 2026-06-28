// preload-recovery.ts — CTL-1374. Recover an open monitor PWA session when a lazy
// `import()` 404s because the dist was swapped under it. The CTL-1254 atomic deploy does
// `rm -rf <dist>; mv staging <dist>`, which removes the previous build's content-hashed
// chunks; a browser still on a pre-redeploy bundle then 404s its per-route / per-glyph
// lazy chunks and the surface goes permanently blank.
//
// Vite fires a `vite:preloadError` event on `window` when a dynamic import's preload
// fails. We suppress the resulting unhandled rejection and reload ONCE to pick up the
// fresh chunk graph — index.html is served `no-cache` (server.ts, CTL-1374), so the reload
// lands on the current build, not a stale shell. A sessionStorage timestamp caps reloads
// to one per RELOAD_WINDOW_MS so a persistently-broken chunk (or an offline session whose
// SW re-serves the stale '/') can't reload-storm; each genuinely fresh redeploy still gets
// its single recovery reload once the window elapses.
//
// DOM-light by construction: `win` + `now` are injectable so the logic is unit-testable
// without jsdom, and main.tsx stays a one-line side-effect call.

const RELOAD_KEY = "catalyst:preload-reload";

/** Max one recovery reload per this window (ms), keyed in sessionStorage. */
export const RELOAD_WINDOW_MS = 10_000;

/** The slice of `window` this module touches — kept minimal so tests can fake it. */
export interface PreloadRecoveryWindow {
  addEventListener(type: string, listener: (ev: Event) => void): void;
  location: { reload: () => void };
  sessionStorage?: Pick<Storage, "getItem" | "setItem">;
}

/**
 * Register the `vite:preloadError` self-recovery handler. Idempotent in practice because
 * main.tsx calls it once at module scope. Never throws — storage access is wrapped so a
 * disabled/again-throwing sessionStorage (private mode) degrades to "never reloaded".
 */
export function installPreloadRecovery(
  win: PreloadRecoveryWindow = window,
  now: () => number = () => Date.now(),
): void {
  win.addEventListener("vite:preloadError", (ev: Event) => {
    // We handle recovery here, so stop Vite's default unhandled-rejection surfacing.
    ev.preventDefault?.();

    let last = 0;
    try {
      last = Number(win.sessionStorage?.getItem(RELOAD_KEY) ?? 0) || 0;
    } catch {
      last = 0; // storage threw (private mode / disabled) → treat as never-reloaded
    }

    const t = now();
    // `last === 0` is the never-reloaded sentinel (Date.now() is never 0), so always recover
    // on the first error; otherwise only once the window has elapsed (don't reload-storm).
    if (last !== 0 && t - last < RELOAD_WINDOW_MS) return;

    try {
      win.sessionStorage?.setItem(RELOAD_KEY, String(t));
    } catch {
      /* best-effort — a failed write just means the next error may reload again */
    }
    win.location.reload();
  });
}
