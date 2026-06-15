// CTL-1152: unit tests for the config-driven project roster — the read-only
// "Retrieve" foundation behind GET /api/projects and the nav.
//
// buildProjects(teams, repoColors, registry, observedRepos) is PURE and implements
// the UNION RULE:
//   1) one ProjectDescriptor per CONFIGURED catalyst.monitor.linear.teams[] entry
//      (ALWAYS included, even with zero observed work → hasWork=false), and
//   2) one SELF-IDENTIFYING "unconfigured" descriptor per observed-work repo
//      (BoardPayload.repos) that no configured team already covers — never dropped,
//      never collapsed to an "other" bucket.
//
// defaultColor MUST join repoColors by descriptor.vcsRepo (repoColors is keyed by
// OWNER/REPO, e.g. "coalesce-labs/catalyst") — NOT by the short name — or the dead
// nav-color bug reproduces. repoRoot enrichment joins registry.json by team key.
//
// loadProjects() does the fail-open I/O; a missing/garbage config or registry path
// must degrade to [] (drives the UI's first-class empty state), never throw.

import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProjects, loadProjects } from "./lib/project-roster";

const TEAMS = [
  { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
  { key: "ADV", vcsRepo: "coalesce-labs/adva" },
  { key: "OTL", vcsRepo: "coalesce-labs/catalyst-otel" },
];

describe("buildProjects (CTL-1152) — configured-team join", () => {
  it("one descriptor per team: repo=lowercased basename, name=displayCased, vcsRepo verbatim, iconUrl path", () => {
    const out = buildProjects(TEAMS, {}, [], []);
    const ctl = out.find((p) => p.key === "CTL")!;
    expect(ctl.repo).toBe("catalyst");
    expect(ctl.name).toBe("Catalyst");
    expect(ctl.vcsRepo).toBe("coalesce-labs/catalyst");
    expect(ctl.iconUrl).toBe("/api/repo-icon/catalyst");

    const otl = out.find((p) => p.key === "OTL")!;
    expect(otl.repo).toBe("catalyst-otel");
    expect(otl.name).toBe("Catalyst Otel"); // display-cased: split on '-', capitalize, rejoin
    expect(otl.iconUrl).toBe("/api/repo-icon/catalyst-otel");
  });

  it("preserves configured-team order, then has 3 descriptors for 3 teams (no work)", () => {
    const out = buildProjects(TEAMS, {}, [], []);
    expect(out.map((p) => p.key)).toEqual(["CTL", "ADV", "OTL"]);
  });
});

describe("buildProjects (CTL-1152) — defaultColor join by OWNER/REPO", () => {
  it("repoColors keyed by owner/repo resolves descriptor.defaultColor by vcsRepo", () => {
    const out = buildProjects(TEAMS, { "coalesce-labs/catalyst": "green" }, [], []);
    expect(out.find((p) => p.key === "CTL")!.defaultColor).toBe("green");
  });

  it("a team with no matching repoColors entry → defaultColor null", () => {
    const out = buildProjects(TEAMS, { "coalesce-labs/catalyst": "green" }, [], []);
    expect(out.find((p) => p.key === "ADV")!.defaultColor).toBeNull();
  });
});

describe("buildProjects (CTL-1152) — hasWork from observedRepos", () => {
  it("a configured team whose repo IS observed → hasWork true; not observed → false (still listed)", () => {
    const out = buildProjects(TEAMS, {}, [], ["catalyst"]);
    expect(out.find((p) => p.key === "CTL")!.hasWork).toBe(true);
    expect(out.find((p) => p.key === "ADV")!.hasWork).toBe(false);
    // ADV is still present even with no work
    expect(out.some((p) => p.key === "ADV")).toBe(true);
  });
});

describe("buildProjects (CTL-1152) — repoRoot registry enrichment", () => {
  it("registry joins by team key → repoRoot; a team absent from registry → null", () => {
    const out = buildProjects(
      TEAMS,
      {},
      [{ team: "CTL", repoRoot: "/x/catalyst" }],
      [],
    );
    expect(out.find((p) => p.key === "CTL")!.repoRoot).toBe("/x/catalyst");
    expect(out.find((p) => p.key === "ADV")!.repoRoot).toBeNull();
  });
});

describe("buildProjects (CTL-1152) — UNION rule for unconfigured observed work", () => {
  it("an observed repo with no configured descriptor is appended as a self-identifying unconfigured descriptor, never dropped", () => {
    const out = buildProjects(TEAMS, {}, [], ["catalyst", "mystery"]);
    const mystery = out.find((p) => p.repo === "mystery");
    expect(mystery).toBeDefined();
    expect(mystery!.key).toBe("MYSTERY"); // repo short-name UPPERCASED stand-in
    expect(mystery!.name).toBe("Mystery");
    expect(mystery!.vcsRepo).toBeNull();
    expect(mystery!.defaultColor).toBeNull();
    expect(mystery!.repoRoot).toBeNull();
    expect(mystery!.hasWork).toBe(true);
    expect(mystery!.iconUrl).toBe("/api/repo-icon/mystery");
    // configured teams come first, unconfigured appended last
    expect(out[out.length - 1].repo).toBe("mystery");
  });

  it("does NOT duplicate a configured team's repo even when it is observed", () => {
    const out = buildProjects(TEAMS, {}, [], ["catalyst"]);
    expect(out.filter((p) => p.repo === "catalyst")).toHaveLength(1);
  });
});

describe("buildProjects (CTL-1152) — empty state", () => {
  it("no teams AND no observed work → [] (drives the UI empty state)", () => {
    expect(buildProjects([], {}, [], [])).toEqual([]);
  });
});

describe("loadProjects (CTL-1152) — fail-open I/O", () => {
  it("a garbage config path yields [] (no throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1152-bad-"));
    try {
      writeFileSync(join(dir, "config.json"), "{ not json");
      const out = loadProjects({ configPath: join(dir, "config.json"), registryPath: "/no/such/registry.json", observedRepos: [] });
      expect(out).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing config path with no observed work yields [] (no throw)", () => {
    const out = loadProjects({ configPath: "/no/such/config.json", registryPath: "/no/such/registry.json", observedRepos: [] });
    expect(out).toEqual([]);
  });

  it("reads teams from a real config + repoColors + registry and builds descriptors", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1152-good-"));
    try {
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({
          catalyst: {
            monitor: {
              linear: { teams: [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }] },
              github: { repoColors: { "coalesce-labs/catalyst": "green" } },
            },
          },
        }),
      );
      writeFileSync(
        join(dir, "registry.json"),
        JSON.stringify({ projects: [{ team: "CTL", repoRoot: "/x/catalyst" }] }),
      );
      const out = loadProjects({
        configPath: join(dir, "config.json"),
        registryPath: join(dir, "registry.json"),
        observedRepos: ["catalyst", "mystery"],
      });
      const ctl = out.find((p) => p.key === "CTL")!;
      expect(ctl.repo).toBe("catalyst");
      expect(ctl.defaultColor).toBe("green");
      expect(ctl.repoRoot).toBe("/x/catalyst");
      expect(ctl.hasWork).toBe(true);
      // union: mystery appended
      expect(out.some((p) => p.repo === "mystery" && p.hasWork === true)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
