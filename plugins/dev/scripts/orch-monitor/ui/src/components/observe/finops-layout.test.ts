// finops-layout.test.ts — a structural regression guard for the FinOps scroll
// column (CTL hero/spend collapse fix).
//
// THE BUG: finops-surface's root container is a height-constrained flex column
// (`flex h-full min-h-0 flex-col … overflow-y-auto`). ChartCard renders an
// `overflow-hidden` Panel with the flex default `shrink:1`, so under the column's
// height constraint the "Today's spend" hero card and the "Spend over time" card
// SHRANK to clipped min-content (~2px) instead of the column scrolling — the hero
// number vanished before scroll (violates design Principle 1: the surface's ONE
// answer must lead).
//
// THE INVARIANT: every DIRECT child of that scroll column must keep its natural
// height (`shrink-0`) so the column's `overflow-y-auto` scrolls instead of
// collapsing the children. CSS layout is not unit-testable without a DOM render
// harness (none is installed — the observe suites are pure-logic), so this is a
// source-structure guard: it asserts the two leading ChartCards and the breakdown
// grid carry `shrink-0`, and that the Panel base classes were NOT globally
// mutated (that would regress fixed-height board/dashboard cells).
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";

const surfaceSrc = readFileSync(
  new URL("./finops-surface.tsx", import.meta.url),
  "utf8",
);
const panelSrc = readFileSync(
  new URL("../ui/panel.tsx", import.meta.url),
  "utf8",
);
const chartCardSrc = readFileSync(
  new URL("./chart-card.tsx", import.meta.url),
  "utf8",
);

/** Pull the JSX opening tag for a ChartCard by its `title="…"` prop (props only,
 *  not the children). The opening tag is closed by a `>` sitting alone on its own
 *  indentation line (`\n      >`) — searching for a bare `>` would false-match the
 *  `>` inside an expression prop like `hasData={series.length > 0}`. */
function chartCardOpenTag(title: string): string {
  const idx = surfaceSrc.indexOf(`title="${title}"`);
  expect(idx).toBeGreaterThan(-1);
  // Walk back to the `<ChartCard` that owns this title.
  const open = surfaceSrc.lastIndexOf("<ChartCard", idx);
  expect(open).toBeGreaterThan(-1);
  // The opening tag ends at the `>` on its own line after the last prop.
  const close = surfaceSrc.indexOf("\n      >", idx);
  expect(close).toBeGreaterThan(-1);
  return surfaceSrc.slice(open, close + "\n      >".length);
}

describe("FinOps scroll-column children keep natural height (collapse fix)", () => {
  it("the hero ChartCard ('Today's spend') carries shrink-0", () => {
    expect(chartCardOpenTag("Today's spend")).toContain(
      'className="shrink-0"',
    );
  });

  it("the spend-over-time ChartCard carries shrink-0", () => {
    expect(chartCardOpenTag("Spend over time")).toContain(
      'className="shrink-0"',
    );
  });

  it("the breakdown grid wrapper carries shrink-0", () => {
    // The breakdown grid is the OBS-11 two-column wrapper directly below P-A.
    expect(surfaceSrc).toContain(
      'className="grid shrink-0 grid-cols-1 gap-4 lg:grid-cols-2"',
    );
  });

  it("the footer + spike-drill strip are wrapped in shrink-0 boxes", () => {
    // Both are components without a className passthrough, so each is wrapped in
    // a shrink-0 div to hold its natural height as a direct scroll-column child.
    const shrinkWrappers = surfaceSrc.match(/className="shrink-0"/g) ?? [];
    // hero + spend (on the cards) + footer wrapper + strip wrapper = 4.
    expect(shrinkWrappers.length).toBeGreaterThanOrEqual(4);
  });
});

describe("the global Panel/ChartCard primitives were not regressed", () => {
  it("Panel base classes do NOT hard-code shrink-0 (board/dashboard cells)", () => {
    // The fix must be LOCAL to FinOps — a global shrink-0 on Panel would regress
    // fixed-height board/dashboard cells.
    const baseClasses =
      panelSrc.match(/"overflow-hidden rounded-lg[^"]*"/)?.[0] ?? "";
    expect(baseClasses).not.toContain("shrink-0");
  });

  it("ChartCard forwards className through to its root Panel", () => {
    // The shrink-0 passthrough relies on ChartCard merging `className` onto the
    // Panel. (No-op safeguard: keep the passthrough intact.)
    expect(chartCardSrc).toContain("<Panel className={cn(");
    expect(chartCardSrc).toMatch(/<Panel className=\{cn\([^)]*className/s);
  });
});
