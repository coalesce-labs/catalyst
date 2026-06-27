// sw-recovery.ts — escape a stale PWA shell (CTL-1373).
//
// The monitor's service worker (`public/service-worker.js`, cache `catalyst-shell-v1`) serves
// /assets/* CACHE-FIRST from a cache name that is never version-bumped, and the app ships no
// cache-control headers. So a plain `location.reload()` re-runs the SAME stale main bundle — which
// import()s an old manifest-chunk hash a redeploy/atomic-swap deleted — and the icons stay blank
// (the CTL-1370 reload affordance couldn't actually recover). This does the reliable recovery:
// unregister every service worker + delete every CacheStorage cache, THEN reload so the browser
// fetches the fresh build. Best-effort — if the SW/Cache APIs are absent or throw, we still reload.
//
// `reload` is injectable so the recovery is unit-testable without a real browser. The systemic
// deploy-hygiene cure (SW versioning + cache-control + retaining old chunks) is tracked in CTL-1374.

export async function hardRecoverAndReload(
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // Best-effort: a failed unregister/clear must not trap the user — fall through to the reload,
    // which at minimum revalidates the navigation document (the SW serves it network-first).
  }
  reload();
}
