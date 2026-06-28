// preload-recovery.ts — CTL-1374. Recover an open monitor PWA session when a lazy
// `import()` 404s because the dist was swapped under it. The CTL-1254 atomic deploy does
// `rm -rf <dist>; mv staging <dist>`, which removes the previous build's content-hashed
// chunks; a browser still on a pre-redeploy bundle then 404s its per-route / per-glyph
// lazy chunks and the surface goes permanently blank.
//
// Vite fires a `vite:preloadError` event on `window` when a dynamic import's preload
// fails. On the recovery branch we suppress the resulting unhandled rejection and reload to
// pick up the fresh chunk graph — index.html is served `no-cache` (server.ts, CTL-1374), so
// the reload lands on the current build.
//
// Reload-storm guards (a persistently-missing chunk — offline / a bad deploy — must not loop
// the page) — the "last reload time" is taken as the max of three sources:
//   1. sessionStorage — survives the reload; the primary guard when storage works.
//   2. A closure in-memory timestamp — bounds reloads WITHIN a page load (storage can't be
//      written in private mode, and it can't survive the reload anyway).
//   3. A URL marker (`__catalyst_plr=<ts>`) we set right before reloading and ADOPT + STRIP
//      on the next load — the storage-FREE cross-reload guard. It is set ONLY by us, so
//      (unlike the Navigation Timing `type==="reload"` signal) a tab the user opened via the
//      browser Reload button is NOT mistaken for our own reload, and recovery still runs for
//      it. The marker is stripped before React renders, so the router never sees it and it
//      doesn't linger in the address bar.
//
// preventDefault() is called ONLY on the reload branch: it stops Vite re-throwing the import
// failure, so on a SUPPRESSED error we let it propagate to the router's retry UI / an error
// boundary instead of silently swallowing a genuinely-broken chunk.
//
// DOM-light by construction: `win` + `now` are injectable so the logic is unit-testable
// without jsdom, and main.tsx stays a one-line side-effect call.

const RELOAD_KEY = "catalyst:preload-reload";
const RELOAD_PARAM = "__catalyst_plr";

/** Max one recovery reload per this window (ms). */
export const RELOAD_WINDOW_MS = 10_000;

/** The slice of `window` this module touches — kept minimal so tests can fake it. */
export interface PreloadRecoveryWindow {
  addEventListener(type: string, listener: (ev: Event) => void): void;
  location: { href: string; reload: () => void };
  history?: { replaceState(data: unknown, unused: string, url: string): void };
  sessionStorage?: Pick<Storage, "getItem" | "setItem">;
}

/** Parse the `RELOAD_PARAM` timestamp out of a URL string; 0 when absent/malformed. */
function markerTs(href: string): number {
  try {
    return Number(new URL(href).searchParams.get(RELOAD_PARAM) ?? 0) || 0;
  } catch {
    return 0;
  }
}

/** Write the URL marker (or strip it when `ts` is 0) via history.replaceState — no navigation. */
function writeMarker(win: PreloadRecoveryWindow, ts: number): void {
  try {
    const url = new URL(win.location.href);
    if (ts > 0) url.searchParams.set(RELOAD_PARAM, String(ts));
    else url.searchParams.delete(RELOAD_PARAM);
    win.history?.replaceState(null, "", url.pathname + url.search + url.hash);
  } catch {
    /* no history / malformed URL → fall back to storage + in-memory only */
  }
}

/**
 * Register the `vite:preloadError` self-recovery handler. Idempotent in practice because
 * main.tsx calls it once at module scope (before render). Never throws.
 */
export function installPreloadRecovery(
  win: PreloadRecoveryWindow = window,
  now: () => number = () => Date.now(),
): void {
  // Adopt a recovery marker that rode the reload in the URL as the last-reload time, then
  // STRIP it immediately — install runs before React renders, so the router never sees it and
  // it doesn't linger. This is what makes the guard survive a reload even without storage.
  let memLast = markerTs(win.location.href);
  if (memLast > 0) writeMarker(win, 0);

  win.addEventListener("vite:preloadError", (ev: Event) => {
    let last = memLast;
    try {
      const stored = Number(win.sessionStorage?.getItem(RELOAD_KEY) ?? 0) || 0;
      if (stored > last) last = stored;
    } catch {
      /* storage blocked → memLast (incl. the adopted URL marker) is the fallback */
    }

    const t = now();
    // `last === 0` is the never-reloaded sentinel (Date.now() is never 0), so always recover
    // on the first error; otherwise only once the window has elapsed. On the SUPPRESSED path
    // we deliberately do NOT preventDefault, so a genuinely-broken chunk still surfaces to the
    // router retry UI / an error boundary instead of being silently swallowed.
    if (last !== 0 && t - last < RELOAD_WINDOW_MS) return;

    // Recovering by reload → suppress Vite's default unhandled-rejection surfacing.
    ev.preventDefault?.();
    memLast = t;
    try {
      win.sessionStorage?.setItem(RELOAD_KEY, String(t));
    } catch {
      /* best-effort — the URL marker + in-memory copy still bound reloads */
    }
    writeMarker(win, t); // carry the reload time across the reload, storage-free
    win.location.reload();
  });
}
