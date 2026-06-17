// project-mark-icon.test.tsx — component rendering tests for ProjectMarkIcon (CTL-1208, CTL-1249).
// Uses renderToStaticMarkup (no DOM/jsdom) — pure SSR snapshot assertions.
// CTL-1249: non-featured glyphs render a neutral placeholder until their per-glyph chunk resolves.
import { beforeEach, describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { ProjectMarkIcon } from "./project-mark-icon";
import { __resetGlyphCaches } from "@/lib/phosphor-icons";

beforeEach(() => __resetGlyphCaches());

describe("ProjectMarkIcon — glyph kind", () => {
  it("renders an <svg> for a FEATURED glyph synchronously (SSR)", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProjectMarkIcon, {
        mark: { kind: "glyph", name: "git-fork" },
        color: "#000",
      }),
    );
    expect(html).toContain("<svg");
  });

  it("renders a neutral placeholder (not empty) for a NON-FEATURED glyph before its chunk resolves", () => {
    __resetGlyphCaches();
    const html = renderToStaticMarkup(
      React.createElement(ProjectMarkIcon, {
        mark: { kind: "glyph", name: "airplane" },
        color: "#000",
      }),
    );
    expect(html).toContain("data-glyph-placeholder");
    expect(html).not.toBe("");
    expect(html).not.toContain("<img");
  });

  it("renders a neutral placeholder for an unknown glyph name (fail-open)", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProjectMarkIcon, {
        mark: { kind: "glyph", name: "not-a-real-icon" },
        color: "#000",
      }),
    );
    expect(html).toContain("data-glyph-placeholder");
  });
});

describe("ProjectMarkIcon — favicon + none kinds", () => {
  it("still renders an <img> for favicon and nothing for none", () => {
    expect(
      renderToStaticMarkup(
        React.createElement(ProjectMarkIcon, {
          mark: { kind: "favicon", dataUrl: "data:,", selectedPath: "x" },
          color: "#000",
        }),
      ),
    ).toContain("<img");
    expect(
      renderToStaticMarkup(
        React.createElement(ProjectMarkIcon, {
          mark: { kind: "none" },
          color: "#000",
        }),
      ),
    ).toBe("");
  });
});
