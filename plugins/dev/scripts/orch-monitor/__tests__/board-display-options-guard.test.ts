// board-display-options-guard.test.ts — BOARD2 (CTL-906) guard/regression tests
// (design §8.3). Two cheap source-level invariants that don't need a DOM/jotai
// runtime:
//   1. The popover option-key arrays stay in sync with the BoardPrefs union
//      types (adding a union member without a UI row, or vice-versa, fails) —
//      same spirit as board-phase-drift.test.ts guarding TERMINAL_STATUSES.
//   2. No `#5be0ff` / `LIVE` literal appears in the popover or sections source
//      (the cyan-is-the-live-signal-ONLY invariant).
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UI = join(import.meta.dir, "..", "ui", "src");
const read = (rel: string) => readFileSync(join(UI, rel), "utf8");

// The popover exports its option arrays; importing this .tsx pulls only the
// arrays + types (radix/jotai are imported lazily by the component body, not at
// module top-level in a way bun can't resolve — verified the imports are static
// but harmless to load). To stay runtime-free we instead parse the literal key
// sets out of the prefs-store + popover SOURCE and compare them.

function keysOfArray(source: string, arrayName: string): string[] {
  // Find `export const NAME ... = [ ... ];` and pull every `k: "value"`.
  const re = new RegExp(`export const ${arrayName}[^=]*=\\s*\\[(.*?)\\];`, "s");
  const m = re.exec(source);
  if (!m) throw new Error(`array ${arrayName} not found`);
  return [...m[1].matchAll(/\bk:\s*"([^"]+)"/g)].map((x) => x[1]);
}

function unionMembers(source: string, typeName: string): string[] {
  // `export type NAME = "a" | "b" | ...;` (allow a trailing comment after `;`).
  const re = new RegExp(`export type ${typeName}\\s*=\\s*([^;]+);`);
  const m = re.exec(source);
  if (!m) throw new Error(`type ${typeName} not found`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("BOARD2 — popover option arrays stay in sync with the BoardPrefs unions", () => {
  const prefs = read("board/prefs-store.ts");
  const popover = read("board/display-options-popover.tsx");

  it("DENSITY_OPTIONS keys === the Density union", () => {
    expect(keysOfArray(popover, "DENSITY_OPTIONS").sort()).toEqual(
      unionMembers(prefs, "Density").sort(),
    );
  });

  it("GROUP_BY_OPTIONS keys === the GroupBy union", () => {
    expect(keysOfArray(popover, "GROUP_BY_OPTIONS").sort()).toEqual(
      unionMembers(prefs, "GroupBy").sort(),
    );
  });

  it("COLOR_BY_OPTIONS keys === the ColorBy union", () => {
    expect(keysOfArray(popover, "COLOR_BY_OPTIONS").sort()).toEqual(
      unionMembers(prefs, "ColorBy").sort(),
    );
  });

  it("ORDER_OPTIONS keys === the Ordering union", () => {
    expect(keysOfArray(popover, "ORDER_OPTIONS").sort()).toEqual(
      unionMembers(prefs, "Ordering").sort(),
    );
  });
});

describe("BOARD2 — cyan #5be0ff (the live signal) is never used decoratively in the popover", () => {
  it("display-options-popover.tsx contains no #5be0ff and no bare LIVE token", () => {
    const src = read("board/display-options-popover.tsx");
    expect(src.toLowerCase()).not.toContain("#5be0ff");
    // no `LIVE` constant reference (the board's cyan const). Comments mention it
    // by name to explain the invariant, so match a USE (e.g. `background: LIVE`),
    // not the word in prose — assert no `: LIVE` / `=LIVE` / `(LIVE` usage.
    expect(/[:=(]\s*LIVE\b/.test(src)).toBe(false);
  });

  it("display-options-sections.tsx contains no #5be0ff", () => {
    const src = read("board/display-options-sections.tsx");
    expect(src.toLowerCase()).not.toContain("#5be0ff");
  });
});
