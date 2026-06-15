// CTL-1152: unit tests for the config-driven team→repo map helpers exported
// from board-data.mjs. board-data.mjs is plain JS so we import dynamically.
import { describe, it, expect } from "bun:test";

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
