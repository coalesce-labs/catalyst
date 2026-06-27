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

// ── inferIconFormat ───────────────────────────────────────────────────────────

import { inferIconFormat, pickBestCandidate, type IconCandidate } from "../lib/repo-icon-fetcher";

describe("inferIconFormat", () => {
  it("maps extensions to formats", () => {
    expect(inferIconFormat("logo.svg")).toBe("svg");
    expect(inferIconFormat("public/favicon.png")).toBe("png");
    expect(inferIconFormat("favicon.ico")).toBe("ico");
  });
  it("treats apple-touch-icon.png as png", () => {
    expect(inferIconFormat("apple-touch-icon.png")).toBe("png");
  });
  it("is case-insensitive", () => {
    expect(inferIconFormat("Logo.SVG")).toBe("svg");
    expect(inferIconFormat("Icon.ICO")).toBe("ico");
  });
});

describe("pickBestCandidate", () => {
  const mk = (path: string): IconCandidate => ({
    path, format: inferIconFormat(path),
    downloadUrl: `https://x/${path}`, dataUrl: null,
  });

  it("prefers svg over png over ico regardless of probe order", () => {
    const cands = [mk("favicon.ico"), mk("logo.png"), mk("logo.svg")];
    expect(pickBestCandidate(cands)?.path).toBe("logo.svg");
  });
  it("within the same format, earlier ICON_PATH_PRIORITY index wins", () => {
    const cands = [mk("static/favicon.png"), mk("public/favicon.png")];
    expect(pickBestCandidate(cands)?.path).toBe("public/favicon.png");
  });
  it("returns null for an empty candidate list", () => {
    expect(pickBestCandidate([])).toBeNull();
  });
  it("handles a single candidate", () => {
    expect(pickBestCandidate([mk("favicon.ico")])?.path).toBe("favicon.ico");
  });
  it("returns one candidate when both same-format paths are absent from ICON_PATH_PRIORITY (both indexOf = -1)", () => {
    // Both return -1 from indexOf; sort is stable — first in array wins.
    const cands = [mk("unknown-a.svg"), mk("unknown-b.svg")];
    const result = pickBestCandidate(cands);
    expect(result).not.toBeNull();
    expect(["unknown-a.svg", "unknown-b.svg"]).toContain(result?.path ?? "");
  });
});

// ── owner-avatar fallback (CTL-1380, Bug B) ───────────────────────────────────

import {
  OWNER_AVATAR_PATH,
  buildAvatarIconResult,
  resolveOwnerAvatar,
} from "../lib/repo-icon-fetcher";

describe("OWNER_AVATAR_PATH (CTL-1380)", () => {
  it("is a sentinel that never collides with a real probed icon path", () => {
    expect(OWNER_AVATAR_PATH).toBe("owner-avatar");
    expect(ICON_PATH_PRIORITY).not.toContain(OWNER_AVATAR_PATH);
  });
});

describe("buildAvatarIconResult (CTL-1380, Bug B)", () => {
  it("builds a found:true single-candidate result keyed on the avatar sentinel", () => {
    const res = buildAvatarIconResult(
      "https://avatars.githubusercontent.com/u/123?v=4",
      "data:image/png;base64,AAAA",
    );
    expect(res.found).toBe(true);
    if (!res.found) throw new Error("unreachable");
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].path).toBe(OWNER_AVATAR_PATH);
    expect(res.candidates[0].format).toBe("png");
    expect(res.candidates[0].dataUrl).toBe("data:image/png;base64,AAAA");
    // selectedPath + legacy mirror fields all point at the avatar
    expect(res.selectedPath).toBe(OWNER_AVATAR_PATH);
    expect(res.path).toBe(OWNER_AVATAR_PATH);
    expect(res.downloadUrl).toBe("https://avatars.githubusercontent.com/u/123?v=4");
    expect(res.dataUrl).toBe("data:image/png;base64,AAAA");
  });

  it("fails open to found:false when the avatar URL is missing", () => {
    expect(buildAvatarIconResult(null, "data:image/png;base64,AAAA")).toEqual({ found: false });
  });

  it("fails open to found:false when the avatar data URL could not be fetched", () => {
    expect(buildAvatarIconResult("https://avatars.githubusercontent.com/u/1", null)).toEqual({
      found: false,
    });
  });

  it("the avatar candidate is renderable by pickBestCandidate (path absent from priority list)", () => {
    const res = buildAvatarIconResult("https://x/avatar", "data:image/png;base64,AAAA");
    if (!res.found) throw new Error("unreachable");
    expect(pickBestCandidate(res.candidates)?.path).toBe(OWNER_AVATAR_PATH);
  });
});

