import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

// Repo root is three levels up from plugins/dev/scripts/orch-monitor/__tests__.
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const BRAND_DIR = join(REPO_ROOT, "assets", "brand-v2");

function read(rel: string): string {
  return readFileSync(join(BRAND_DIR, rel), "utf8");
}

// A hex color anywhere in an SVG would mean the mark doesn't theme via currentColor.
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/;

describe("brand-v2 — wordmark.svg", () => {
  const svg = read("wordmark.svg");

  it("is a single root <svg> element with xmlns", () => {
    expect(svg).toMatch(/^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });

  it("uses currentColor (not a hex literal)", () => {
    expect(svg).toMatch(/currentColor/);
    expect(HEX_LITERAL.test(svg)).toBe(false);
  });

  it("declares an accessible title and role", () => {
    expect(svg).toMatch(/<title>Catalyst<\/title>/);
    expect(svg).toMatch(/role="img"/);
    expect(svg).toMatch(/aria-label="Catalyst"/);
  });

  it("declares a non-empty viewBox", () => {
    // CTL-200 ships the wordmark as a Space Grotesk Medium font outline. The
    // viewBox spans cap-height plus ascender/descender extents, so it isn't
    // simply "0 0 W 100". Guard the structural intent: a real viewBox with
    // positive width and height.
    const m = svg.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/);
    expect(m).toBeTruthy();
    if (m) {
      expect(parseFloat(m[3])).toBeGreaterThan(0);
      expect(parseFloat(m[4])).toBeGreaterThan(0);
    }
  });

  it("draws the wordmark as a single merged outline path", () => {
    // CTL-200 emits one merged <path> from the font outline rather than one
    // path per letter. The brand.html specimens block (below) still verifies
    // the per-letter inline shape used for design specimens.
    const paths = svg.match(/<path /g) ?? [];
    expect(paths.length).toBe(1);
  });
});

describe("brand-v2 — lockup-horizontal.svg", () => {
  const svg = read("lockup-horizontal.svg");

  it("uses currentColor (not a hex literal)", () => {
    expect(svg).toMatch(/currentColor/);
    expect(HEX_LITERAL.test(svg)).toBe(false);
  });

  it("declares an accessible title and role", () => {
    expect(svg).toMatch(/<title>Catalyst<\/title>/);
    expect(svg).toMatch(/role="img"/);
  });

  it("contains both the mark and the wordmark", () => {
    // Mark portion — chevron apex stroked paths (stacked double chevron).
    expect(svg).toContain('data-part="mark"');
    // Wordmark portion — grouped letters.
    expect(svg).toContain('data-part="wordmark"');
  });

  it("ships the wordmark plus at least 2 mark chevrons", () => {
    const paths = svg.match(/<path /g) ?? [];
    // 1 merged wordmark path + 2 chevrons (apex + inner) = 3 minimum. The
    // wordmark side is a single merged outline post-CTL-200 (Space Grotesk
    // Medium); the structural guard is the data-part assertions above.
    expect(paths.length).toBeGreaterThanOrEqual(3);
  });
});

describe("brand-v2 — lockup-stacked.svg", () => {
  const svg = read("lockup-stacked.svg");

  it("uses currentColor (not a hex literal)", () => {
    expect(svg).toMatch(/currentColor/);
    expect(HEX_LITERAL.test(svg)).toBe(false);
  });

  it("declares an accessible title and role", () => {
    expect(svg).toMatch(/<title>Catalyst<\/title>/);
    expect(svg).toMatch(/role="img"/);
  });

  it("contains both the mark and the wordmark, in that order", () => {
    const markIdx = svg.indexOf('data-part="mark"');
    const wordIdx = svg.indexOf('data-part="wordmark"');
    expect(markIdx).toBeGreaterThan(-1);
    expect(wordIdx).toBeGreaterThan(-1);
    // Mark is above (comes first in the source) in a stacked lockup.
    expect(markIdx).toBeLessThan(wordIdx);
  });

  it("ships the wordmark plus at least 2 mark chevrons", () => {
    const paths = svg.match(/<path /g) ?? [];
    // 1 merged wordmark path + 2 chevrons (apex + inner) = 3 minimum. The
    // wordmark side is a single merged outline post-CTL-200 (Space Grotesk
    // Medium); the structural guard is the data-part assertions above.
    expect(paths.length).toBeGreaterThanOrEqual(3);
  });
});

describe("brand-v2 — brand.html Lockup specimens section", () => {
  const MOCKUPS_DIR = join(
    REPO_ROOT,
    "plugins",
    "dev",
    "scripts",
    "orch-monitor",
    "public",
    "mockups",
  );
  const html = readFileSync(join(MOCKUPS_DIR, "brand.html"), "utf8");
  // Brand CSS was extracted from the inline <style> block to a sibling file
  // in CTL-178 part 2 to keep brand.html rewrite-able without blowing past
  // Claude's output-token limit. Accent-token assertions now read from there.
  const css = readFileSync(join(MOCKUPS_DIR, "brand.css"), "utf8");

  it("exposes a 'Lockup specimens' section by heading", () => {
    expect(html).toContain('data-section="lockups"');
    expect(html).toContain("Lockup specimens");
  });

  it("renders the wordmark + both lockups inline so currentColor themes them", () => {
    // Three stages inline, all eight letters per wordmark.
    for (const letter of ["C", "A1", "T1", "A2", "L", "Y", "S", "T2"]) {
      expect(html).toContain(`data-letter="${letter}"`);
    }
    // Both lockups' mark + wordmark parts are present.
    const markParts = html.match(/data-part="mark"/g) ?? [];
    const wordmarkParts = html.match(/data-part="wordmark"/g) ?? [];
    expect(markParts.length).toBeGreaterThanOrEqual(2);
    expect(wordmarkParts.length).toBeGreaterThanOrEqual(2);
  });

  it("routes the accent color through currentColor, not a hex literal", () => {
    // The stage element applies --color-accent; the SVGs must resolve via
    // currentColor. The stage styles live in the extracted brand.css.
    expect(css).toContain("var(--color-accent)");
    expect(html).toContain("./brand.css");
    expect(html).toContain('stroke="currentColor"');
  });
});

describe("brand-v2 — README clear-space + minimum-size specs", () => {
  const readme = readFileSync(join(BRAND_DIR, "README.md"), "utf8");

  it("documents a clear-space rule in units of cap-height (or mark height)", () => {
    expect(readme.toLowerCase()).toContain("clear space");
  });

  it("documents minimum sizes for both lockups", () => {
    const lower = readme.toLowerCase();
    expect(lower).toContain("minimum size");
    expect(lower).toContain("lockup-horizontal");
    expect(lower).toContain("lockup-stacked");
  });

  it("names the wordmark file", () => {
    expect(readme).toContain("wordmark.svg");
  });
});
