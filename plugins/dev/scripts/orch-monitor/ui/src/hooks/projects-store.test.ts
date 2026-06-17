// projects-store.test.ts — CTL-1234: shared project roster store unit tests.
// Run: cd plugins/dev/scripts/orch-monitor/ui && bun test src/hooks/projects-store.test.ts
// Mirrors nav-store.test.ts discipline: inject store + fetchImpl to stay free of module-global state.
import { describe, it, expect } from "bun:test";
import { createStore } from "jotai";
import { projectsStateAtom, loadProjects } from "./projects-store";
import type { ProjectDescriptor } from "./projects-store";

function makeProject(repo: string, icon?: string): ProjectDescriptor {
  return {
    key: repo.toUpperCase(),
    name: repo,
    repo,
    vcsRepo: null,
    defaultColor: null,
    iconUrl: `/api/repo-icon/${repo}`,
    repoRoot: null,
    hasWork: false,
    icon: icon ?? null,
  };
}

function stubFetch(projects: ProjectDescriptor[]) {
  return () =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ projects }),
    } as Response);
}

describe("projectsStateAtom", () => {
  it("starts with empty roster and loaded=false", () => {
    const store = createStore();
    expect(store.get(projectsStateAtom)).toEqual({ projects: [], loaded: false });
  });
});

describe("loadProjects", () => {
  it("writes fetched projects to the atom and sets loaded=true", async () => {
    const store = createStore();
    const roster = [makeProject("catalyst", "phosphor:star")];
    await loadProjects(store, stubFetch(roster));
    const state = store.get(projectsStateAtom);
    expect(state.loaded).toBe(true);
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0].repo).toBe("catalyst");
    expect(state.projects[0].icon).toBe("phosphor:star");
  });

  it("CTL-1234 regression: one refetch updates ALL readers of the shared atom", async () => {
    const store = createStore();

    // Initial load
    await loadProjects(store, stubFetch([makeProject("catalyst", "phosphor:circle")]));

    // Both "consumers" read from the same store — sidebar consumer
    const sidebarRead1 = store.get(projectsStateAtom).projects[0].icon;
    // settings consumer
    const settingsRead1 = store.get(projectsStateAtom).projects[0].icon;
    expect(sidebarRead1).toBe("phosphor:circle");
    expect(settingsRead1).toBe("phosphor:circle");

    // Simulate save → refetch with new icon
    await loadProjects(store, stubFetch([makeProject("catalyst", "phosphor:star")]));

    // Both readers now see the updated icon without reload
    const sidebarRead2 = store.get(projectsStateAtom).projects[0].icon;
    const settingsRead2 = store.get(projectsStateAtom).projects[0].icon;
    expect(sidebarRead2).toBe("phosphor:star");
    expect(settingsRead2).toBe("phosphor:star");
  });

  it("fail-open: fetch rejects → loaded=true, prior roster preserved", async () => {
    const store = createStore();
    const roster = [makeProject("catalyst")];
    await loadProjects(store, stubFetch(roster));
    expect(store.get(projectsStateAtom).projects).toHaveLength(1);

    // Now simulate a network error
    const failFetch = () => Promise.reject(new Error("network error"));
    await loadProjects(store, failFetch as typeof fetch);

    const state = store.get(projectsStateAtom);
    expect(state.loaded).toBe(true);
    expect(state.projects).toHaveLength(1); // prior roster preserved
  });

  it("fail-open: non-array payload → loaded=true, prior roster preserved", async () => {
    const store = createStore();
    const roster = [makeProject("catalyst")];
    await loadProjects(store, stubFetch(roster));

    // Server returns unexpected shape
    const badFetch = () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ error: "not found" }),
      } as Response);
    await loadProjects(store, badFetch as typeof fetch);

    const state = store.get(projectsStateAtom);
    expect(state.loaded).toBe(true);
    expect(state.projects).toHaveLength(1); // prior roster preserved
  });
});
