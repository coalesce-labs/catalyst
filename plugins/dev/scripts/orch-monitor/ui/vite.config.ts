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
        try {
          const payload = assembleBoard();
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(payload));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
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
      // CTL-730: build BOTH entries. `index.html` is the legacy dashboard
      // (served at /legacy); `board.html` is the CTL-727 board (the default
      // page at /). Without this, Vite's single-entry default only emits
      // index.html and the board is never produced for production.
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
