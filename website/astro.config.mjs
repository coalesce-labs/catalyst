import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightChangelogs, {
  makeChangelogsSidebarLinks,
} from "starlight-changelogs";
import mermaid from "astro-mermaid";

function getLatestVersion(changelogPath) {
  const content = readFileSync(new URL(changelogPath, import.meta.url), "utf8");
  const match = content.match(/^## \[(\d+\.\d+\.\d+)]/m);
  return match ? match[1] : null;
}

const plugins = [
  { name: "catalyst-dev", changelog: "../plugins/dev/CHANGELOG.md" },
  { name: "catalyst-pm", changelog: "../plugins/pm/CHANGELOG.md" },
  { name: "catalyst-meta", changelog: "../plugins/meta/CHANGELOG.md" },
  { name: "catalyst-analytics", changelog: "../plugins/analytics/CHANGELOG.md" },
  { name: "catalyst-debugging", changelog: "../plugins/debugging/CHANGELOG.md" },
];

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
        {
          label: "Changelogs",
          items: makeChangelogsSidebarLinks(
            plugins.map(({ name, changelog }) => {
              const version = getLatestVersion(changelog);
              return {
                type: "all",
                base: `changelog/${name}`,
                label: version ? `${name} v${version}` : name,
              };
            }),
          ),
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
