// app-sidebar.test.tsx — CTL-1153 Phase 6: source-text wiring assertions.
// Pattern: Bun.file(...).text() + regex, matching app-shell.test.tsx:1-17 (no DOM/hooks).
import { describe, it, expect } from "bun:test";

const SRC_PATH = new URL("./app-sidebar.tsx", import.meta.url).pathname;

describe("app-sidebar Phase 6 wiring", () => {
  it('imports from "@/components/ui/context-menu"', async () => {
    const src = await Bun.file(SRC_PATH).text();
    expect(src).toContain('from "@/components/ui/context-menu"');
  });

  it("wraps CollapsibleTrigger with ContextMenuTrigger asChild", async () => {
    const src = await Bun.file(SRC_PATH).text();
    expect(src).toMatch(/<ContextMenuTrigger asChild>/);
  });

  it("contains goSettings handler", async () => {
    const src = await Bun.file(SRC_PATH).text();
    expect(src).toMatch(/goSettings/);
  });

  it("has exactly one <ContextMenu> (only on project rows)", async () => {
    const src = await Bun.file(SRC_PATH).text();
    expect((src.match(/<ContextMenu>/g) ?? []).length).toBe(1);
  });
});
