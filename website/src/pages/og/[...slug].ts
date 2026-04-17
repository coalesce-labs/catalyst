import { getCollection } from "astro:content";
import { OGImageRoute } from "astro-og-canvas";

const entries = await getCollection("docs");
const pages = Object.fromEntries(
  entries.map(({ data, id }) => [id || "index", { data }]),
);

export const { getStaticPaths, GET } = await OGImageRoute({
  pages,
  param: "slug",
  getImageOptions: (_id, page: (typeof pages)[string]) => ({
    title: page.data.title,
    description: page.data.description ?? "",
    bgGradient: [
      [23, 23, 33],
      [12, 10, 24],
    ],
    border: {
      color: [79, 70, 229],
      width: 20,
      side: "inline-start",
    },
    padding: 100,
    logo: {
      path: "./public/icon-192.png",
      size: [140],
    },
    font: {
      title: {
        size: 80,
        weight: "Bold",
        color: [255, 255, 255],
        lineHeight: 1.15,
      },
      description: {
        size: 36,
        weight: "Normal",
        color: [199, 210, 254],
        lineHeight: 1.45,
      },
    },
  }),
});
