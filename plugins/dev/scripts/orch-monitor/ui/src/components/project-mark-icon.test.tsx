// project-mark-icon.test.tsx — component rendering tests for ProjectMarkIcon (CTL-1208, CTL-1233).
// Uses renderToStaticMarkup (no DOM/jsdom) — pure SSR snapshot assertions.
import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { ProjectMarkIcon } from "./project-mark-icon";
import { isPhosphorLoaded } from "@/lib/phosphor-icons";

describe("ProjectMarkIcon — glyph kind", () => {
  it("renders an svg element for a known glyph name", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProjectMarkIcon, {
        mark: { kind: "glyph", name: "git-fork" },
        color: "#9ec7f4",
        size: 14,
      }),
    );
    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
  });

  it("renders an svg for a FEATURED glyph synchronously (SSR, no full-set load)", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProjectMarkIcon, {
        mark: { kind: "glyph", name: "git-fork" },
        color: "#9ec7f4",
        size: 14,
      }),
    );
    expect(html).toContain("<svg");
  });

  it("renders nothing for a NON-FEATURED glyph before the full set loads (fail-open, CTL-1233)", () => {
    // Guard: bun shares module state across files in the same process. If phosphor-icons.test.ts
    // (or another file) already called loadPhosphorRegistry(), the cache is warm and airplane
    // resolves. Post-load rendering is correct; this assertion only fires in the pre-load case.
    if (!isPhosphorLoaded()) {
      const html = renderToStaticMarkup(
        React.createElement(ProjectMarkIcon, {
          mark: { kind: "glyph", name: "airplane" },
          color: "#9ec7f4",
          size: 14,
        }),
      );
      expect(html).toBe(""); // null → empty; sidebar/board fall back to their dot
    }
  });

  it("the svg does not use stroke (fill-only glyph)", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProjectMarkIcon, {
        mark: { kind: "glyph", name: "rocket" },
        color: "#b5d67a",
        size: 14,
      }),
    );
    expect(html).toContain("<svg");
    // Phosphor fill weight renders filled paths — no stroke attribute on the root
    expect(html).not.toMatch(/stroke="[^"none]/);
  });

  it("returns null for an unknown glyph name (fail-open)", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProjectMarkIcon, {
        mark: { kind: "glyph", name: "not-in-set" },
        color: "#9ec7f4",
      }),
    );
    expect(html).toBe("");
  });
});

describe("ProjectMarkIcon — favicon kind", () => {
  it("renders an img element with the dataUrl as src", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProjectMarkIcon, {
        mark: { kind: "favicon", dataUrl: "data:image/svg+xml;base64,ABC", selectedPath: "favicon.svg" },
        color: "#9ec7f4",
        size: 16,
      }),
    );
    expect(html).toContain("<img");
    expect(html).toContain('src="data:image/svg+xml;base64,ABC"');
    expect(html).not.toContain("<svg");
  });
});

describe("ProjectMarkIcon — none kind", () => {
  it("renders nothing (empty string)", () => {
    const html = renderToStaticMarkup(
      React.createElement(ProjectMarkIcon, {
        mark: { kind: "none" },
        color: "#9ec7f4",
      }),
    );
    expect(html).toBe("");
  });
});
