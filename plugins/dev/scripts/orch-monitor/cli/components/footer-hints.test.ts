// footer-hints.test.ts — verifies the width-conditional hint formatters used
// by FilterInput and QueryInput. Pure string logic, no Ink rendering.

import { describe, test, expect } from "bun:test";
import { formatFilterHints, formatQueryHints, WIDE_HINTS_COLS } from "./PromptInput.tsx";

describe("formatFilterHints", () => {
  test("narrow terminal — base hints only, focus label adapts", () => {
    const narrow = formatFilterHints(100, false);
    expect(narrow).toContain("/:focus");
    expect(narrow).toContain("t:scope-tr o:scope-orch");
    expect(narrow).toContain("Enter:detail q:quit");
    expect(narrow).not.toContain("h:help");
    expect(narrow).not.toContain("G:newest");
    expect(narrow).not.toContain("r:reset");

    const focused = formatFilterHints(100, true);
    expect(focused).toContain("Esc:clear");
    expect(focused).not.toContain("/:focus");
  });

  test("wide terminal — adds h:help / G:newest / r:reset", () => {
    const wide = formatFilterHints(200, false);
    expect(wide).toContain("h:help");
    expect(wide).toContain("G:newest");
    expect(wide).toContain("r:reset");
    expect(wide).toContain("t:scope-tr o:scope-orch");
  });

  test("threshold edge: at WIDE_HINTS_COLS is wide, just below is narrow", () => {
    expect(formatFilterHints(WIDE_HINTS_COLS, false)).toContain("h:help");
    expect(formatFilterHints(WIDE_HINTS_COLS - 1, false)).not.toContain("h:help");
  });
});

describe("formatQueryHints", () => {
  test("not focused, no DSL — short label", () => {
    const out = formatQueryHints(100, false, false, false);
    expect(out).toBe(":focus");
  });

  test("focused — Enter:run / Esc:cancel", () => {
    const out = formatQueryHints(100, true, false, false);
    expect(out).toContain("Enter:run");
    expect(out).toContain("Esc:cancel");
  });

  test("busy — translating label, wins over focus", () => {
    const out = formatQueryHints(100, true, true, false);
    expect(out).toBe("translating…");
  });

  test("hasDsl — appends ?:show DSL", () => {
    const out = formatQueryHints(100, false, false, true);
    expect(out).toContain(":focus");
    expect(out).toContain("?:show DSL");
  });

  test("wide and idle — appends h:help", () => {
    const out = formatQueryHints(200, false, false, false);
    expect(out).toContain("h:help");
  });

  test("wide but focused — no h:help (don't clutter active input)", () => {
    const out = formatQueryHints(200, true, false, false);
    expect(out).not.toContain("h:help");
  });

  test("wide but busy — no h:help", () => {
    const out = formatQueryHints(200, false, true, false);
    expect(out).not.toContain("h:help");
  });

  test("threshold edge", () => {
    expect(formatQueryHints(WIDE_HINTS_COLS, false, false, false)).toContain("h:help");
    expect(formatQueryHints(WIDE_HINTS_COLS - 1, false, false, false)).not.toContain("h:help");
  });
});
