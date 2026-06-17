import { readdirSync } from "fs";
import { describe, it, expect } from "bun:test";
import { PHOSPHOR_ICON_NAMES } from "./phosphor-icon-index.generated";
import { pascalToKebab, kebabToPascal } from "./phosphor-icons";
import { PHOSPHOR_GLYPH_NAMES } from "./project-glyph-set";

describe("phosphor-icon-index.generated", () => {
  it("is a non-empty, sorted, de-duped readonly string[] of >1500 names", () => {
    expect(PHOSPHOR_ICON_NAMES.length).toBeGreaterThan(1500);
    expect([...PHOSPHOR_ICON_NAMES]).toEqual([...PHOSPHOR_ICON_NAMES].sort());
    expect(new Set(PHOSPHOR_ICON_NAMES).size).toBe(PHOSPHOR_ICON_NAMES.length);
  });

  it("every name round-trips kebab→pascal→kebab (reconstructs its dist/csr subpath)", () => {
    for (const n of PHOSPHOR_ICON_NAMES) expect(pascalToKebab(kebabToPascal(n))).toBe(n);
  });

  it("includes every featured glyph name (featured ⊆ full index)", () => {
    const set = new Set(PHOSPHOR_ICON_NAMES);
    for (const n of PHOSPHOR_GLYPH_NAMES) expect(set.has(n)).toBe(true);
  });

  it("includes 'fire' (acceptance anchor)", () => {
    expect(PHOSPHOR_ICON_NAMES).toContain("fire");
  });

  // DRIFT GUARD — fails CI if @phosphor-icons/react is bumped without re-running gen:icons.
  it("matches the live @phosphor-icons/react dist/csr name set exactly", () => {
    const dir = new URL(
      "../../node_modules/@phosphor-icons/react/dist/csr/",
      import.meta.url,
    ).pathname; // adjust to require.resolve if hoisting changes the layout
    const live = [
      ...new Set(
        readdirSync(dir)
          .filter((f) => f.endsWith(".es.js"))
          .map((f) => pascalToKebab(f.replace(/\.es\.js$/, ""))),
      ),
    ].sort();
    expect([...PHOSPHOR_ICON_NAMES]).toEqual(live);
  });
});
