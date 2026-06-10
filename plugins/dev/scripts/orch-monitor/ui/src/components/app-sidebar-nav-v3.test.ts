// app-sidebar-nav-v3.test.ts — structure smoke-tests for CTL-980 nav proportion v3.
// Validates that the key presentation constants and class strings satisfy the spec:
//   - Icon size must be size-4 (16px), NOT size-6 (24px)
//   - Twistie must NOT use ml-auto (it should be ml-1, beside the label)
//   - Inactive label muting: text-sidebar-foreground/60 (not near-white)
//   - "Projects" section heading is referenced in the component source
//
// These are pure string-inspection tests against the component source — no DOM needed.
// Run:  cd ui && bun test src/components/app-sidebar-nav-v3.test.ts
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, "app-sidebar.tsx"), "utf8");

describe("CTL-980 nav proportion v3 — icon size", () => {
  it("nav-item icon uses size-4 (16px), not size-6 (24px)", () => {
    // The icon wrapper must explicitly set size-4 on the icon element.
    expect(src).toContain("size-4");
  });

  it("does NOT use size-6 on any nav-item icon", () => {
    // size-6 would be 24px — the oversized icon the ticket is fixing.
    // The only size-6 usage allowed is in the CatalystLogo (brand header), not nav icons.
    // We check that the renderOperateItem block does not reference size-6.
    // (This is a coarse check; exact line-range checks are brittle.)
    const renderBlock = src.slice(
      src.indexOf("function renderOperateItem"),
      src.indexOf("function groupContainsActive"),
    );
    expect(renderBlock).not.toContain("size-6");
  });
});

describe("CTL-980 nav proportion v3 — twistie placement", () => {
  // Extract ChevronRightIcon className attribute values (the actual class strings, not comments).
  function chevronClassNames(block: string): string[] {
    const re = /<ChevronRightIcon\s+className=\{cn\(\s*"([^"]+)"/g;
    const re2 = /<ChevronRightIcon\s+className="([^"]+)"/g;
    const results: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) results.push(m[1]);
    while ((m = re2.exec(block)) !== null) results.push(m[1]);
    return results;
  }

  it("per-project group ChevronRightIcon className does NOT start with ml-auto", () => {
    const projectBlock = src.slice(
      src.indexOf("PER-PROJECT GROUPS"),
      src.indexOf("OBSERVE — collapsible"),
    );
    const classes = chevronClassNames(projectBlock);
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).not.toMatch(/\bml-auto\b/);
    }
  });

  it("per-project group ChevronRightIcon uses ml-1 (adjacent to label)", () => {
    const projectBlock = src.slice(
      src.indexOf("PER-PROJECT GROUPS"),
      src.indexOf("OBSERVE — collapsible"),
    );
    const classes = chevronClassNames(projectBlock);
    expect(classes.some((c) => c.includes("ml-1"))).toBe(true);
  });

  it("Observe section ChevronRightIcon className does NOT use ml-auto", () => {
    const observeBlock = src.slice(
      src.indexOf("OBSERVE — collapsible"),
      src.indexOf("FOOTER"),
    );
    const classes = chevronClassNames(observeBlock);
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      expect(cls).not.toMatch(/\bml-auto\b/);
    }
  });

  it("Observe section ChevronRightIcon uses ml-1", () => {
    const observeBlock = src.slice(
      src.indexOf("OBSERVE — collapsible"),
      src.indexOf("FOOTER"),
    );
    const classes = chevronClassNames(observeBlock);
    expect(classes.some((c) => c.includes("ml-1"))).toBe(true);
  });
});

describe("CTL-980 nav proportion v3 — label muting", () => {
  it("inactive nav-item label uses text-sidebar-foreground/60 (muted, not near-white)", () => {
    // CTL-977 had near-white labels; CTL-980 mutes inactive labels to /60 opacity.
    expect(src).toContain("text-sidebar-foreground/60");
  });

  it("active nav-item label uses text-sidebar-primary (full contrast)", () => {
    // Active/selected items must be the high-contrast state.
    expect(src).toContain("text-sidebar-primary");
  });
});

describe("CTL-980 nav proportion v3 — Projects section heading", () => {
  it("renders a 'Projects' section heading above the per-project groups", () => {
    expect(src).toContain("Projects");
  });

  it("Projects heading appears before the per-project map block", () => {
    const projectsHeadingIdx = src.indexOf(">Projects<");
    const reposMapIdx = src.indexOf("{repos.map(");
    expect(projectsHeadingIdx).toBeGreaterThan(-1);
    expect(reposMapIdx).toBeGreaterThan(-1);
    // Heading must come BEFORE the map (higher up in the source)
    expect(projectsHeadingIdx).toBeLessThan(reposMapIdx);
  });
});
