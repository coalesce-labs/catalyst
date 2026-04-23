// Tests for the CTL-152 brand-v2 OG / social preview card.
//
// The OG card is the default `og:image` / `twitter:image` for catalyst.coalescelabs.ai
// and the source for the GitHub repo social preview. Source lives at
// `assets/brand-v2/og-card.svg`; raster at `assets/brand-v2/og-card.png` is regenerated
// by `assets/brand-v2/build-og-card.sh` and copied to `website/public/og-card.png`.

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, statSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

// __dirname → plugins/dev/scripts/orch-monitor/__tests__. Repo root is five levels up.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const BRAND_DIR = join(REPO_ROOT, "assets", "brand-v2");

function md5(path: string): string {
  return createHash("md5").update(readFileSync(path)).digest("hex");
}

// Parse PNG dimensions from the IHDR chunk (bytes 16-23 are width/height, big-endian u32).
function pngDimensions(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// Read the colorType byte from a PNG IHDR chunk (offset 25).
//   2 = RGB (no alpha), 6 = RGBA.
function pngColorType(path: string): number {
  const buf = readFileSync(path);
  return buf[25];
}

describe("CTL-152 — og-card.svg source", () => {
  const svgPath = join(BRAND_DIR, "og-card.svg");

  it("exists", () => {
    expect(existsSync(svgPath)).toBe(true);
  });

  const svg = existsSync(svgPath) ? readFileSync(svgPath, "utf8") : "";

  it("is a single root <svg> element with xmlns", () => {
    expect(svg).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it("declares a 1200×630 viewBox (OG standard)", () => {
    expect(svg).toMatch(/viewBox="0 0 1200 630"/);
  });

  it("declares an accessible title and role", () => {
    expect(svg).toMatch(/<title>[^<]*Catalyst[^<]*<\/title>/);
    expect(svg).toMatch(/role="img"/);
  });

  it("embeds the horizontal lockup (mark + wordmark)", () => {
    expect(svg).toContain('data-part="mark"');
    expect(svg).toContain('data-part="wordmark"');
  });

  it("preserves all 8 wordmark letter paths", () => {
    for (const letter of ["C", "A1", "T1", "A2", "L", "Y", "S", "T2"]) {
      expect(svg).toContain(`data-letter="${letter}"`);
    }
  });

  it("contains the marketing tagline", () => {
    expect(svg).toContain("AI-assisted development workflows for Claude Code");
  });

  it("references the canonical URL", () => {
    expect(svg).toContain("catalyst.coalescelabs.ai");
  });

  it("uses the Operator Console palette (Signal Amber accent)", () => {
    // The OG card bakes in hex at export time — this is a rasterization source,
    // not a themable asset. Signal Amber is the System A accent.
    expect(svg).toMatch(/#FFB547/i);
  });
});

describe("CTL-152 — og-card.png raster", () => {
  const pngPath = join(BRAND_DIR, "og-card.png");

  it("exists", () => {
    expect(existsSync(pngPath)).toBe(true);
  });

  it("is exactly 1200×630", () => {
    const { width, height } = pngDimensions(pngPath);
    expect(width).toBe(1200);
    expect(height).toBe(630);
  });

  it("is flattened RGB (no alpha) so social platforms render consistently", () => {
    expect(pngColorType(pngPath)).toBe(2);
  });

  it("is under 300 KB (acceptance criterion)", () => {
    const size = statSync(pngPath).size;
    expect(size).toBeLessThan(300 * 1024);
  });
});

describe("CTL-152 — distribution to website/public", () => {
  it("website/public/og-card.png is byte-identical to the source", () => {
    const sourcePath = join(BRAND_DIR, "og-card.png");
    const distPath = join(REPO_ROOT, "website", "public", "og-card.png");
    expect(existsSync(distPath)).toBe(true);
    expect(md5(distPath)).toBe(md5(sourcePath));
  });
});

describe("CTL-152 — build-og-card.sh", () => {
  const buildPath = join(BRAND_DIR, "build-og-card.sh");

  it("exists and is executable", () => {
    expect(existsSync(buildPath)).toBe(true);
    const mode = statSync(buildPath).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  it("is a bash script that uses rsvg-convert", () => {
    const script = readFileSync(buildPath, "utf8");
    expect(script).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(script).toContain("rsvg-convert");
  });
});

describe("CTL-152 — README documents the OG card", () => {
  it("assets/brand-v2/README.md names og-card.svg and og-card.png", () => {
    const readme = readFileSync(join(BRAND_DIR, "README.md"), "utf8");
    expect(readme).toContain("og-card.svg");
    expect(readme).toContain("og-card.png");
  });
});

describe("CTL-152 — Starlight integration", () => {
  it("routeData.ts uses og-card.png for the home page (og:image + twitter:image)", () => {
    const route = readFileSync(join(REPO_ROOT, "website", "src", "routeData.ts"), "utf8");
    // Home page gets the branded card; leaf docs pages keep astro-og-canvas.
    expect(route).toContain("/og-card.png");
    // Branch on home vs leaf — verifies the routeData change isn't accidentally
    // a blanket override that breaks per-page OG cards on docs pages.
    expect(route).toMatch(/isHome|id === "index"|\|\| !id/);
  });

  it("astro.config.mjs head pins twitter:card = summary_large_image (invariant default)", () => {
    const cfg = readFileSync(join(REPO_ROOT, "website", "astro.config.mjs"), "utf8");
    expect(cfg).toContain("twitter:card");
    expect(cfg).toContain("summary_large_image");
  });

  it("astro.config.mjs does not emit a static og:image tag (avoid first-wins duplicate with per-route)", () => {
    // routeData.ts is the single source of og:image + twitter:image. A static
    // og:image tag here would win over leaf pages' astro-og-canvas per-page
    // cards under OG spec first-wins semantics.
    const cfg = readFileSync(join(REPO_ROOT, "website", "astro.config.mjs"), "utf8");
    // A meta tag emits as `property: "og:image"` — grep for that exact shape.
    expect(cfg).not.toMatch(/property:\s*["']og:image["']/);
  });
});
