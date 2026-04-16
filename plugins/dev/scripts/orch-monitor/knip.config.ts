import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: ["server.ts", "catalyst-session.ts"],
      project: ["**/*.ts", "!ui/**", "!public/**"],
    },
    ui: {
      entry: ["index.html"],
      project: ["src/**/*.{ts,tsx}"],
      ignoreDependencies: ["tailwindcss"],
    },
  },
};

export default config;
