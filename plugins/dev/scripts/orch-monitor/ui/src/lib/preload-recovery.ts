// preload-recovery.ts — CTL-1374. Recover an open monitor PWA session when a lazy
// `import()` 404s because the dist was swapped under it. The CTL-1254 atomic deploy does
// `rm -rf <dist>; mv staging <dist>`, which removes the previous build's content-hashed
// chunks; a browser still on a pre-redeploy bundle then 404s its per-route / per-glyph
// lazy chunks and the surface goes permanently blank.
//
// Vite fires a `vite:preloadError` event on `window` when a dynamic import's preload
// fails. We suppress the resulting unhandled rejection and reload ONCE to pick up the
// fresh chunk graph — index.html is served `no-cache` (server.ts, CTL-1374), so the reload
// lands on the current build, not a stale shell.
//
// Reload-storm guards (a persistently-missing chunk — offline / a bad deploy — must not
// loop the page):
//   1. PRIMARY — a sessionStorage timestamp, one reload per RELOAD_WINDOW_MS. It survives
//      the reload, so it bounds reloads across page loads when storage is available.
//   2. In-memory fallback — a closure-scoped timestamp (one per page load) keeps the guard
//      holding WITHIN a load when storage can't be written (it can't survive the reload).
//   3. Navigation-type loop breaker — when NO persisted timestamp is available (storage
//      blocked → last===0) and THIS page load is itself a reload, we've almost certainly
//      already auto-reloaded once for a still-missing chunk, so we suppress instead of
//      looping. This is the storage-free cross-reload guard (no URL/cookie pollution). The
//      manual "Reload" banner (CTL-1373) remains the user's escape hatch.
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
  // Method syntax (bivariant params) + ReadonlyArray so the real `window.performance`
  // (whose getEntriesByType returns PerformanceEntryList) structurally satisfies this.
  performance?: {
    // `name` is included only to share a property with the real PerformanceEntry (dodges
    // TS's weak-type check); we read `.type` (present on PerformanceNavigationTiming).
    getEntriesByType?(type: string): ReadonlyArray<{ readonly name?: string; readonly type?: string }>;
    // legacy fallback (deprecated PerformanceNavigation.type === 1 means TYPE_RELOAD)
    navigation?: { readonly type?: number };
  };
}

/** Was the current page load itself a reload? (Navigation Timing API, with the legacy
 *  fallback.) Used as a storage-free loop breaker. Never throws → false on any uncertainty. */
function currentLoadWasReload(win: PreloadRecoveryWindow): boolean {
  try {
    const entries = win.performance?.getEntriesByType?.("navigation");
    const navType = entries && entries.length > 0 ? entries[0]?.type : undefined;
    if (typeof navType === "string") return navType === "reload";
    return win.performance?.navigation?.type === 1; // legacy TYPE_RELOAD
  } catch {
    return false;
  }
}

/**
 * Register the `vite:preloadError` self-recovery handler. Idempotent in practice because
 * main.tsx calls it once at module scope. Never throws — storage access is wrapped so a
 * disabled/again-throwing sessionStorage (private mode) degrades gracefully.
 */
export function installPreloadRecovery(
  win: PreloadRecoveryWindow = window,
  now: () => number = () => Date.now(),
): void {
  // Closure-scoped in-memory fallback (one per page load) — see guard #2 above.
  let memLast = 0;

  win.addEventListener("vite:preloadError", (ev: Event) => {
    // We handle recovery here, so stop Vite's default unhandled-rejection surfacing.
    ev.preventDefault?.();

    // Last reload = the most recent we know about, from storage OR the in-memory fallback.
    let last = memLast;
    try {
      const stored = Number(win.sessionStorage?.getItem(RELOAD_KEY) ?? 0) || 0;
      if (stored > last) last = stored;
    } catch {
      /* storage blocked → rely on the in-memory + navigation-type guards */
    }

    const t = now();
    // Guard #1/#2: `last === 0` is the never-reloaded sentinel (Date.now() is never 0), so
    // always recover on the first error; otherwise only once the window has elapsed.
    if (last !== 0 && t - last < RELOAD_WINDOW_MS) return;

    // Guard #3: with no persisted timestamp (storage blocked) AND this load is itself a
    // reload, we've already auto-reloaded once for a still-missing chunk → don't loop.
    if (last === 0 && currentLoadWasReload(win)) return;

    memLast = t; // record in memory first — survives a failed storage write
    try {
      win.sessionStorage?.setItem(RELOAD_KEY, String(t));
    } catch {
      /* best-effort — the in-memory + navigation-type guards still bound reloads */
    }
    win.location.reload();
  });
}
