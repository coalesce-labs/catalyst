import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const swimlaneSrc = readFileSync(join(__dirname, "Swimlane.tsx"), "utf8");
const hookSrc = readFileSync(join(__dirname, "..", "hooks", "use-col-scroll-state.ts"), "utf8");

describe("CTL-1206 — flat per-column scroll restoration is wired", () => {
  it("each flat-column viewport exposes its stable col.key as data-col-key", () => {
    // the viewport carrying data-flat-col-scroll must also carry data-col-key={col.key}
    expect(swimlaneSrc).toMatch(/data-flat-col-scroll="true"/);
    expect(swimlaneSrc).toMatch(/data-col-key=\{col\.key\}/);
  });

  it("FlatColumnsBoard invokes the column scroll-state hook", () => {
    expect(swimlaneSrc).toMatch(/useColScrollState\s*\(/);
  });

  it("the hook saves/restores against the per-entry colScrollY map", () => {
    expect(hookSrc).toMatch(/colScrollY|setColScroll|colScrollFor/);
    expect(hookSrc).toMatch(/data-flat-col-scroll/);
    expect(hookSrc).toMatch(/data-col-key/);
    // restore happens after paint (rAF), mirroring the Shell.tsx detail precedent
    expect(hookSrc).toMatch(/requestAnimationFrame/);
    // save is debounced and reads the per-entry key
    expect(hookSrc).toMatch(/useDetailEntryKey|useDetailEntryState/);
  });
});
