import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { assembleBoard } from "../lib/board-data.mjs";

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
    },
  },
  build: {
    outDir: resolve(__dirname, "../public"),
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
    proxy: {
      "/events": "http://localhost:7400",
      "/api": "http://localhost:7400",
    },
  },
});
