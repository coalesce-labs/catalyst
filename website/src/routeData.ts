import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

export const onRequest = defineRouteMiddleware((context) => {
  const { id } = context.locals.starlightRoute;
  // Home page gets the branded OG card (CTL-152). Leaf docs pages use the
  // astro-og-canvas per-page generator so each page has a card with its own title.
  const isHome = !id || id === "index";
  const slug = id || "index";
  const ogImageUrl = isHome
    ? new URL("/og-card.png", context.site ?? context.url).href
    : new URL(`/og/${slug}.png`, context.site ?? context.url).href;
  const { head } = context.locals.starlightRoute;
  head.push({
    tag: "meta",
    attrs: { property: "og:image", content: ogImageUrl },
  });
  head.push({
    tag: "meta",
    attrs: { name: "twitter:image", content: ogImageUrl },
  });
});
