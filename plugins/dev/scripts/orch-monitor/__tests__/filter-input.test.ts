import { describe, expect, test } from "bun:test";
import {
  formatFilterHints,
  formatSinceChipLabel,
  WIDE_HINTS_COLS,
} from "../cli/components/FilterInput.tsx";

describe("formatSinceChipLabel", () => {
  test("returns null when no active since label", () => {
    expect(formatSinceChipLabel(null)).toBeNull();
  });

  test("wraps a relative spec in brackets", () => {
    expect(formatSinceChipLabel("5m")).toBe("[since: 5m]");
  });

  test("wraps a day spec in brackets", () => {
    expect(formatSinceChipLabel("7d")).toBe("[since: 7d]");
  });

  test("preserves an ISO-date spec verbatim inside the chip", () => {
    expect(formatSinceChipLabel("2026-05-01")).toBe("[since: 2026-05-01]");
  });

  test("treats empty string as inactive (null result)", () => {
    expect(formatSinceChipLabel("")).toBeNull();
  });
});

describe("formatFilterHints", () => {
  test("base hint set when narrow and unfocused", () => {
    const out = formatFilterHints(80, false);
    expect(out).toContain("/:focus");
    expect(out).not.toContain("h:help");
  });

  test("base hint set switches to Esc:clear when focused", () => {
    const out = formatFilterHints(80, true);
    expect(out).toContain("Esc:clear");
  });

  test("wide-terminal hint set adds h:help / G:newest / r:reset", () => {
    const out = formatFilterHints(WIDE_HINTS_COLS, false);
    expect(out).toContain("h:help");
    expect(out).toContain("G:newest");
    expect(out).toContain("r:reset");
  });
});
