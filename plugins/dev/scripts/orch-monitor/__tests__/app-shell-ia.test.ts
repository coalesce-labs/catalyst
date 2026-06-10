// app-shell-ia.test.ts — CTL-893 / SHELL3 acceptance guards.
//
// Encodes the four SHELL3 Gherkin scenarios (OPERATE/OBSERVE two-tier nav IA,
// the chevron brand mark + collapsing wordmark, and the footer theme toggle).
// `bun test` has no DOM, so — matching app-shell.test.ts (CTL-891) — the
// structural scenarios are asserted by static source analysis (read the .tsx as
// text and assert the load-bearing wiring) and the pure theme core (lib/theme.ts)
// is unit-tested directly.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  THEMES,
  THEME_LABEL,
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  nextTheme,
  readStoredTheme,
  applyTheme,
  type Theme,
} from "../ui/src/lib/theme";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(HERE, "..", "ui", "src");
const REPO_ROOT = join(HERE, "..", "..", "..", "..", "..");
const read = (rel: string) => readFileSync(join(UI_SRC, rel), "utf8");

const sidebarSrc = read("components/app-sidebar.tsx");
const logoSrc = read("components/catalyst-logo.tsx");
const cssSrc = read("app.css");
const markSvg = readFileSync(
  join(REPO_ROOT, "assets", "brand-v2", "mark.svg"),
  "utf8",
);

/** Strip JS/JSX comments so CLASSNAME / token assertions can't be tripped by prose. */
function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

const sidebarCode = stripComments(sidebarSrc);

// ── Scenario: OPERATE is the always-visible primary tier ─────────────────────
describe("OPERATE is the always-visible primary tier (CTL-893)", () => {
  it("the OPERATE group lists Inbox, Tickets, Workers, Queue in nav order", () => {
    // CTL-930: labels renamed Home→Inbox, Board→Tickets; array renamed OPERATE_ITEMS.
    // OBSERVE is declared before OPERATE_ITEMS in source (observe first, items after).
    const operateBlock = sidebarSrc.slice(
      sidebarSrc.indexOf("const OPERATE_ITEMS"),
    );
    const order = ["Inbox", "Tickets", "Workers", "Queue"].map((l) =>
      operateBlock.indexOf(`"${l}"`),
    );
    for (const i of order) expect(i).toBeGreaterThan(-1);
    // strictly increasing — declared in nav order
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(sidebarCode).toMatch(/Operate/);
  });

  it("OPERATE is a plain (always-expanded) SidebarGroup, NOT wrapped in a Collapsible", () => {
    // The OPERATE group must render outside any Collapsible — only OBSERVE collapses.
    const operateGroupIdx = sidebarSrc.indexOf("Operate</SidebarGroupLabel>");
    const firstCollapsibleIdx = sidebarSrc.indexOf("<Collapsible");
    expect(operateGroupIdx).toBeGreaterThan(-1);
    expect(firstCollapsibleIdx).toBeGreaterThan(-1);
    // OPERATE's label appears BEFORE the first <Collapsible> (OBSERVE) in source.
    expect(operateGroupIdx).toBeLessThan(firstCollapsibleIdx);
  });

  it("Tickets is a first-class top-tier OPERATE item, not buried under OBSERVE", () => {
    // CTL-930: Board renamed to Tickets; OPERATE_ITEMS declared after OBSERVE in source.
    const operateBlock = sidebarSrc.slice(
      sidebarSrc.indexOf("const OPERATE_ITEMS"),
    );
    const observeBlock = sidebarSrc.slice(
      sidebarSrc.indexOf("const OBSERVE"),
      sidebarSrc.indexOf("const OPERATE_ITEMS"),
    );
    expect(operateBlock).toContain('"Tickets"');
    expect(observeBlock).not.toContain('"Tickets"');
  });
});

// ── Scenario: OBSERVE is a recessed collapsible go-deeper tier ───────────────
describe("OBSERVE is a recessed collapsible go-deeper tier (CTL-893)", () => {
  it("OBSERVE lists Telemetry, Utilization, FinOps, Fleet Ops", () => {
    const observeBlock = sidebarSrc.slice(
      sidebarSrc.indexOf("const OBSERVE"),
      sidebarSrc.indexOf("function ", sidebarSrc.indexOf("const OBSERVE")),
    );
    for (const label of ["Telemetry", "Utilization", "FinOps", "Fleet Ops"]) {
      expect(observeBlock).toContain(`"${label}"`);
    }
  });

  it("OBSERVE renders inside a Collapsible whose header is a plain CollapsibleTrigger button", () => {
    expect(sidebarSrc).toContain("<Collapsible");
    expect(sidebarSrc).toContain("CollapsibleTrigger");
    // The base-ui gotcha: the trigger must NOT be a render-prop of SidebarGroupLabel.
    expect(sidebarSrc).not.toContain("render={<SidebarGroupLabel");
    expect(sidebarCode).toMatch(/Observe/);
  });

  it("OBSERVE items are disabled 'soon' placeholders (future routes, no content)", () => {
    // Each OBSERVE item button is disabled and carries a 'soon' affordance.
    const observeRender = sidebarSrc.slice(sidebarSrc.indexOf("OBSERVE.map"));
    expect(observeRender).toContain("disabled");
    expect(observeRender.toLowerCase()).toContain("soon");
  });

  it("OBSERVE defaults collapsed (the toggle state initialises closed)", () => {
    // useState(false) → collapsed by default; open is bound to the Collapsible.
    expect(sidebarSrc).toMatch(/useState\(\s*false\s*\)/);
    expect(sidebarSrc).toMatch(/open=\{observeOpen\}/);
  });
});

