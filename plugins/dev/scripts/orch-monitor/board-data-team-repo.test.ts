// CTL-1152: unit tests for the config-driven team→repo map helpers exported
// from board-data.mjs. board-data.mjs is plain JS so we import dynamically.
import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readClusterProjects } = await import("./lib/cluster-roster.ts");

const { buildTeamRepoMap, repoForWith } = await import("./lib/board-data.mjs");

const TEAMS = [
  { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
  { key: "OTL", vcsRepo: "coalesce-labs/catalyst-otel" },
  { key: "SLI", vcsRepo: "ryanrozich/slides" },
];

describe("config-driven team→repo (CTL-1152)", () => {
  it("maps configured teams to their short repo name", () => {
    const map = buildTeamRepoMap(TEAMS);
    expect(repoForWith(map, "OTL-12")).toBe("catalyst-otel");
    expect(repoForWith(map, "SLI-3")).toBe("slides");
    expect(repoForWith(map, "CTL-1")).toBe("catalyst");
  });

  it("returns 'unconfigured' (never 'other') for an unknown team", () => {
    const map = buildTeamRepoMap(TEAMS);
    expect(repoForWith(map, "ZZZ-1")).toBe("unconfigured");
  });

  it("returns 'unconfigured' when ticket has no hyphen", () => {
    const map = buildTeamRepoMap(TEAMS);
    expect(repoForWith(map, "NOTAPREFIX")).toBe("unconfigured");
  });

  it("fails open to an empty map on undefined teams", () => {
    const map = buildTeamRepoMap(undefined);
    expect(repoForWith(map, "CTL-1")).toBe("unconfigured");
  });

  it("fails open to an empty map on non-array teams", () => {
    const map = buildTeamRepoMap("nope");
    expect(repoForWith(map, "CTL-1")).toBe("unconfigured");
  });

  it("skips entries missing key or vcsRepo", () => {
    const malformed = [
      { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
      { key: "BAD" },           // missing vcsRepo
      { vcsRepo: "foo/bar" },   // missing key
      { key: "X", vcsRepo: "no-slash" }, // no slash in vcsRepo
    ];
    const map = buildTeamRepoMap(malformed);
    expect(repoForWith(map, "CTL-1")).toBe("catalyst");
    expect(repoForWith(map, "BAD-1")).toBe("unconfigured");
    expect(repoForWith(map, "X-1")).toBe("unconfigured");
  });
});

describe("board cluster-roster integration (CTL-1603)", () => {
  it("maps a cluster-only team to its real short repo name", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1603-"));
    const clusterDir = join(dir, "catalyst-cluster");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster.json"),
      JSON.stringify({
        projects: [
          { teamKey: "CTC", vcsRepo: "coalesce-labs/catalyst-cloud", projectKey: "catalyst-cloud" },
        ],
      }),
    );
    const layer1ConfigPath = join(dir, "config.json"); // does not exist → Layer-1 contributes nothing

    const teams = readClusterProjects({ clusterDir, layer1ConfigPath });
    const map = buildTeamRepoMap(teams);

    expect(repoForWith(map, "CTC-1234")).toBe("catalyst-cloud");
    rmSync(dir, { recursive: true, force: true });
  });

  it("still resolves a Layer-1-only team (union: cluster wins, L1-only retained)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1603-"));
    const clusterDir = join(dir, "catalyst-cluster");
    mkdirSync(clusterDir, { recursive: true });
    writeFileSync(
      join(clusterDir, "cluster.json"),
      JSON.stringify({
        projects: [
          { teamKey: "CTC", vcsRepo: "coalesce-labs/catalyst-cloud", projectKey: "catalyst-cloud" },
        ],
      }),
    );
    const layer1ConfigPath = join(dir, "config.json");
    writeFileSync(
      layer1ConfigPath,
      JSON.stringify({ monitor: { linear: { teams: [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }] } } }),
    );

    const map = buildTeamRepoMap(readClusterProjects({ clusterDir, layer1ConfigPath }));
    expect(repoForWith(map, "CTC-1")).toBe("catalyst-cloud"); // cluster team
    expect(repoForWith(map, "CTL-1")).toBe("catalyst");       // L1-only team retained
    rmSync(dir, { recursive: true, force: true });
  });
});
