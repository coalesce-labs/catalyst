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
      // Build BOTH entries.
      // CTL-892 / SHELL2: `index.html` (→ App → AppShell) is now the canonical
      // app shell served at `/` AND `/legacy` — it hosts the dense board as the
      // "board" surface inside the shared SidebarInset (one shell, two densities).
      // `board.html` survives as the standalone legacy/fallback board entry served
      // at `/board`; it still carries the FND deep-link router (/ticket/$id,
      // /worker/$id) until that migrates into the shell. (Before SHELL2, CTL-730
      // served board.html raw at `/`.) Without both inputs, Vite's single-entry
      // default only emits index.html and the standalone board is never produced.
      input: {
        main: resolve(__dirname, "index.html"),
        board: resolve(__dirname, "board.html"),
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
