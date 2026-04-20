import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignoreExportsUsedInFile: true,
  workspaces: {
    ".": {
      entry: ["server.ts", "catalyst-session.ts"],
      project: ["**/*.ts", "!ui/**", "!public/**"],
    },
    ui: {
      entry: ["index.html", "src/components/ui/*.{ts,tsx}"],
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
