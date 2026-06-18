import { describe, it, expect } from "bun:test";
const SHELL  = await Bun.file(new URL("./Shell.tsx",        import.meta.url)).text();
const DROUTE = await Bun.file(new URL("./detail-route.tsx", import.meta.url)).text();
const TRAIL  = await Bun.file(new URL("./ticket-rail.tsx",  import.meta.url)).text();

describe("Shell PropertyRow renders ProjectMarkIcon, not raw <img> (GAP B, CTL-1258)", () => {
  it("PropertyRow carries a ProjectMark, not iconSrc", () => {
    expect(SHELL).toMatch(/mark\??:\s*ProjectMark/);
    expect(SHELL).not.toMatch(/iconSrc\?:\s*string \| null/);
  });
  it("renders <ProjectMarkIcon> and no longer renders a raw favicon <img src={r.iconSrc", () => {
    expect(SHELL).toContain("<ProjectMarkIcon");
    expect(SHELL).not.toMatch(/<img\s+src=\{r\.iconSrc/);
  });
});

describe("worker detail rail resolves a ProjectMark (GAP B, CTL-1258)", () => {
  it("uses resolveEntityMark, not resolveEntityIcon", () => {
    expect(DROUTE).toContain("resolveEntityMark");
    expect(DROUTE).not.toContain("resolveEntityIcon");
  });
});

describe("ticket rail rows + Project card render ProjectMarkIcon (GAP B, CTL-1258)", () => {
  it("uses resolveEntityMark + ProjectMarkIcon, drops resolveEntityIcon + raw <img>", () => {
    expect(TRAIL).toContain("resolveEntityMark");
    expect(TRAIL).toContain("<ProjectMarkIcon");
    expect(TRAIL).not.toContain("resolveEntityIcon");
    expect(TRAIL).not.toMatch(/<img\s+src=\{(row\.iconSrc|iconSrc)\b/);
  });
});
