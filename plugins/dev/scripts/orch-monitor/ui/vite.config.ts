import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { assembleBoard } from "../lib/board-data.mjs";

// CTL-727: serve the live board payload from the dev server (Node side), so the
// React board can fetch real execution-core state without the legacy :7400
// monitor. Lives outside /api so it bypasses the proxy below.
function boardData(): Plugin {
  return {
    name: "catalyst-board-data",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url || !req.url.startsWith("/board-data")) return next();
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
  },
  server: {
    proxy: {
      "/events": "http://localhost:7400",
      "/api": "http://localhost:7400",
    },
  },
});
