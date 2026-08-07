import { describe, it, expect } from "bun:test";
const SRC = await Bun.file(new URL("./app-shell.tsx", import.meta.url)).text();

describe("AppShell feeds RepoIconProvider the observed∪roster repo union (GAP A, CTL-1258)", () => {
  it("imports mergeIconRepos and useProjects", () => {
    expect(SRC).toMatch(/import \{[^}]*\bmergeIconRepos\b[^}]*\} from "@\/lib\/project-settings-model"/s);
    expect(SRC).toMatch(/import \{[^}]*\buseProjects\b[^}]*\} from "@\/hooks\/use-projects"/s);
  });
  it("computes the provider repos via mergeIconRepos(payload?.repos, projects)", () => {
    expect(SRC).toMatch(/mergeIconRepos\(\s*payload\?\.repos \?\? \[\]\s*,\s*projects\s*\)/);
  });
  it("still mounts <RepoIconProvider repos={repos}>", () => {
    expect(SRC).toContain("<RepoIconProvider repos={repos}>");
  });
  it("no longer feeds the bare observed-work set to the provider repos var", () => {
    expect(SRC).not.toMatch(/const repos = payload\?\.repos \?\? \[\];/);
  });
});

describe("AppShell provides ServiceHealthContext (5th provider, CTL-945)", () => {
  it("imports the hook + context", () => {
    expect(SRC).toMatch(
      /import \{[^}]*useServiceHealth[^}]*ServiceHealthContext[^}]*\} from "@\/hooks\/use-service-health"/s,
    );
  });
  it("calls useServiceHealth() once at the provider site", () => {
    expect(SRC).toMatch(/const serviceHealth = useServiceHealth\(\)/);
  });
  it("mounts <ServiceHealthContext.Provider value={serviceHealth}>", () => {
    expect(SRC).toContain("<ServiceHealthContext.Provider value={serviceHealth}>");
    expect(SRC).toContain("</ServiceHealthContext.Provider>");
  });
});

// CTL-1003 removed the header's SidebarTrigger for desktop (keyboard-only:
// `[` / Cmd-B). Below the `md` breakpoint the sidebar is an off-canvas Sheet
// with no keyboard available (iOS Safari) and no other tap target — the
// SidebarRail drag-handle is itself desktop-only (`sm:flex`). This restores a
// trigger, but ONLY on narrow viewports, so the deliberate desktop chrome is
// unaffected.
describe("AppShell restores a mobile-only sidebar trigger (narrow-viewport nav fix)", () => {
  it("imports SidebarTrigger", () => {
    expect(SRC).toMatch(/import \{[^}]*\bSidebarTrigger\b[^}]*\} from "@\/components\/ui\/sidebar"/s);
  });
  it("renders <SidebarTrigger> as the header's first child, before the breadcrumb", () => {
    const headerIdx = SRC.indexOf("<header");
    const triggerIdx = SRC.indexOf("<SidebarTrigger");
    const breadcrumbIdx = SRC.indexOf("<Breadcrumb>");
    expect(headerIdx).toBeGreaterThan(-1);
    expect(triggerIdx).toBeGreaterThan(headerIdx);
    expect(breadcrumbIdx).toBeGreaterThan(triggerIdx);
  });
  it("gates the trigger to narrow viewports only (md:hidden), leaving desktop keyboard-only", () => {
    expect(SRC).toMatch(/<SidebarTrigger className="[^"]*\bmd:hidden\b[^"]*"/);
  });
});
