// Tests for CTL-154 — monochrome mark variants + README hero image.
//
// Monochrome variants bake-in pure black or pure white (no currentColor, no opacity) so
// surfaces that lose CSS context (email, print, stickers, terminal screenshots) still
// render the V2 mark correctly.
//
// README hero ships as a 1600×480 SVG + PNG pair (light + dark palette) referenced from
// the repo root README.md via a <picture> element for GitHub light/dark mode.

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

// __dirname → plugins/dev/scripts/orch-monitor/__tests__. Repo root is five up.
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");
const BRAND_DIR = join(REPO_ROOT, "assets", "brand-v2");
const HERO_DIR = join(BRAND_DIR, "readme-hero");

function readBrand(rel: string): string {
  return readFileSync(join(BRAND_DIR, rel), "utf8");
}

// Parse PNG dimensions from the IHDR chunk (bytes 16-23 are width/height, big-endian u32).
function pngDimensions(path: string): { width: number; height: number } {
  const buf = readFileSync(path);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// Read the colorType byte from a PNG IHDR chunk (offset 25). 2 = RGB, 6 = RGBA.
function pngColorType(path: string): number {
  const buf = readFileSync(path);
  return buf[25];
}

// Extract the viewBox attr from an SVG string.
function viewBoxOf(svg: string): string {
  const m = svg.match(/viewBox="([^"]+)"/);
  if (!m) throw new Error("no viewBox");
  return m[1];
}

// Count <path ...> occurrences.
function pathCount(svg: string): number {
  return (svg.match(/<path\b/g) ?? []).length;
}

describe("CTL-154 — monochrome mark variants", () => {
  // [mono file, source file, ink color pattern]
  const variants: [string, string, RegExp][] = [
    ["mark-mono-black.svg", "mark.svg", /stroke="#0{3,6}"/],
    ["mark-mono-white.svg", "mark.svg", /stroke="#[Ff]{3,6}"/],
    ["lockup-horizontal-mono-black.svg", "lockup-horizontal.svg", /stroke="#0{3,6}"/],
    ["lockup-horizontal-mono-white.svg", "lockup-horizontal.svg", /stroke="#[Ff]{3,6}"/],
    ["lockup-stacked-mono-black.svg", "lockup-stacked.svg", /stroke="#0{3,6}"/],
    ["lockup-stacked-mono-white.svg", "lockup-stacked.svg", /stroke="#[Ff]{3,6}"/],
  ];

  it.each(variants)("ships %s", (mono) => {
    expect(existsSync(join(BRAND_DIR, mono))).toBe(true);
  });

  it.each(variants)("%s bakes the ink color directly (no currentColor)", (mono, _src, inkRe) => {
    const svg = readBrand(mono);
    expect(inkRe.test(svg)).toBe(true);
    expect(svg).not.toContain("currentColor");
  });

  it.each(variants)("%s contains no opacity attribute (strict monochrome)", (mono) => {
    const svg = readBrand(mono);
    expect(svg).not.toMatch(/\bopacity\s*=/);
  });

  it.each(variants)("%s preserves the source viewBox", (mono, src) => {
    expect(viewBoxOf(readBrand(mono))).toBe(viewBoxOf(readBrand(src)));
  });

  it.each(variants)("%s preserves the source path count", (mono, src) => {
    expect(pathCount(readBrand(mono))).toBe(pathCount(readBrand(src)));
  });

  it.each(variants)("%s keeps the accessible title and aria-label", (mono) => {
    const svg = readBrand(mono);
    expect(svg).toMatch(/<title>Catalyst<\/title>/);
    expect(svg).toMatch(/aria-label="Catalyst"/);
  });
});

