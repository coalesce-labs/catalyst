import { describe, it, expect } from "bun:test";
const SRC = await Bun.file(new URL("./BoardList.tsx", import.meta.url)).text();

describe("BoardList GroupHeaderRow renders ProjectMarkIcon (GAP B Surface 4, CTL-1258)", () => {
  it("imports laneMark and ProjectMarkIcon, drops laneIconSrc", () => {
    expect(SRC).toContain("laneMark");
    expect(SRC).toContain("ProjectMarkIcon");
    expect(SRC).not.toContain("laneIconSrc");
  });
  it("passes a mark (not iconSrc) to GroupHeaderRow", () => {
    expect(SRC).toMatch(/mark=\{laneMark\(swimlane, meta\.repo, icons\)\}/);
    expect(SRC).not.toMatch(/iconSrc=\{laneIconSrc\(/);
  });
  it("GroupHeaderRow no longer renders a raw favicon <img src={iconSrc", () => {
    expect(SRC).not.toMatch(/<img src=\{iconSrc\}/);
  });
});
