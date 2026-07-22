// CTL-1152: unit tests for the config-driven prefix→short-repo-name map that
// replaces the hardcoded `const TEAM_REPO = { CTL: "catalyst", ADV: "adva" }`.
//
// buildTeamRepoMap is PURE — it maps catalyst.monitor.linear.teams[] entries
// ({key, vcsRepo}) to an UPPERCASE-key → lowercased-basename map. repoFor/teamFor
// are the two synchronous swim-lane resolvers called from synthesizeQueuedTicket
// (a sync function), so they must stay sync — the map is loaded once at import.
//
// The KEY behavioural change: an UNCONFIGURED prefix no longer collapses to the
// opaque "other" bucket — it resolves to its own raw lowercased team key so the
// observed work is self-identifying and the union rule can surface it as a lane.

import { describe, it, expect } from "bun:test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// board-data.mjs's loadTeamRepoMap() reads catalyst.monitor.linear.teams[] from
// `${process.cwd()}/.catalyst/config.json` (the committed Layer-1 config — same
// cwd-relative read maxParallel() uses), ONCE at import. In production the monitor
// runs with cwd === the repo/worktree root; under `bun test` the cwd is the
// orch-monitor package dir, so chdir to the worktree root (4 dirs up:
// orch-monitor → scripts → dev → plugins → root) BEFORE the dynamic import so the
// module-load read sees the real teams[] and repoFor resolves all 5 configured teams.
const HERE = dirname(fileURLToPath(import.meta.url));
process.chdir(resolve(HERE, "..", "..", "..", ".."));

// board-data.mjs is plain JS — import dynamically so TS doesn't choke on the path.
// board-data.mjs computes its TEAM_REPO map ONCE at module-load from process.cwd().
// Under `bun test` many files share one module cache, so if any earlier test
// imported board-data.mjs from the orch-monitor package cwd (no .catalyst/config.json
// there) the cached map is empty and these config-driven resolvers would fail —
// an import-order race that is order-fragile across platforms/runs. Force a FRESH
// module evaluation with a cache-busting query so loadTeamRepoMap() re-runs under
// THIS test's chdir'd cwd (the repo root), making the assertions deterministic
// regardless of who imported board-data.mjs first.
// The cache-busting query defeats TS module resolution (the specifier is a
// template literal), so cast back to the statically-resolved module type to keep
// the exports fully typed (`typeof import(...)` is type-only — no runtime import).
const { buildTeamRepoMap, repoFor, teamFor } = (await import(
  `./lib/board-data.mjs?repo-for-test=${Date.now()}`
)) as typeof import("./lib/board-data.mjs");

// The committed fixture mirrors .catalyst/config.json → catalyst.monitor.linear.teams.
const TEAMS = [
  { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
  { key: "ADV", vcsRepo: "coalesce-labs/adva" },
  { key: "OTL", vcsRepo: "coalesce-labs/catalyst-otel" },
  { key: "SLI", vcsRepo: "ryanrozich/slides" },
  { key: "EVR", vcsRepo: "coalesce-labs/evergreen" },
];

describe("buildTeamRepoMap (CTL-1152) — config-driven prefix→repo map", () => {
  it("maps each {key,vcsRepo} to UPPERCASE-key → lowercased-basename", () => {
    expect(buildTeamRepoMap(TEAMS)).toEqual({
      CTL: "catalyst",
      ADV: "adva",
      OTL: "catalyst-otel",
      SLI: "slides",
      EVR: "evergreen",
    });
  });

  it("skips an entry whose vcsRepo has no '/' (malformed)", () => {
    const map = buildTeamRepoMap([
      { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
      { key: "BAD", vcsRepo: "no-slash-here" },
    ]);
    expect(map).toEqual({ CTL: "catalyst" });
    expect(map.BAD).toBeUndefined();
  });

  it("returns {} for a non-array / empty teams input (fail-open)", () => {
    expect(buildTeamRepoMap(undefined)).toEqual({});
    expect(buildTeamRepoMap([])).toEqual({});
  });
});

describe("repoFor / teamFor (CTL-1152) — swim-lane resolvers", () => {
  it("CTL/ADV resolve to catalyst/adva (config maps them — no behaviour change)", () => {
    expect(repoFor("CTL-1152")).toBe("catalyst");
    expect(repoFor("ADV-7")).toBe("adva");
  });

  it("all 5 configured teams resolve to their short repo names", () => {
    expect(repoFor("OTL-3")).toBe("catalyst-otel");
    expect(repoFor("SLI-2")).toBe("slides");
    expect(repoFor("EVR-1")).toBe("evergreen");
  });

  it("an UNCONFIGURED prefix resolves to the raw lowercased team key, NEVER 'other'", () => {
    expect(repoFor("XYZ-9")).toBe("xyz");
    expect(repoFor("XYZ-9")).not.toBe("other");
  });

  it("teamFor returns the raw prefix verbatim (unchanged)", () => {
    expect(teamFor("CTL-1152")).toBe("CTL");
    expect(teamFor("xyz-9")).toBe("xyz");
  });
});
