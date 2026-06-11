// detail-scroll-contract.test.ts — CTL-1048 acceptance guard for the detail-page
// scroll architecture.
//
// The bug: the shared detail Shell put its ONLY scroller on the narrow prose
// column, nested inside an `overflow:hidden`, `minHeight:100vh` outer div that
// was taller than its clipped AppShell inset. Wheel/trackpad input over any
// region OUTSIDE that prose column (the right rail, the gutter between columns,
// header padding) had no scrollable ancestor and went dead — the page felt
// "stuck" below the fold.
//
// The fix makes the Shell's full-width BODY ROW the single scroll context
// (prose + rail ride inside it). This test pins that structure so a future edit
// cannot silently re-split it back into per-column scrollers (which re-creates
// the dead zone) or re-introduce the `minHeight:100vh` clip.
//
// `bun test` has no DOM, so — matching surface-contract.test.ts / detail-nav.
// test.ts — this asserts the load-bearing structure via static source analysis.
// What ONLY live validation can prove (a real wheel event over each region
// actually scrolls at an 800px viewport) is noted inline and was checked on the
// live Mini dashboard; the static guards below lock the CSS architecture that
// makes that behaviour possible.
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const shellSrc = readFileSync(join(__dirname, "Shell.tsx"), "utf8");
const ticketRailSrc = readFileSync(join(__dirname, "ticket-rail.tsx"), "utf8");
const css = readFileSync(join(__dirname, "..", "app.css"), "utf8");

/** Extract the inline `style={{ ... }}` object literal that immediately follows
 *  a given `data-*` attribute on a JSX element. Returns the brace-balanced body
 *  of the style object so individual properties can be asserted. */
function styleAfterAttr(src: string, attr: string): string {
  const at = src.indexOf(attr);
  if (at < 0) throw new Error(`attribute ${attr} not found`);
  const styleAt = src.indexOf("style={{", at);
  if (styleAt < 0) throw new Error(`no inline style after ${attr}`);
  const open = styleAt + "style={".length; // points at the outer `{` of the object
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced style object after ${attr}`);
}

/** The class list on the JSX element carrying a given data-attribute (or "").
 *  Scans only WITHIN the element's own opening tag — from the `<` that opens it
 *  to the matching tag-closing `>` — so an adjacent sibling element's className
 *  cannot leak in. */
function classNameAfterAttr(src: string, attr: string): string {
  const at = src.indexOf(attr);
  if (at < 0) throw new Error(`attribute ${attr} not found`);
  const tagOpen = src.lastIndexOf("<", at);
  // Find the `>` that ends THIS opening tag, skipping any inside `{...}` JSX
  // expressions (the style object) and string literals.
  let depth = 0;
  let tagClose = -1;
  for (let i = tagOpen; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) {
      tagClose = i;
      break;
    }
  }
  const tag = src.slice(tagOpen, tagClose < 0 ? at + 200 : tagClose);
  const m = tag.match(/className="([^"]*)"/);
  return m ? m[1] : "";
}

/** The body of a CSS rule block for a selector. */
function cssBlock(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.*]/g, "\\$&")}\\s*\\{`);
  const m = re.exec(css);
  if (!m) throw new Error(`selector ${selector} not found`);
  const open = css.indexOf("{", m.index);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced block for ${selector}`);
}

describe("CTL-1048 — detail page is a single scroll context", () => {
  // ── 1. The scroller IS the full-width body row ────────────────────────────
  it("the body row (data-shell-scroll) is the scroll container", () => {
    const style = styleAfterAttr(shellSrc, "data-shell-scroll");
    // It scrolls vertically …
    expect(style).toMatch(/overflowY:\s*"auto"/);
    // … is the flex row that spans prose + rail …
    expect(style).toMatch(/display:\s*"flex"/);
    // … and can shrink below content height so overflow actually engages.
    expect(style).toMatch(/minHeight:\s*0/);
  });

  it("the body-row scroller keeps the CTL-1036 overlay-scrollbar styling", () => {
    expect(classNameAfterAttr(shellSrc, "data-shell-scroll")).toContain(
      "cat-overlay-scroll",
    );
  });

  // ── 2. No NESTED scroller re-splits the context (the dead-zone regression) ─
  it("the prose column (data-shell-body) does NOT own a scroller", () => {
    const style = styleAfterAttr(shellSrc, "data-shell-body");
    // The prose column is a plain flex child — it must not re-introduce a
    // per-column overflow scroller (that was the dead zone).
    expect(style).not.toMatch(/overflow/i);
    // And it must not carry the overlay-scroll class (which would imply a
    // scroller the old architecture had here).
    expect(classNameAfterAttr(shellSrc, "data-shell-body")).not.toContain(
      "cat-overlay-scroll",
    );
  });

  it("neither rail owns its own overflow scroller (it chains to the body)", () => {
    // PropertiesRail (worker page) + TicketRailCards (ticket page) both carry
    // data-shell-rail. A short rail must CHAIN to the page scroll, not trap it,
    // so neither may declare overflowY:auto or the overlay-scroll class.
    const propsRailStyle = styleAfterAttr(shellSrc, "data-shell-rail");
    expect(propsRailStyle).not.toMatch(/overflowY/i);
    expect(classNameAfterAttr(shellSrc, "data-shell-rail")).not.toContain(
      "cat-overlay-scroll",
    );

    const cardRailStyle = styleAfterAttr(ticketRailSrc, "data-shell-rail");
    expect(cardRailStyle).not.toMatch(/overflowY/i);
    expect(classNameAfterAttr(ticketRailSrc, "data-shell-rail")).not.toContain(
      "cat-overlay-scroll",
    );
  });

  // ── 3. The outer shell no longer over-extends past its clipped inset ──────
  it("the Shell outer div drops minHeight:100vh (it overflowed the clip)", () => {
    const style = styleAfterAttr(shellSrc, "data-detail-shell");
    expect(style).toMatch(/height:\s*"100%"/);
    // minHeight:100vh made the shell taller than the overflow-hidden AppShell
    // inset, forcing the prose-only scroller; it must be gone (minHeight:0 now).
    expect(style).not.toMatch(/minHeight:\s*"100vh"/);
    expect(style).toMatch(/minHeight:\s*0/);
  });

  // ── 4. Code blocks scroll horizontally only (vertical wheel passes through) ─
  it(".md-content pre handles horizontal scroll only", () => {
    const block = cssBlock(".md-content pre");
    expect(block).toMatch(/overflow-x:\s*auto/);
    // Pinning overflow-y:hidden stops the CSS visible→auto promotion that would
    // let a tall code block capture vertical wheel and trap the page scroll.
    expect(block).toMatch(/overflow-y:\s*hidden/);
  });

  // ── 5. Shared scaffolding ⇒ ticket AND worker detail get the fix at once ──
  it("both detail routes render the SAME Shell (one fix, both pages)", () => {
    const routeSrc = readFileSync(join(__dirname, "detail-route.tsx"), "utf8");
    // TicketDetailRoute and WorkerDetailRoute both mount <Shell …>, so the
    // single-scroll-context structure asserted above applies identically to
    // both (the gherkin's "worker detail behaves identically" scenario).
    const shellMounts = routeSrc.match(/<Shell\b/g) ?? [];
    expect(shellMounts.length).toBeGreaterThanOrEqual(2);
    expect(routeSrc).toContain("export function TicketDetailRoute");
    expect(routeSrc).toContain("export function WorkerDetailRoute");
  });
});
