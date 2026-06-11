import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignoreExportsUsedInFile: true,
  // Tags: honour @ignore JSDoc annotation on exports (e.g. DetailBody, contract types).
  tags: ["-ignore"],
  // Unused files (dead code from prior tickets — pending cleanup):
  ignoreFiles: [
    "ui/src/components/layout/sidebar.tsx",
    "ui/src/components/workspace-switcher.tsx",
  ],
  workspaces: {
    ".": {
      entry: [
        "server.ts",
        "catalyst-session.ts",
        "analyze-events.ts",
        "cli/hud.tsx",
        "bin/gen-attribute-audit.ts",
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
        // CTL-1003: loaded via `@plugin "@tailwindcss/typography"` in app.css —
        // knip doesn't parse CSS @plugin imports, so it can't see the usage.
        "@tailwindcss/typography",
      ],
    },
  },
};

export default config;