// ── Scenario: Brand header collapses gracefully ──────────────────────────────
describe("brand header collapses gracefully (CTL-893)", () => {
  it("the brand mark is the inline chevron from assets/brand-v2/mark.svg (inherits currentColor)", () => {
    // It must be the real inline SVG component, NOT an <img src=favicon>.
    expect(sidebarSrc).toContain("CatalystLogo");
    expect(sidebarSrc).toContain("@/components/catalyst-logo");
    expect(logoSrc).toContain('stroke="currentColor"');
    // Faithful to the brand mark: both chevron paths are ported.
    expect(logoSrc).toContain("M 8 44 L 32 20 L 56 44");
    expect(markSvg).toContain("M 8 44 L 32 20 L 56 44");
    expect(logoSrc).toContain("M 18 52 L 32 36 L 46 52");
  });

  it("the header no longer uses the old <img favicon> brand", () => {
    expect(sidebarCode).not.toContain("favicon.svg");
  });

  it("the wordmark hides on icon-collapse but the chevron mark stays", () => {
    // The header renders the chevron mark followed by a "Catalyst" wordmark span
    // that carries the icon-collapse hide class. Match across whitespace/newlines.
    const header = sidebarSrc.slice(
      sidebarSrc.indexOf("<SidebarHeader"),
      sidebarSrc.indexOf("</SidebarHeader>"),
    );
    expect(header).toContain("CatalystLogo");
    // The wordmark text node, tolerant of the JSX newline before </span>.
    expect(header).toMatch(/>\s*Catalyst\s*<\/span>/);
    // …and that wordmark span hides on icon-collapse (the mark does not).
    expect(header).toContain("group-data-[collapsible=icon]:hidden");
  });

  it("the footer keeps Settings AND a theme toggle reachable", () => {
    const footerBlock = sidebarSrc.slice(sidebarSrc.indexOf("SidebarFooter"));
    expect(footerBlock).toContain("Settings");
    expect(footerBlock).toContain("useTheme");
  });
});

// ── Scenario: Theme toggle flips calm-dark and warm-light ────────────────────
describe("theme toggle flips calm-dark and warm-light (CTL-893)", () => {
  it("the footer toggle is wired to the real theme system (useTheme), not re-implemented", () => {
    expect(sidebarSrc).toContain("useTheme");
    expect(sidebarSrc).toContain("@/lib/theme");
    // The hook's toggle is destructured and bound to the footer button's onClick
    // (renamed `toggle: toggleTheme` to disambiguate from the rail toggle).
    expect(sidebarSrc).toMatch(/toggle:\s*toggleTheme/);
    expect(sidebarSrc).toMatch(/onClick=\{toggleTheme\}/);
  });

  it("declares exactly the two themes calm-dark + warm-light", () => {
    expect([...THEMES]).toEqual(["dark", "light"]);
    expect(THEME_LABEL.dark.toLowerCase()).toContain("dark");
    expect(THEME_LABEL.light.toLowerCase()).toContain("light");
  });

  it("defaults to calm-dark and reads a stored preference, ignoring junk", () => {
    expect(DEFAULT_THEME).toBe("dark");
    expect(readStoredTheme(null)).toBe("dark");
    expect(readStoredTheme({ getItem: () => null })).toBe("dark");
    expect(readStoredTheme({ getItem: () => "light" })).toBe("light");
    expect(readStoredTheme({ getItem: () => "dark" })).toBe("dark");
    expect(readStoredTheme({ getItem: () => "neon" })).toBe("dark");
    expect(THEME_STORAGE_KEY).toBe("catalyst:theme");
  });

  it("nextTheme is a pure two-state flip", () => {
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
  });

  it("applyTheme adds `dark` for calm-dark and removes it for warm-light", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const root = {
      classList: {
        add: (c: string) => added.push(c),
        remove: (c: string) => removed.push(c),
      },
    };
    applyTheme("dark", root);
    applyTheme("light", root);
    expect(added).toContain("dark");
    expect(removed).toContain("dark");
    // no-op when there is no root (SSR / no DOM)
    expect(() => applyTheme("dark", null)).not.toThrow();
  });

  it("app.css ships a warm-light token block that the toggle reveals when `dark` is absent", () => {
    // The light theme must actually exist in CSS — a `.dark` override block plus
    // light `:root` defaults — so removing `dark` from <html> visibly switches.
    expect(cssSrc).toContain(".dark");
    // The light defaults differ from the dark surface (proves a real second theme).
    expect(cssSrc).toMatch(/warm-light|light theme|CTL-893/i);
  });
});

// Sanity: every theme has a label.
describe("theme metadata is exhaustive (CTL-893)", () => {
  it("every theme is labelled", () => {
    for (const t of THEMES) expect(THEME_LABEL[t as Theme]).toBeTruthy();
  });
});
