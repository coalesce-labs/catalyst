// Catalyst Monitor service worker (CTL-1133).
//
// Minimal by design: it exists so the web app meets PWA installability criteria
// (a registered SW with a fetch handler) and to cache the app shell for a fast,
// resilient launch — NOT to provide full offline. The monitor is a live
// dashboard; its data must always come from the network. So:
//
//   - app-shell assets (the document + hashed /assets/* build output) → cached,
//     served stale-while-revalidate so a cold launch paints instantly;
//   - everything else, and crucially /api/* + /events + SSE streams → straight
//     to network, never cached (stale fleet state would be worse than useless).
//
// CTL-1167 will add `push` + `notificationclick` handlers here on top of this.

const CACHE = "catalyst-shell-v1";

// Precache the entry document so the standalone window opens even on a flaky
// link. Hashed /assets/* are cached lazily on first fetch (runtime caching).
const SHELL = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  // Drop caches from older shell versions, then take control immediately.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Live data must NEVER be served from cache — the dashboard depends on it.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/events") ||
    req.headers.get("accept") === "text/event-stream"
  ) {
    return; // default network handling
  }

  // Navigation document: network-FIRST so an online launch always gets the
  // latest shell; fall back to the cached shell only when offline. This keeps a
  // live tool current while still satisfying offline-start_url install criteria.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put("/", res.clone());
          return res;
        } catch {
          return (await cache.match("/")) || (await cache.match("/index.html")) ||
            Response.error();
        }
      })(),
    );
    return;
  }

  // Hashed build assets are immutable — cache-first for an instant cold paint.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res && res.ok && res.type === "basic") cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  // Everything else: default network handling.
});
