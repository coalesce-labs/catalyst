import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightChangelogs from "starlight-changelogs";
import mermaid from "astro-mermaid";

export default defineConfig({
  site: "https://catalyst.coalescelabs.ai",
  integrations: [
    mermaid(),
    starlight({
      title: "Catalyst",
      favicon: "/favicon.svg",
      logo: {
        src: "./public/favicon.svg",
        alt: "Catalyst",
      },
      description:
        "AI-assisted development workflows for Claude Code — skills, agents, and orchestration plugins.",
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
          label: "Reference",
          autogenerate: { directory: "reference" },
        },
        {
          label: "Plugins",
          autogenerate: { directory: "plugins" },
        },
      ],
      head: [
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            sizes: "180x180",
            href: "/apple-touch-icon.png",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/png",
            sizes: "192x192",
            href: "/icon-192.png",
          },
        },
      ],
      plugins: [starlightLlmsTxt(), starlightChangelogs()],
      customCss: ["./src/styles/custom.css"],
    }),
    sitemap(),
  ],
});
