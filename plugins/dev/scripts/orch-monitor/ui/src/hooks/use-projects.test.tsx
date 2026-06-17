// use-projects.test.tsx — CTL-1234: source-text wiring assertions for use-projects.ts
// and cross-consumer regression guard (Phase 2).
// Pattern: Bun.file(...).text() + regex, matching app-sidebar.test.tsx discipline.
// Run: cd plugins/dev/scripts/orch-monitor/ui && bun test src/hooks/use-projects.test.tsx
import { describe, it, expect } from "bun:test";
import * as path from "node:path";

const SRC_PATH = new URL("./use-projects.ts", import.meta.url).pathname;
const UI_SRC = path.resolve(new URL("../", import.meta.url).pathname);

async function readSrc(rel: string) {
  return Bun.file(path.join(UI_SRC, rel)).text();
}

describe("use-projects wiring (CTL-1234)", () => {
  it("does NOT contain per-instance useState for the roster", async () => {
    const src = await Bun.file(SRC_PATH).text();
    expect(src).not.toMatch(/useState<ProjectDescriptor\[\]>/);
    expect(src).not.toMatch(/useState\(false\)/);
  });

  it("imports from ./projects-store", async () => {
    const src = await Bun.file(SRC_PATH).text();
    expect(src).toContain("./projects-store");
  });

  it("reads the shared atom via useAtomValue", async () => {
    const src = await Bun.file(SRC_PATH).text();
    expect(src).toContain("useAtomValue");
    expect(src).toContain("projectsStateAtom");
  });

  it("calls ensureProjectsLoaded inside a useEffect", async () => {
    const src = await Bun.file(SRC_PATH).text();
    expect(src).toContain("ensureProjectsLoaded");
    expect(src).toContain("useEffect");
  });

  it("re-exports ProjectDescriptor so existing importers keep working", async () => {
    const src = await Bun.file(SRC_PATH).text();
    expect(src).toMatch(/export\s+(type\s+)?\{[^}]*ProjectDescriptor[^}]*\}/);
  });
});

// Phase 2 — cross-consumer regression guard (CTL-1234)
describe("all four useProjects consumers still call useProjects()", () => {
  it("settings-surface.tsx calls useProjects(", async () => {
    const src = await readSrc("components/settings-surface.tsx");
    expect(src).toContain("useProjects(");
  });

  it("app-sidebar.tsx calls useProjects(", async () => {
    const src = await readSrc("components/app-sidebar.tsx");
    expect(src).toContain("useProjects(");
  });

  it("board/repo-icon-context.tsx calls useProjects(", async () => {
    const src = await readSrc("board/repo-icon-context.tsx");
    expect(src).toContain("useProjects(");
  });

  it("hooks/use-resolved-repo-colors.ts calls useProjects(", async () => {
    const src = await readSrc("hooks/use-resolved-repo-colors.ts");
    expect(src).toContain("useProjects(");
  });

  it("settings-surface.tsx wires refetch as onSaved", async () => {
    const src = await readSrc("components/settings-surface.tsx");
    expect(src).toContain("onSaved={refetch}");
  });

  it("project-settings-pane.tsx awaits onSaved() after PUT", async () => {
    const src = await readSrc("components/settings/project-settings-pane.tsx");
    expect(src).toContain("await onSaved()");
  });
});
