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
