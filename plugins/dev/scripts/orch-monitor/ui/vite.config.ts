import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { assembleBoard } from "../lib/board-data.mjs";

// CTL-1573: the dev server's own origins, and the origin the monitor knows
// itself by. Pinned (rather than left to Vite's port fallback) so the proxy's
// conditional Origin rewrite below has an exact, predictable set to match —
// a "close enough" match here would re-open the laundering hole it closes.
const DEV_PORT = 5173;
// 127.0.0.1, NOT localhost: the monitor's MONITOR_STRICT_LOOPBACK mode drops the
// family-ambiguous `localhost` name while keeping the unambiguous literal, so
// rewriting to the literal keeps `bun run dev:ui` working in BOTH modes.
// Derived from the monitor's own env so the proxy follows a non-default
// MONITOR_HOST/MONITOR_PORT. A wildcard bind is not a connectable address, so
// it maps to the loopback of that family. Both the proxy TARGET and the Origin
// we present must be this same value, or dev either misses the listener or
// presents an untrusted origin.
function monitorOrigin(): string {
  const port = Number(process.env.MONITOR_PORT) || 7400;
  const raw = (process.env.MONITOR_HOST ?? "").trim().replace(/^\[|\]$/g, "");
  // Wildcards are not connectable, so they map to the loopback of their family.
  // Must accept the SAME spellings the monitor's allowlist treats as wildcards
  // (`0`, `0.0`, `0.0.0`, `00`, `0x0`, `::`, `::0`, ...), or dev proxies to an
  // unreachable origin such as http://0:7400.
  const isV6 = raw.includes(":");
  const isV4Wildcard =
    !isV6 && raw !== "" && raw.split(".").length <= 4 &&
    raw.split(".").every((p) => p !== "" && Number(p) === 0);
  const host =
    raw === "" || isV4Wildcard
      ? "127.0.0.1"
      : isV6 && /^[0:]+$/.test(raw) // any IPv6 wildcard spelling
        ? "[::1]"
        : isV6
          ? `[${raw}]`
          : raw;
  return `http://${host}:${port}`;
}

const MONITOR_ORIGIN = monitorOrigin();
// ONE origin, not both loopback spellings. Vite binds a single address family,
// so another local process can own the other family's :5173; accepting both
// spellings would let a page there have its Origin laundered into the monitor's.
// This is Vite's own default host, i.e. the URL `bun run dev:ui` prints.
//
// Residual, accepted: a process squatting the SAME spelling on the other family
// is still laundered. That requires local code execution, affects only a running
// dev server, and cannot be distinguished from here — the browser does not tell
// us which family it connected over.
const DEV_ORIGINS = new Set([`http://localhost:${DEV_PORT}`]);

/**
 * Should the proxy replace this request's `Origin` with the monitor's own?
 * Exported so the rule is unit-tested rather than asserted in a comment.
 */
export function shouldRewriteOrigin(origin: string | undefined | null): boolean {
  return typeof origin === "string" && DEV_ORIGINS.has(origin.toLowerCase());
}

export { MONITOR_ORIGIN };

// CTL-1088: build out of the pristine plugin clone. When the wrapper provides a
// dist dir, writes outside the tracked public/; falls back to ../public so plain
// `bunx vite build` from a checkout still behaves as before.
export const OUT_DIR =
  process.env.MONITOR_UI_DIST_DIR && process.env.MONITOR_UI_DIST_DIR.length > 0
    ? resolve(process.env.MONITOR_UI_DIST_DIR)
    : resolve(__dirname, "../public");

// CTL-727/730: serve the live board payload from the dev server (Node side), so
// the React board can fetch real execution-core state without the legacy :7400
// monitor. Matches the SAME path the production monitor serves (`/api/board`,
// see server.ts), so Board.tsx uses one fetch URL in dev and prod. Registered
// as a pre-hook middleware (server.middlewares.use, not returned) so it runs
// before Vite's internal `/api`→:7400 proxy and intercepts standalone-dev
// requests without the monitor running.
function boardData(): Plugin {
  return {
    name: "catalyst-board-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || req.url.split("?")[0] !== "/api/board") return next();
        // CTL-733: assembleBoard() is async now.
        assembleBoard()
          .then((payload) => {
            res.setHeader("content-type", "application/json");
            res.setHeader("cache-control", "no-store");
            res.end(JSON.stringify(payload));
          })
          .catch((err) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(err) }));
          });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), boardData()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // CTL-1871 COORD-41: expose the scripts lib/ directory to the UI so
      // state-vocabulary.mjs (and future zero-import leaf modules) can be
      // imported as "~catalyst-lib/<name>" from any UI source file.
      "~catalyst-lib": resolve(__dirname, "../../lib"),
    },
  },
  build: {
    outDir: OUT_DIR,
    emptyOutDir: false,
    rollupOptions: {
      // CTL-989: SINGLE entry. The two SPA bundles are unified into ONE TanStack
      // Router mounted from index.html (→ main.tsx → RouterProvider, with AppShell
      // as the rootRoute layout). The standalone board.html bundle is retired —
      // its routes (/ticket/$id, /worker/$id, /dep-graph) are now child routes of
      // the unified router and the server serves index.html for every app path
      // (see server.ts isAppRoute). The detail + OBSERVE surface routes are
      // code-split (React.lazy in app-router.tsx) so the main bundle stays lean.
      input: {
        main: resolve(__dirname, "index.html"),
      },
    },
  },
  server: {
    port: DEV_PORT,
    // Vite falls back to the NEXT FREE port unless strictPort is set. Without
    // this the UI could come up on 5174 while DEV_ORIGINS still only matches
    // 5173, so the proxy would leave Origin untouched and every reply would
    // 403 — the exact inertness this config exists to prevent. Fail loudly on
    // a busy port instead of silently drifting off the trusted origin.
    strictPort: true,
    proxy: {
      "/events": MONITOR_ORIGIN,
      // CTL-1573: the reply route validates `Origin` against an allowlist of the
      // origins the monitor is legitimately reached by. The dev server runs on
      // :5173, so a proxied POST would arrive as `Origin: http://localhost:5173`
      // and 403.
      //
      // Fixed HERE rather than by widening the server's allowlist: the proxy is
      // what makes a same-origin dev request look cross-origin, so the proxy is
      // what should present the true target origin. Doing it server-side would
      // mean trusting :5173 in production too, where it is just an ordinary
      // local port. `dev:ui` also only starts Vite — the monitor runs
      // out-of-band — so an env gate on the monitor could not activate from
      // this workflow anyway.
      //
      // The rewrite is CONDITIONAL. A blanket `headers: { Origin }` would make
      // this proxy an origin-laundering service while `dev:ui` is running: any
      // other page (another localhost port, a LAN host) could POST a simple
      // `text/plain` JSON body to http://localhost:5173/api/ticket/X/reply, have
      // its hostile Origin replaced with a trusted one, and get the Linear side
      // effect — CORS would hide the response, but the write would already have
      // happened. So only a genuine same-origin request from THIS dev server is
      // rewritten; anything else is forwarded verbatim for the monitor to reject.
      "/api": {
        target: MONITOR_ORIGIN,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq, req) => {
            if (shouldRewriteOrigin(req.headers.origin)) {
              proxyReq.setHeader("origin", MONITOR_ORIGIN);
            }
            // No Origin (curl) or a foreign one: pass through untouched.
          });
        },
      },
    },
  },
});
