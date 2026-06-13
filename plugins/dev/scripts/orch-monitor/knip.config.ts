import type { KnipConfig } from "knip";

const config: KnipConfig = {
  ignoreExportsUsedInFile: true,
  // Tags: honour @ignore JSDoc annotation on exports (e.g. DetailBody, contract types).
  tags: ["-ignore"],
  // Unused files (dead code from prior tickets — pending cleanup):
  ignoreFiles: [
    "ui/src/components/layout/sidebar.tsx",
    "ui/src/components/workspace-switcher.tsx",
    // CTL-1100: shared governance building blocks shipped ahead of their
    // consuming pages. Per the plan's scope boundary ("No Process / Execution /
    // Rulebook surfaces — those are CTL-1101 / CTL-1102 / CTL-1103, which this
    // ticket BLOCKS. We ship the shared building blocks, not the pages."), these
    // have no consumer until those follow-up tickets land. Remove each entry as
    // its consuming page wires the component in.
    "ui/src/components/governance/derivation-tree.tsx",
    "ui/src/components/governance/governance-flags-chip.tsx",
    "ui/src/components/governance/journey-strip.tsx",
    "ui/src/components/governance/source-sheet.tsx",
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
