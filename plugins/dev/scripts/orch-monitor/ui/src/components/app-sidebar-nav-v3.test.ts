// app-sidebar-nav-v3.test.ts — structure smoke-tests for CTL-980 nav proportion v3
// and CTL-981 nav final calibration.
// Validates that the key presentation constants and class strings satisfy the spec:
//   - Icon size must be size-4 (16px), NOT size-6 (24px)
//   - Twistie must NOT use ml-auto (it should be ml-1, beside the label)
//   - Inactive label weight: font-medium (500), NOT weight 400 (CTL-981)
//   - Inactive label contrast: text-sidebar-foreground/72 (raised from /60, CTL-981)
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

describe("CTL-1034 sidebar sections — twistie right-aligned (CTL-977 convention)", () => {
  // Extract ChevronRightIcon className attribute values (the actual class strings, not comments).
  function chevronClassNames(block: string): string[] {
    const re = /<ChevronRightIcon\s+className=\{cn\(\s*\n?\s*"([^"]+)"/g;
    const re2 = /<ChevronRightIcon\s+className="([^"]+)"/g;
    const results: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) results.push(m[1]);
    while ((m = re2.exec(block)) !== null) results.push(m[1]);
    return results;
  }

  it("per-project group ChevronRightIcon is right-aligned via ml-auto (CTL-1034)", () => {
    // CTL-1034 §1: the twistie is RIGHT-aligned again (the CTL-977 convention) so each
    // section header reads "Adva ········ ⌄". The ml-auto lives in the cn() conditional
    // (ml-auto when there is no leading signal dot); assert the class is referenced.
    const projectBlock = src.slice(
      src.indexOf("PER-PROJECT GROUPS"),
      src.indexOf("OBSERVE — collapsible"),
    );
    expect(projectBlock).toContain("ml-auto");
  });

  it("Observe section ChevronRightIcon is right-aligned via ml-auto (CTL-1034)", () => {
    const observeBlock = src.slice(
      src.indexOf("OBSERVE — collapsible"),
      src.indexOf("FOOTER"),
    );
    const classes = chevronClassNames(observeBlock);
    expect(classes.length).toBeGreaterThan(0);
    expect(classes.some((c) => c.includes("ml-auto"))).toBe(true);
  });
});

describe("CTL-980 nav proportion v3 — label muting", () => {
  it("active nav-item label uses text-sidebar-primary (full contrast)", () => {
    // Active/selected items must be the high-contrast state.
    expect(src).toContain("text-sidebar-primary");
  });
});

describe("CTL-981 nav final calibration — inactive label weight + contrast", () => {
  it("inactive nav-item uses font-medium (weight 500) — primary fix for thin/small appearance", () => {
    // CTL-981: weight 400→500 gives the text body/presence so it stops reading thin.
    // This class must appear in the renderOperateItem inactive branch.
    const renderBlock = src.slice(
      src.indexOf("function renderOperateItem"),
      src.indexOf("function groupContainsActive"),
    );
    expect(renderBlock).toContain("font-medium");
  });

  it("inactive nav-item contrast is /72, NOT the old /60", () => {
    // CTL-981: opacity raised from /60 to /72 so labels read like Linear's lch(60) gray.
    const renderBlock = src.slice(
      src.indexOf("function renderOperateItem"),
      src.indexOf("function groupContainsActive"),
    );
    expect(renderBlock).toContain("text-sidebar-foreground/72");
    expect(renderBlock).not.toContain("text-sidebar-foreground/60");
  });

  it("active nav-item still uses text-sidebar-primary (high-contrast accent, clearly above /72)", () => {
    const renderBlock = src.slice(
      src.indexOf("function renderOperateItem"),
      src.indexOf("function groupContainsActive"),
    );
    expect(renderBlock).toContain("text-sidebar-primary");
  });
});

