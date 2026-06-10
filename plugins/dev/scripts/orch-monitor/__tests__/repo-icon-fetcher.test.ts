// repo-icon-fetcher.test.ts — unit tests for CTL-961 repo icon path resolver,
// cache helpers, and repoOwners config parsing.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  ICON_PATH_PRIORITY,
  buildRepoOwnerMap,
} from "../lib/repo-icon-fetcher";
// monitor-config repoOwners extraction
import { loadMonitorConfig } from "../lib/monitor-config";

// ── ICON_PATH_PRIORITY ordering ───────────────────────────────────────────────

describe("ICON_PATH_PRIORITY", () => {
  it("starts with favicon.ico (highest priority)", () => {
    expect(ICON_PATH_PRIORITY[0]).toBe("favicon.ico");
  });

  it("includes public/favicon.ico, public/favicon.svg, public/favicon.png", () => {
    expect(ICON_PATH_PRIORITY).toContain("public/favicon.ico");
    expect(ICON_PATH_PRIORITY).toContain("public/favicon.svg");
    expect(ICON_PATH_PRIORITY).toContain("public/favicon.png");
  });

  it("includes .github/logo.svg and .github/logo.png", () => {
    expect(ICON_PATH_PRIORITY).toContain(".github/logo.svg");
    expect(ICON_PATH_PRIORITY).toContain(".github/logo.png");
  });

  it("has at least 10 paths to probe", () => {
    expect(ICON_PATH_PRIORITY.length).toBeGreaterThanOrEqual(10);
  });

  it("contains no duplicates", () => {
    const set = new Set(ICON_PATH_PRIORITY);
    expect(set.size).toBe(ICON_PATH_PRIORITY.length);
  });

  it("svg paths come before png paths for the same prefix", () => {
    const svgIdx = ICON_PATH_PRIORITY.indexOf("public/favicon.svg");
    const pngIdx = ICON_PATH_PRIORITY.indexOf("public/favicon.png");
    expect(svgIdx).toBeLessThan(pngIdx);
  });

  // CTL-979: monorepo layout support
  it("includes apps/web/public/favicon.ico, .svg, .png (CTL-979)", () => {
    expect(ICON_PATH_PRIORITY).toContain("apps/web/public/favicon.ico");
    expect(ICON_PATH_PRIORITY).toContain("apps/web/public/favicon.svg");
    expect(ICON_PATH_PRIORITY).toContain("apps/web/public/favicon.png");
  });

  it("includes apps/website/public/favicon.ico, .svg, .png (CTL-979)", () => {
    expect(ICON_PATH_PRIORITY).toContain("apps/website/public/favicon.ico");
    expect(ICON_PATH_PRIORITY).toContain("apps/website/public/favicon.svg");
    expect(ICON_PATH_PRIORITY).toContain("apps/website/public/favicon.png");
  });

  it("apps/web paths come after root public paths (root takes priority)", () => {
    const rootIdx = ICON_PATH_PRIORITY.indexOf("public/favicon.ico");
    const monorepoIdx = ICON_PATH_PRIORITY.indexOf("apps/web/public/favicon.ico");
    expect(rootIdx).toBeLessThan(monorepoIdx);
  });
});

// ── buildRepoOwnerMap ─────────────────────────────────────────────────────────

describe("buildRepoOwnerMap", () => {
  it("maps repo short-name to owner/repo", () => {
    const teams = [
      { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
      { key: "ADV", vcsRepo: "coalesce-labs/adva" },
    ];
    const map = buildRepoOwnerMap(teams);
    expect(map).toEqual({
      catalyst: "coalesce-labs/catalyst",
      adva: "coalesce-labs/adva",
    });
  });

  it("skips entries without a slash", () => {
    const teams = [{ key: "X", vcsRepo: "no-slash-here" }];
    const map = buildRepoOwnerMap(teams);
    expect(Object.keys(map)).toHaveLength(0);
  });

  it("returns empty map for empty input", () => {
    expect(buildRepoOwnerMap([])).toEqual({});
  });

  it("uses only the LAST segment as the short-name (repo name after /)", () => {
    const teams = [{ key: "T", vcsRepo: "some-org/some-repo" }];
    const map = buildRepoOwnerMap(teams);
    expect(map["some-repo"]).toBe("some-org/some-repo");
    expect(map["some-org"]).toBeUndefined();
  });

  // CTL-979: case normalization — vcsRepo "rightsite-cloud/Adva" must map key "adva"
  it("lowercases the repo short-name so /api/repo-icon/adva matches Adva vcsRepo (CTL-979)", () => {
    const teams = [{ key: "ADV", vcsRepo: "rightsite-cloud/Adva" }];
    const map = buildRepoOwnerMap(teams);
    expect(map["adva"]).toBe("rightsite-cloud/Adva");
    expect(map["Adva"]).toBeUndefined();
  });
});

// ── loadMonitorConfig — repoOwners ────────────────────────────────────────────

describe("loadMonitorConfig — repoOwners extraction (CTL-961)", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ctl-961-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "config.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts repoOwners from monitor.linear.teams", () => {
    writeFileSync(configPath, JSON.stringify({
      catalyst: {
        monitor: {
          github: { repoColors: { "coalesce-labs/catalyst": "green" } },
          linear: {
            teams: [
              { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
              { key: "ADV", vcsRepo: "coalesce-labs/adva" },
            ],
          },
        },
      },
    }));
    const cfg = loadMonitorConfig(configPath);
    expect(cfg.repoOwners).toEqual({
      catalyst: "coalesce-labs/catalyst",
      adva: "coalesce-labs/adva",
    });
  });

  it("returns empty repoOwners when linear.teams is absent", () => {
    writeFileSync(configPath, JSON.stringify({
      catalyst: {
        monitor: {
          github: { repoColors: {} },
          linear: {},
        },
      },
    }));
    const cfg = loadMonitorConfig(configPath);
    expect(cfg.repoOwners).toEqual({});
  });

  it("returns empty repoOwners when monitor section is absent", () => {
    writeFileSync(configPath, JSON.stringify({ catalyst: {} }));
    const cfg = loadMonitorConfig(configPath);
    expect(cfg.repoOwners).toEqual({});
  });

  it("returns empty repoOwners when config file is missing", () => {
    const cfg = loadMonitorConfig(join(tmpDir, "does-not-exist.json"));
    expect(cfg.repoOwners).toEqual({});
  });

  it("still returns repoColors alongside repoOwners", () => {
    writeFileSync(configPath, JSON.stringify({
      catalyst: {
        monitor: {
          github: { repoColors: { "coalesce-labs/catalyst": "green" } },
          linear: {
            teams: [{ key: "CTL", vcsRepo: "coalesce-labs/catalyst" }],
          },
        },
      },
    }));
    const cfg = loadMonitorConfig(configPath);
    expect(cfg.repoColors["coalesce-labs/catalyst"]).toBe("green");
    expect(cfg.repoOwners.catalyst).toBe("coalesce-labs/catalyst");
  });

  // CTL-979: case normalization for private-org repos with mixed-case names
  it("lowercases repo short-name key for mixed-case vcsRepo (CTL-979)", () => {
    writeFileSync(configPath, JSON.stringify({
      catalyst: {
        monitor: {
          linear: {
            teams: [{ key: "ADV", vcsRepo: "rightsite-cloud/Adva" }],
          },
        },
      },
    }));
    const cfg = loadMonitorConfig(configPath);
    expect(cfg.repoOwners["adva"]).toBe("rightsite-cloud/Adva");
    expect(cfg.repoOwners["Adva"]).toBeUndefined();
  });
});
