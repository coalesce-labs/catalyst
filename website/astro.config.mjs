import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightChangelogs from "starlight-changelogs";

export default defineConfig({
  site: "https://catalyst.coalescelabs.ai",
  integrations: [
    starlight({
      title: "Catalyst",
      description:
        "AI-assisted development workflows for Claude Code — agents, commands, and orchestration plugins.",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/coalesce-labs/catalyst",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          autogenerate: { directory: "getting-started" },
        },
        {
          label: "Guides",
          autogenerate: { directory: "guides" },
        },
        {
          label: "Plugins",
          autogenerate: { directory: "plugins" },
        },
        {
          label: "Integrations",
          autogenerate: { directory: "integrations" },
        },
        {
          label: "Reference",
          autogenerate: { directory: "reference" },
        },
        {
          label: "Releases",
          autogenerate: { directory: "releases" },
        },
        {
          label: "Contributing",
          autogenerate: { directory: "contributing" },
        },
      ],
      plugins: [starlightLlmsTxt(), starlightChangelogs()],
      customCss: ["./src/styles/custom.css"],
    }),
    sitemap(),
  ],
});