describe("CTL-1034 — project headers read as Title-Cased headings", () => {
  it("the project header is rendered via displayCaseName (Title Case), not the raw repo key", () => {
    // CTL-1034 §2: "adva" → "Adva". The per-project header must spell the repo
    // short-name out through the CTL-1012 display-name helper, not render it verbatim.
    expect(src).toContain("displayCaseName");
    const projectBlock = src.slice(
      src.indexOf("PER-PROJECT GROUPS"),
      src.indexOf("OBSERVE — collapsible"),
    );
    // The header label is the display-cased repo, with a verbatim fallback.
    expect(projectBlock).toContain("displayCaseName(repo)");
    // The old raw `{repo}` label node (the minuscule lowercase row) is gone — the
    // header now renders the display-cased {repoLabel} instead.
    expect(projectBlock).toContain("{repoLabel}");
  });

  it("the project header trigger uses heading-grade weight/size, not the /45 11px row", () => {
    // CTL-1034 §2: project headers sit at the weight/size of the SidebarGroupLabels
    // (text-xs / font-medium), bumped to /80 contrast — NOT the muted /45 11px chrome
    // the GROUP_TRIGGER_BASE rows use.
    const headerTrigger = src.slice(
      src.indexOf("PROJECT_HEADER_TRIGGER = cn("),
      src.indexOf(");", src.indexOf("PROJECT_HEADER_TRIGGER = cn(")),
    );
    expect(headerTrigger).toContain("text-xs");
    expect(headerTrigger).toContain("font-medium");
    expect(headerTrigger).toContain("text-sidebar-foreground/80");
    expect(headerTrigger).not.toContain("text-[11px]");
  });

  it("project children indent under a guide line (§3) — border-l on the child menu", () => {
    const guide = src.slice(
      src.indexOf("PROJECT_CHILD_GUIDE = cn("),
      src.indexOf(");", src.indexOf("PROJECT_CHILD_GUIDE = cn(")),
    );
    expect(guide).toContain("border-l");
    expect(guide).toContain("border-sidebar-border");
  });
});

describe("CTL-1034 — collapsed-section signal dot (§4)", () => {
  it("a SectionSignalDot rolls a collapsed section's child signal onto its header", () => {
    expect(src).toContain("function SectionSignalDot");
    expect(src).toContain("function sectionSignal");
    // Rendered only while the section is collapsed (the !isOpen / !overallIsOpen guard).
    expect(src).toMatch(/!isOpen && repoSignal && <SectionSignalDot/);
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

// ── CTL-1037 — per-project presence + honest counts + tooltips + inbox badges ──
describe("CTL-1037 §A — per-project worker presence dot", () => {
  it("the presence dot is computed per scope, not gated to 'all'", () => {
    // The old code rendered the dot only when `scopeVal === "all"`; CTL-1037 lights
    // it for every Workers row, so the render guard is just `{dot && <StatusDot`.
    expect(src).toContain("{dot && <StatusDot kind={dot} />}");
    expect(src).not.toContain('dot && scopeVal === "all" && <StatusDot');
    // liveDot now takes the scope and keys off the per-scope row count.
    expect(src).toMatch(/function liveDot\(s: Surface, scopeVal: string\)/);
  });
});

describe("CTL-1037 §B — honest nav counts + clarifying tooltips", () => {
  it("Workers/Queue counts come from the resident snapshot (overall + per-project)", () => {
    // Derived from payload via the honest CTL-1032 classification, NOT the server's
    // workers.length nav-signal.
    expect(src).toContain("overallWorkerCount(payload)");
    expect(src).toContain("projectWorkerCount(payload, scopeVal)");
    expect(src).toContain("overallQueueDepth(payload)");
    expect(src).toContain("projectQueueDepth(payload, scopeVal)");
  });

  it("the Workers row count hides the zero, the Queue row keeps it", () => {
    // Workers: only assigned when > 0.
    expect(src).toContain("if (workerN > 0) countBadge = workerN");
    // Queue: assigned unconditionally so the 0 stays visible (capacity signal).
    expect(src).toContain("countBadge = queueN");
  });

  it("rows carry an unambiguous hover tooltip", () => {
    expect(src).toContain("active worker");
    expect(src).toContain("waiting for a slot");
    // The tooltip string is threaded into the SidebarMenuButton.
    expect(src).toContain("tooltip={rowTooltip}");
  });
});