describe("resolveOwnerAvatar (CTL-1380) — owner extraction guards", () => {
  it("returns null for an empty slug without shelling out", () => {
    expect(resolveOwnerAvatar("")).toBeNull();
  });

  it("returns null when the owner segment is empty ('/repo')", () => {
    expect(resolveOwnerAvatar("/repo")).toBeNull();
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
  // §13: loadMonitorConfig now also reads the registry; these config-only cases
  // point at a nonexistent registry so they stay deterministic regardless of the
  // host machine's real ~/catalyst/execution-core/registry.json.
  let noRegistry: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ctl-961-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, "config.json");
    noRegistry = join(tmpDir, "no-registry.json");
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
    const cfg = loadMonitorConfig(configPath, noRegistry);
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
    const cfg = loadMonitorConfig(configPath, noRegistry);
    expect(cfg.repoOwners).toEqual({});
  });

  it("returns empty repoOwners when monitor section is absent", () => {
    writeFileSync(configPath, JSON.stringify({ catalyst: {} }));
    const cfg = loadMonitorConfig(configPath, noRegistry);
    expect(cfg.repoOwners).toEqual({});
  });

  it("returns empty repoOwners when config file is missing", () => {
    const cfg = loadMonitorConfig(join(tmpDir, "does-not-exist.json"), noRegistry);
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
    const cfg = loadMonitorConfig(configPath, noRegistry);
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
    const cfg = loadMonitorConfig(configPath, noRegistry);
    expect(cfg.repoOwners["adva"]).toBe("rightsite-cloud/Adva");
    expect(cfg.repoOwners["Adva"]).toBeUndefined();
  });

  // §13: the machine-level registry corrects a STALE committed roster.
  it("registry repoRoot OVERRIDES a stale config vcsRepo (ADV → groundworkapp/Adva)", () => {
    writeFileSync(configPath, JSON.stringify({
      catalyst: { monitor: { linear: { teams: [
        { key: "CTL", vcsRepo: "coalesce-labs/catalyst" },
        { key: "ADV", vcsRepo: "coalesce-labs/adva" }, // stale 404
      ] } } },
    }));
    const registryPath = join(tmpDir, "registry.json");
    writeFileSync(registryPath, JSON.stringify({ projects: [
      { team: "CTL", repoRoot: "/Users/x/code-repos/github/coalesce-labs/catalyst" },
      { team: "ADV", repoRoot: "/Users/x/code-repos/github/groundworkapp/Adva" },
    ] }));
    const cfg = loadMonitorConfig(configPath, registryPath);
    expect(cfg.repoOwners["adva"]).toBe("groundworkapp/Adva"); // registry wins
    expect(cfg.repoOwners["catalyst"]).toBe("coalesce-labs/catalyst");
  });

  it("derives repoOwners from the registry even when config has no teams", () => {
    writeFileSync(configPath, JSON.stringify({ catalyst: { monitor: {} } }));
    const registryPath = join(tmpDir, "registry.json");
    writeFileSync(registryPath, JSON.stringify({ projects: [
      { team: "ADV", repoRoot: "/home/ci/code-repos/github/groundworkapp/Adva" },
    ] }));
    const cfg = loadMonitorConfig(configPath, registryPath);
    expect(cfg.repoOwners["adva"]).toBe("groundworkapp/Adva");
  });

  it("ignores a registry repoRoot with no /github/<owner>/<repo> segment", () => {
    writeFileSync(configPath, JSON.stringify({ catalyst: { monitor: {} } }));
    const registryPath = join(tmpDir, "registry.json");
    writeFileSync(registryPath, JSON.stringify({ projects: [
      { team: "X", repoRoot: "/some/local/path/no-github" },
    ] }));
    const cfg = loadMonitorConfig(configPath, registryPath);
    expect(cfg.repoOwners).toEqual({});
  });
});
