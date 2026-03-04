import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";
import { changelogsLoader } from "starlight-changelogs/loader";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  changelogs: defineCollection({
    loader: changelogsLoader([
      {
        provider: "keep-a-changelog",
        base: "changelog/catalyst-dev",
        changelog: "../plugins/dev/CHANGELOG.md",
        title: "catalyst-dev",
      },
      {
        provider: "keep-a-changelog",
        base: "changelog/catalyst-pm",
        changelog: "../plugins/pm/CHANGELOG.md",
        title: "catalyst-pm",
      },
      {
        provider: "keep-a-changelog",
        base: "changelog/catalyst-meta",
        changelog: "../plugins/meta/CHANGELOG.md",
        title: "catalyst-meta",
      },
      {
        provider: "keep-a-changelog",
        base: "changelog/catalyst-analytics",
        changelog: "../plugins/analytics/CHANGELOG.md",
        title: "catalyst-analytics",
      },
      {
        provider: "keep-a-changelog",
        base: "changelog/catalyst-debugging",
        changelog: "../plugins/debugging/CHANGELOG.md",
        title: "catalyst-debugging",
      },
    ]),
  }),
};
