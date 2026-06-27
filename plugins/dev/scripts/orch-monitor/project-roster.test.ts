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
import {
  buildProjects,
  loadProjects,
  readProjectsOverlay,
  applyProjectsOverlay,
  buildObservedRepoAliases,
  normalizeObservedRepo,
} from "./lib/project-roster";

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

// ─── CTL-1380 (Bug A): observed-repo normalization / dedupe ───────────────────
//
// Regression coverage for the 10-entry nav bug: GET /api/projects returned the 5
// configured teams PLUS 5 source:"unconfigured" DUPLICATES, because the observed-
// work repo identifiers (BoardPayload.repos) arrive as lowercased TEAM KEYS ("ctl",
// "adv", "otl", "sli") and one FULL owner/repo ("coalesce-labs/catalyst") — none of
// which equal the configured short-names ("catalyst", "adva", …) — so the union rule
// never collapsed them. buildProjects now normalizes observed repos into the
// configured short-name key space before the union.

const FIVE_TEAM_LIST = [
  { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
  { key: "ADV", vcsRepo: "rightsite-cloud/Adva" },
  { key: "OTL", vcsRepo: "coalesce-labs/catalyst-otel" },
  { key: "SLI", vcsRepo: "ryanrozich/slides" },
  { key: "EVR", vcsRepo: "coalesce-labs/evergreen" },
];

describe("buildObservedRepoAliases (CTL-1380)", () => {
  it("folds short-name, team key, and full owner/repo onto the team short-name", () => {
    const a = buildObservedRepoAliases(TEAMS, []);
    expect(a.get("catalyst")).toBe("catalyst"); // identity
    expect(a.get("ctl")).toBe("catalyst"); // lowercased team key
    expect(a.get("coalesce-labs/catalyst")).toBe("catalyst"); // full owner/repo
    expect(a.get("adv")).toBe("adva");
    expect(a.get("catalyst-otel")).toBe("catalyst-otel");
    expect(a.get("otl")).toBe("catalyst-otel");
  });

  it("folds a registry repoRoot basename onto the team short-name (joined by team key)", () => {
    const a = buildObservedRepoAliases(
      [{ key: "ADV", vcsRepo: "rightsite-cloud/Adva" }],
      [{ team: "ADV", repoRoot: "/Users/x/code-repos/github/groundworkapp/Adva" }],
    );
    expect(a.get("adva")).toBe("adva"); // basename("…/Adva") lowercased == the short-name
  });
});

describe("normalizeObservedRepo (CTL-1380)", () => {
  const aliases = buildObservedRepoAliases(TEAMS, []);
  it("maps a lowercased team key to the configured short-name", () => {
    expect(normalizeObservedRepo("ctl", aliases)).toBe("catalyst");
    expect(normalizeObservedRepo("adv", aliases)).toBe("adva");
  });
  it("maps a full owner/repo to the configured short-name", () => {
    expect(normalizeObservedRepo("coalesce-labs/catalyst", aliases)).toBe("catalyst");
  });
  it("passes through an already-correct short-name", () => {
    expect(normalizeObservedRepo("catalyst", aliases)).toBe("catalyst");
  });
  it("collapses a genuinely-unconfigured full owner/repo to its basename (a '/'-free key)", () => {
    expect(normalizeObservedRepo("some-org/mystery", aliases)).toBe("mystery");
  });
  it("passes through a genuinely-unconfigured short name unchanged (lowercased)", () => {
    expect(normalizeObservedRepo("Mystery", aliases)).toBe("mystery");
  });
});

describe("buildProjects (CTL-1380) — observed work merges into the configured descriptor", () => {
  it("an observed lowercased TEAM KEY flips the configured team's hasWork — no duplicate lane", () => {
    const out = buildProjects(TEAMS, {}, [], ["ctl"]);
    const ctl = out.find((p) => p.key === "CTL")!;
    expect(ctl.hasWork).toBe(true);
    expect(ctl.source).toBe("config");
    // exactly one descriptor for the catalyst repo, and zero unconfigured lanes
    expect(out.filter((p) => p.repo === "catalyst")).toHaveLength(1);
    expect(out.some((p) => p.source === "unconfigured")).toBe(false);
  });

  it("an observed FULL owner/repo merges into the configured descriptor — no duplicate lane", () => {
    const out = buildProjects(TEAMS, {}, [], ["coalesce-labs/catalyst"]);
    expect(out.find((p) => p.key === "CTL")!.hasWork).toBe(true);
    expect(out.some((p) => p.source === "unconfigured")).toBe(false);
    expect(out.some((p) => p.repo === "coalesce-labs/catalyst")).toBe(false);
  });

  it("the real-world 5-dupe scenario yields EXACTLY the 5 configured teams, no unconfigured dupes", () => {
    // The exact observed-repo set the live /api/projects produced pre-fix.
    const observed = ["adv", "coalesce-labs/catalyst", "ctl", "otl", "sli"];
    const out = buildProjects(FIVE_TEAM_LIST, {}, [], observed);
    expect(out).toHaveLength(5);
    expect(out.every((p) => p.source === "config")).toBe(true);
    expect(out.map((p) => p.key).sort()).toEqual(["ADV", "CTL", "EVR", "OTL", "SLI"]);
    // the 4 teams with observed work flip hasWork; evergreen (no work) stays false
    expect(out.find((p) => p.key === "CTL")!.hasWork).toBe(true);
    expect(out.find((p) => p.key === "ADV")!.hasWork).toBe(true);
    expect(out.find((p) => p.key === "OTL")!.hasWork).toBe(true);
    expect(out.find((p) => p.key === "SLI")!.hasWork).toBe(true);
    expect(out.find((p) => p.key === "EVR")!.hasWork).toBe(false);
    // every descriptor keeps a clean, "/"-free icon key
    expect(out.every((p) => !p.iconUrl.slice("/api/repo-icon/".length).includes("/"))).toBe(true);
  });

  it("does NOT regress a genuinely-unconfigured observed repo — it still appears once", () => {
    const out = buildProjects(TEAMS, {}, [], ["ctl", "mystery"]);
    // configured CTL got the work...
    expect(out.find((p) => p.key === "CTL")!.hasWork).toBe(true);
    // ...and the truly-unknown repo still surfaces as its own single unconfigured lane
    const mystery = out.filter((p) => p.repo === "mystery");
    expect(mystery).toHaveLength(1);
    expect(mystery[0].source).toBe("unconfigured");
    expect(mystery[0].hasWork).toBe(true);
  });

  it("a genuinely-unconfigured FULL owner/repo surfaces once under its basename key", () => {
    const out = buildProjects(TEAMS, {}, [], ["some-org/mystery"]);
    const lanes = out.filter((p) => p.source === "unconfigured");
    expect(lanes).toHaveLength(1);
    expect(lanes[0].repo).toBe("mystery");
    expect(lanes[0].iconUrl).toBe("/api/repo-icon/mystery"); // no slash → endpoint-safe
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
      expect(out[0].key).toBe("CTL");
      expect(out[0].name).toBe("Catalyst Core");
      expect(out[0].color).toBe("blue");
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
      expect(out[0].key).toBe("ADV");
      expect(out[0].color).toBeUndefined(); // bad hue dropped
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

// ─── cwd-independent default config-path resolution ───────────────────────────
//
// Regression coverage for the live bug: GET /api/projects returned only the 2
// observed-work repos (source:"unconfigured") even though 5 teams were
// configured. Root cause: loadProjects() defaulted the Layer-1 config path to
// `${process.cwd()}/.catalyst/config.json`, but the daemon-spawned monitor's cwd
// (.../plugins/dev/scripts/execution-core) has no such file → readTeams() failed
// open to [] → zero configured teams. loadProjects() now defaults via
// resolveLayer1ConfigPath(), which prefers the CATALYST_CONFIG_FILE /
// CATALYST_CONFIG_PATH env pointer the deploy exports.
describe("loadProjects — env-pointed default config path (cwd-independent)", () => {
  const FIVE_TEAMS = {
    catalyst: {
      monitor: {
        linear: {
          teams: [
            { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
            { key: "ADV", vcsRepo: "coalesce-labs/adva" },
            { key: "OTL", vcsRepo: "coalesce-labs/catalyst-otel" },
            { key: "SLI", vcsRepo: "ryanrozich/slides" },
            { key: "EVR", vcsRepo: "coalesce-labs/evergreen" },
          ],
        },
        github: { repoColors: {} },
      },
    },
  };

  function withEnv(
    overrides: Record<string, string | undefined>,
    fn: () => void,
  ): void {
    const keys = ["CATALYST_CONFIG_FILE", "CATALYST_CONFIG_PATH"] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];
    try {
      for (const [k, v] of Object.entries(overrides)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      // Default the two env pointers to "unset" unless explicitly overridden, so a
      // stray env var in the runner can't leak into the case under test.
      for (const k of keys) {
        if (!(k in overrides)) delete process.env[k];
      }
      fn();
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it("(a) CATALYST_CONFIG_FILE config with 5 teams → loadProjects returns all 5 as source:'config'", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-env-"));
    try {
      const cfg = join(dir, "config.json");
      writeFileSync(cfg, JSON.stringify(FIVE_TEAMS));
      withEnv({ CATALYST_CONFIG_FILE: cfg }, () => {
        // NO configPath opt → exercises the default resolveLayer1ConfigPath().
        const out = loadProjects({
          observedRepos: [],
          registryPath: "/no/such/registry.json",
        });
        expect(out).toHaveLength(5);
        expect(out.map((p) => p.key).sort()).toEqual(["ADV", "CTL", "EVR", "OTL", "SLI"]);
        expect(out.every((p) => p.source === "config")).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(b) cwd has no .catalyst/config.json, but CATALYST_CONFIG_FILE is set → NOT zero teams", () => {
    // The cwd under test (the orch-monitor package dir, the bun-test runner cwd)
    // has no .catalyst/config.json, which under the old cwd-relative default would
    // yield []. With the env pointer set, the roster is fully populated.
    const dir = mkdtempSync(join(tmpdir(), "roster-env-"));
    try {
      const cfg = join(dir, "config.json");
      writeFileSync(cfg, JSON.stringify(FIVE_TEAMS));
      withEnv({ CATALYST_CONFIG_FILE: cfg }, () => {
        const out = loadProjects({
          observedRepos: ["adva"],
          registryPath: "/no/such/registry.json",
        });
        expect(out.length).toBeGreaterThan(0);
        expect(out.some((p) => p.key === "CTL" && p.source === "config")).toBe(true);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("CATALYST_CONFIG_PATH is also honored as the default pointer", () => {
    const dir = mkdtempSync(join(tmpdir(), "roster-env-"));
    try {
      const cfg = join(dir, "config.json");
      writeFileSync(cfg, JSON.stringify(FIVE_TEAMS));
      withEnv({ CATALYST_CONFIG_PATH: cfg }, () => {
        const out = loadProjects({
          observedRepos: [],
          registryPath: "/no/such/registry.json",
        });
        expect(out).toHaveLength(5);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("(c) explicit configPath opt still wins over the env pointer (temp-fixture injection path)", () => {
    const envDir = mkdtempSync(join(tmpdir(), "roster-env-"));
    const optDir = mkdtempSync(join(tmpdir(), "roster-opt-"));
    try {
      writeFileSync(join(envDir, "config.json"), JSON.stringify(FIVE_TEAMS));
      // The injected fixture configures a SINGLE distinctive team.
      writeFileSync(
        join(optDir, "config.json"),
        JSON.stringify({
          catalyst: {
            monitor: {
              linear: { teams: [{ key: "ONLYME", vcsRepo: "owner/onlyme" }] },
              github: { repoColors: {} },
            },
          },
        }),
      );
      withEnv({ CATALYST_CONFIG_FILE: join(envDir, "config.json") }, () => {
        const out = loadProjects({
          configPath: join(optDir, "config.json"),
          registryPath: "/no/such/registry.json",
          observedRepos: [],
        });
        // The explicit opt was read, NOT the env pointer's 5-team config.
        expect(out).toHaveLength(1);
        expect(out[0].key).toBe("ONLYME");
      });
    } finally {
      rmSync(envDir, { recursive: true, force: true });
      rmSync(optDir, { recursive: true, force: true });
    }
  });
});