describe("CTL-154 — README hero source SVGs", () => {
  const heroes = ["readme-hero-light.svg", "readme-hero-dark.svg"];

  it.each(heroes)("ships %s at 1600x480", (file) => {
    const svg = readFileSync(join(HERO_DIR, file), "utf8");
    expect(viewBoxOf(svg)).toBe("0 0 1600 480");
  });

  it.each(heroes)("%s contains the tagline", (file) => {
    const svg = readFileSync(join(HERO_DIR, file), "utf8");
    expect(svg).toContain("Portable workflows for Claude Code");
  });

  it.each(heroes)("%s embeds the horizontal lockup geometry", (file) => {
    const svg = readFileSync(join(HERO_DIR, file), "utf8");
    // The horizontal lockup's wordmark ships eight data-letter="..." attributes; the hero
    // inlines the lockup so those attributes propagate.
    for (const letter of ["C", "A1", "T1", "A2", "L", "Y", "S", "T2"]) {
      expect(svg).toContain(`data-letter="${letter}"`);
    }
  });

  it("readme-hero-light.svg uses the Precision Instrument palette", () => {
    const svg = readFileSync(join(HERO_DIR, "readme-hero-light.svg"), "utf8");
    // Canvas and ink hex-baked — light variant.
    expect(svg.toUpperCase()).toContain("#FAFAF7");
    expect(svg.toUpperCase()).toContain("#2C3E64");
  });

  it("readme-hero-dark.svg uses the Operator Console palette", () => {
    const svg = readFileSync(join(HERO_DIR, "readme-hero-dark.svg"), "utf8");
    expect(svg.toUpperCase()).toContain("#0B0D10");
    expect(svg.toUpperCase()).toContain("#FFB547");
  });
});

describe("CTL-154 — README hero rasterized PNGs", () => {
  const heroes = ["readme-hero-light.png", "readme-hero-dark.png"];

  it.each(heroes)("ships %s", (file) => {
    expect(existsSync(join(HERO_DIR, file))).toBe(true);
  });

  it.each(heroes)("%s is 1600x480", (file) => {
    const { width, height } = pngDimensions(join(HERO_DIR, file));
    expect(width).toBe(1600);
    expect(height).toBe(480);
  });

  it.each(heroes)("%s is under 200 KB", (file) => {
    const size = statSync(join(HERO_DIR, file)).size;
    // 200 KB budget per ticket AC. 200 KB = 204800 bytes.
    expect(size).toBeLessThan(200 * 1024);
  });

  it.each(heroes)("%s has no alpha channel (solid background)", (file) => {
    // GitHub renders PNGs against its own canvas; no-alpha keeps the baked background flat.
    expect(pngColorType(join(HERO_DIR, file))).toBe(2); // 2 = RGB
  });
});

describe("CTL-154 — build script", () => {
  it("readme-hero/build.sh exists and is executable", () => {
    const buildPath = join(HERO_DIR, "build.sh");
    expect(existsSync(buildPath)).toBe(true);
    expect(statSync(buildPath).mode & 0o111).toBeGreaterThan(0);
  });
});

describe("CTL-154 — README.md wiring", () => {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");

  it("opens with a <picture> element before the first H1", () => {
    const pictureIdx = readme.indexOf("<picture>");
    const h1Idx = readme.search(/^#\s+Catalyst/m);
    expect(pictureIdx).toBeGreaterThanOrEqual(0);
    expect(h1Idx).toBeGreaterThan(0);
    expect(pictureIdx).toBeLessThan(h1Idx);
  });

  it("<picture> references both the light and dark hero PNGs", () => {
    expect(readme).toContain("readme-hero-light.png");
    expect(readme).toContain("readme-hero-dark.png");
  });

  it("<picture> uses prefers-color-scheme for dark mode", () => {
    expect(readme).toMatch(/media="\(prefers-color-scheme:\s*dark\)"/);
  });
});

describe("CTL-154 — V1 catalyst-logo grep-clean", () => {
  it("author-maintained sources have no catalyst-logo.svg references", () => {
    // Scope: HTML/TSX/TS sources that humans author. The orch-monitor ships a Vite build
    // output under public/assets/*.js which is a compiled artifact — those bundles still
    // carry stale string constants until the next UI rebuild (tracked separately from
    // CTL-154 per CTL-150's plan) and are intentionally excluded from this guard.
    const ORCH_PUBLIC = join(REPO_ROOT, "plugins", "dev", "scripts", "orch-monitor", "public");
    const ORCH_UI = join(REPO_ROOT, "plugins", "dev", "scripts", "orch-monitor", "ui", "src");

    const walk = (dir: string, skip: Set<string>): string[] => {
      if (!existsSync(dir)) return [];
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const p = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(p, skip));
        else if (/\.(html|tsx?|astro)$/i.test(entry.name)) out.push(p);
      }
      return out;
    };

    // Skip Vite bundle output directory.
    const publicFiles = walk(ORCH_PUBLIC, new Set(["assets"]));
    const uiFiles = walk(ORCH_UI, new Set());

    const offenders: string[] = [];
    for (const file of [...publicFiles, ...uiFiles]) {
      if (readFileSync(file, "utf8").includes("catalyst-logo.svg")) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
