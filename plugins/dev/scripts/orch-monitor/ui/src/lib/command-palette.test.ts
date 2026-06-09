// command-palette.test.ts — units for the SHELL5 command-palette keyboard core
// (CTL-895). These encode the ticket's Gherkin acceptance scenarios at the pure
// logic layer (no DOM), the same way sidebar-collapse.test.ts proves the `[`
// binding + "typing is never stolen" guard.
//
// `shouldOpenPalette` is pure and needs no DOM shim.
//
// Run from the ui package:  `cd ui && bun test src/lib/command-palette.test.ts`.
import { describe, it, expect } from "bun:test";
import { shouldOpenPalette, type PaletteKeyEvent } from "./command-palette";

const press = (over: Partial<PaletteKeyEvent>): PaletteKeyEvent => ({
  key: "/",
  target: null,
  ...over,
});

// ── Scenario: Cmd-K and '/' open the palette ───────────────────────────────────
describe("shouldOpenPalette — ⌘K / Ctrl+K open the palette", () => {
  it("Scenario: ⌘K opens the palette — meta+k fires", () => {
    expect(shouldOpenPalette(press({ key: "k", metaKey: true }))).toBe(true);
  });

  it("Scenario: Ctrl+K opens the palette — ctrl+k fires", () => {
    expect(shouldOpenPalette(press({ key: "k", ctrlKey: true }))).toBe(true);
  });

  it("⌘K fires even while typing in a field (the modifier is unambiguous)", () => {
    // Unlike `/`, the ⌘/Ctrl chord can never be confused with typed text, so a
    // command palette opens it from anywhere — including an input.
    expect(
      shouldOpenPalette(
        press({ key: "k", metaKey: true, target: { tagName: "INPUT" } }),
      ),
    ).toBe(true);
  });

  it("⌘K is case-insensitive (some layouts deliver an uppercase K)", () => {
    expect(shouldOpenPalette(press({ key: "K", metaKey: true }))).toBe(true);
  });

  it("a bare `k` (no meta/ctrl) does NOT open the palette", () => {
    expect(shouldOpenPalette(press({ key: "k" }))).toBe(false);
  });
});

describe("shouldOpenPalette — `/` quick-opens the palette outside a field", () => {
  it("Scenario: `/` opens the palette — a bare `/` outside a field opens", () => {
    // Given my cursor is NOT in an input, When I press `/` Then the palette opens.
    expect(shouldOpenPalette(press({}))).toBe(true);
  });

  it("does not fire for an unrelated key", () => {
    expect(shouldOpenPalette(press({ key: "j" }))).toBe(false);
    expect(shouldOpenPalette(press({ key: "]" }))).toBe(false);
  });
});

// ── Scenario: '/' never hijacks typing ─────────────────────────────────────────
describe("shouldOpenPalette — `/` never hijacks typing", () => {
  it("Scenario: `/` inside an <input> is left alone (a slash is typed)", () => {
    expect(shouldOpenPalette(press({ target: { tagName: "INPUT" } }))).toBe(
      false,
    );
  });

  it("Scenario: `/` inside a <textarea> is left alone", () => {
    expect(shouldOpenPalette(press({ target: { tagName: "TEXTAREA" } }))).toBe(
      false,
    );
  });

  it("Scenario: `/` in a contenteditable is left alone", () => {
    expect(
      shouldOpenPalette(
        press({ target: { tagName: "DIV", isContentEditable: true } }),
      ),
    ).toBe(false);
  });

  it("`/` with a meta/ctrl/alt modifier is NOT the quick-open (left for other shortcuts)", () => {
    expect(shouldOpenPalette(press({ metaKey: true }))).toBe(false);
    expect(shouldOpenPalette(press({ ctrlKey: true }))).toBe(false);
    expect(shouldOpenPalette(press({ altKey: true }))).toBe(false);
  });

  it("`/` with only shift held still quick-opens (shift does not gate it)", () => {
    expect(shouldOpenPalette(press({ shiftKey: true }))).toBe(true);
  });
});
