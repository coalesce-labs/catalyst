import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignoreExportsUsedInFile: true,
  workspaces: {
    ".": {
      entry: [
        "server.ts",
        "catalyst-session.ts",
        "analyze-events.ts",
        "cli/hud.tsx",
      ],
      project: ["**/*.{ts,tsx}", "!ui/**", "!public/**"],
    },
    ui: {
      entry: ["index.html", "board.html", "src/board/main.tsx", "src/components/ui/*.{ts,tsx}", "src/components/kibo-ui/**/*.{ts,tsx}"],
      project: ["src/**/*.{ts,tsx}"],
      ignoreDependencies: [
        "tailwindcss",
        "tw-animate-css",
        "class-variance-authority",
      ],
    },
  },
};

export default config;
