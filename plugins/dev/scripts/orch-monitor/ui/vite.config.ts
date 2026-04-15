import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
