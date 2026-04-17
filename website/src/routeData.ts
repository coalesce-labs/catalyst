import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

export const onRequest = defineRouteMiddleware((context) => {
  const { id } = context.locals.starlightRoute;
  const slug = id || "index";
  const ogImageUrl = new URL(
    `/og/${slug}.png`,
    context.site ?? context.url,
  ).href;
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
