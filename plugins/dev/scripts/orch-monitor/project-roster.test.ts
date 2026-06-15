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
import { buildProjects, loadProjects, readProjectsOverlay, applyProjectsOverlay } from "./lib/project-roster";

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

// ─── CTL-1153 (M2): overlay tests ─────────────────────────────────────────────

describe("buildProjects (CTL-1153) — M2 fields default to null", () => {
  it("every descriptor from buildProjects has the 5 new raw-override fields at null", () => {
    const out = buildProjects(TEAMS, {}, [], []);
    for (const p of out) {
      expect(p.storedName).toBeNull();
      expect(p.storedColor).toBeNull();
      expect(p.icon).toBeNull();
      expect(p.stateMap).toBeNull();
    }
  });

  it("configured teams have source='config', unconfigured lanes have source='unconfigured'", () => {
    const out = buildProjects(TEAMS, {}, [], ["mystery"]);
    expect(out.find((p) => p.key === "CTL")!.source).toBe("config");
    expect(out.find((p) => p.key === "MYSTERY")!.source).toBe("unconfigured");
  });
});

describe("readProjectsOverlay (CTL-1153) — fail-open reader", () => {
  it("absent projects[] → []", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-overlay-"));
    try {
      const cfg = join(dir, "config.json");
      writeFileSync(cfg, JSON.stringify({ catalyst: { monitor: { linear: { teams: [] } } } }));
      expect(readProjectsOverlay(cfg)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("garbage config → []", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-overlay-"));
    try {
      const cfg = join(dir, "config.json");
      writeFileSync(cfg, "not-json");
      expect(readProjectsOverlay(cfg)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses valid projects[] entries, uppercases key", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-overlay-"));
    try {
      const cfg = join(dir, "config.json");
      writeFileSync(
        cfg,
        JSON.stringify({
          catalyst: {
            projects: [
              { key: "ctl", vcsRepo: "coalesce-labs/catalyst", name: "Catalyst Core", color: "blue" },
            ],
          },
        }),
      );
      const out = readProjectsOverlay(cfg);
      expect(out).toHaveLength(1);
      expect(out[0]!.key).toBe("CTL");
      expect(out[0]!.name).toBe("Catalyst Core");
      expect(out[0]!.color).toBe("blue");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops entries missing key, drops non-string/unknown color values without throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-overlay-"));
    try {
      const cfg = join(dir, "config.json");
      writeFileSync(
        cfg,
        JSON.stringify({
          catalyst: {
            projects: [
              { vcsRepo: "owner/no-key" },                     // missing key → skipped
              { key: "ADV", vcsRepo: "o/a", color: "fuchsia" }, // bad hue → entry kept but color dropped
            ],
          },
        }),
      );
      const out = readProjectsOverlay(cfg);
      expect(out).toHaveLength(1);
      expect(out[0]!.key).toBe("ADV");
      expect(out[0]!.color).toBeUndefined(); // bad hue dropped
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applyProjectsOverlay (CTL-1153) — pure merge", () => {
  it("empty overlay is identity on all fields", () => {
    const base = buildProjects(TEAMS, { "coalesce-labs/catalyst": "green" }, [], []);
    const out = applyProjectsOverlay(base, []);
    expect(out.map((p) => p.key)).toEqual(base.map((p) => p.key));
    expect(out.every((p) => p.storedName === null && p.storedColor === null && p.icon === null && p.stateMap === null)).toBe(true);
    expect(out.find((p) => p.key === "CTL")!.defaultColor).toBe("green");
  });

  it("overlay override: sets effective name/defaultColor + raw storedName/storedColor, source=overlay", () => {
    const base = buildProjects(TEAMS, {}, [], []);
    const out = applyProjectsOverlay(base, [
      { key: "CTL", vcsRepo: "coalesce-labs/catalyst", name: "Catalyst Core", color: "blue", icon: "favicon.ico", stateMap: { inReview: "Code Review" } },
    ]);
    const ctl = out.find((p) => p.key === "CTL")!;
    expect(ctl.name).toBe("Catalyst Core");
    expect(ctl.defaultColor).toBe("blue");
    expect(ctl.storedName).toBe("Catalyst Core");
    expect(ctl.storedColor).toBe("blue");
    expect(ctl.icon).toBe("favicon.ico");
    expect(ctl.stateMap).toEqual({ inReview: "Code Review" });
    expect(ctl.source).toBe("overlay");
    expect(ctl.vcsRepo).toBe("coalesce-labs/catalyst"); // identity untouched
  });

  it("unknown hue in overlay is ignored (effective defaultColor falls back to base)", () => {
    const base = buildProjects(TEAMS, { "coalesce-labs/catalyst": "green" }, [], []);
    const out = applyProjectsOverlay(base, [
      { key: "CTL", vcsRepo: "coalesce-labs/catalyst", color: "fuchsia" },
    ]);
    expect(out.find((p) => p.key === "CTL")!.defaultColor).toBe("green");
  });

  it("forward-compat: overlay key ∉ teams[] with vcsRepo is appended", () => {
    const base = buildProjects(TEAMS, {}, [], []);
    const out = applyProjectsOverlay(base, [
      { key: "NEW", vcsRepo: "owner/new-repo", color: "teal" },
    ]);
    expect(out.some((p) => p.key === "NEW")).toBe(true);
    expect(out.find((p) => p.key === "NEW")!.defaultColor).toBe("teal");
  });

  it("null-vcsRepo orphan entry is skipped", () => {
    const base = buildProjects(TEAMS, {}, [], []);
    const out = applyProjectsOverlay(base, [
      { key: "ORPHAN", vcsRepo: null },
    ]);
    expect(out.some((p) => p.key === "ORPHAN")).toBe(false);
  });
});

describe("loadProjects (CTL-1153) — overlay integration", () => {
  it("catalog projects[] overlay is applied: CTL.defaultColor=blue, source=overlay", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-overlay-"));
    try {
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({
          catalyst: {
            monitor: {
              linear: { teams: [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }] },
              github: { repoColors: {} },
            },
            projects: [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst", color: "blue" }],
          },
        }),
      );
      writeFileSync(join(dir, "registry.json"), JSON.stringify({ projects: [] }));
      const out = loadProjects({
        configPath: join(dir, "config.json"),
        registryPath: join(dir, "registry.json"),
      });
      const ctl = out.find((p) => p.key === "CTL")!;
      expect(ctl.defaultColor).toBe("blue");
      expect(ctl.source).toBe("overlay");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("malformed projects[] degrades to teams[]-only roster (no throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-overlay-"));
    try {
      writeFileSync(
        join(dir, "config.json"),
        JSON.stringify({
          catalyst: {
            monitor: {
              linear: { teams: [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }] },
              github: { repoColors: {} },
            },
            projects: "garbage",
          },
        }),
      );
      writeFileSync(join(dir, "registry.json"), JSON.stringify({ projects: [] }));
      const out = loadProjects({
        configPath: join(dir, "config.json"),
        registryPath: join(dir, "registry.json"),
      });
      expect(out.find((p) => p.key === "CTL")).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
