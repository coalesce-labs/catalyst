import { readFileSync } from "node:fs";
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import starlightLlmsTxt from "starlight-llms-txt";
import starlightChangelogs, {
  makeChangelogsSidebarLinks,
} from "starlight-changelogs";
import mermaid from "astro-mermaid";
import { loadEnv } from "vite";

const { PUBLIC_POSTHOG_KEY } = loadEnv(
  process.env.NODE_ENV || "production",
  new URL(".", import.meta.url).pathname,
  "",
);

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
      routeMiddleware: "./src/routeData.ts",
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
          label: "Guided Workflows",
          autogenerate: { directory: "guided-workflows" },
        },
        {
          label: "Observability",
          autogenerate: { directory: "observability" },
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
        ...(PUBLIC_POSTHOG_KEY
          ? [
              {
                tag: "script",
                content: `
                  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageviewId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
                  posthog.init('${PUBLIC_POSTHOG_KEY}', {
                    api_host: 'https://us.i.posthog.com',
                    person_profiles: 'identified_only',
                    persistence: 'localStorage+cookie',
                  });
                `,
              },
              {
                tag: "script",
                content: `
                  document.addEventListener('DOMContentLoaded', function() {
                    // Code copy button tracking (Expressive Code)
                    document.addEventListener('click', function(e) {
                      var btn = e.target.closest('.expressive-code .copy button, .expressive-code button.copy');
                      if (btn && window.posthog) {
                        window.posthog.capture('docs_code_copied', {
                          page: window.location.pathname,
                        });
                      }
                    });

                    // Search query tracking (Starlight Pagefind, debounced)
                    var searchTimeout;
                    document.addEventListener('input', function(e) {
                      if (!e.target.matches('[data-pagefind-ui] input, .pagefind-ui__search-input')) return;
                      clearTimeout(searchTimeout);
                      searchTimeout = setTimeout(function() {
                        var query = e.target.value.trim();
                        if (query.length >= 3 && window.posthog) {
                          window.posthog.capture('docs_search', {
                            query: query,
                            page: window.location.pathname,
                          });
                        }
                      }, 1000);
                    });

                    // "Was this helpful?" — configure as a PostHog survey in the dashboard
                    // (zero-code, auto-rendered by the PostHog snippet)
                  });
                `,
              },
            ]
          : []),
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
