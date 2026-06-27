// repo-icon-fetcher.test.ts — unit tests for CTL-961 repo icon path resolver,
// cache helpers, and repoOwners config parsing.
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
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
  // Renderable by default: a non-empty base64 payload after the `,` separator.
  const mk = (path: string, dataUrl: string | null = "data:image/png;base64,AAAA"): IconCandidate => ({
    path, format: inferIconFormat(path),
    downloadUrl: `https://x/${path}`, dataUrl,
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

  // ── renderability filtering (empty-favicon bug) ─────────────────────────────
  it("never selects a candidate with a null dataUrl", () => {
    // The crispest format (svg) is NOT renderable → the renderable png wins instead.
    const cands = [mk("logo.svg", null), mk("favicon.png")];
    expect(pickBestCandidate(cands)?.path).toBe("favicon.png");
  });
  it("never selects a candidate with a prefix-only (empty base64) dataUrl", () => {
    const cands = [mk("logo.svg", "data:image/svg+xml;base64,"), mk("favicon.png")];
    expect(pickBestCandidate(cands)?.path).toBe("favicon.png");
  });
  it("returns null when NO candidate is renderable (all null/empty dataUrls)", () => {
    const cands = [mk("favicon.ico", null), mk("logo.svg", "data:image/svg+xml;base64,")];
    expect(pickBestCandidate(cands)).toBeNull();
  });
  it("selects the only renderable candidate even when a crisper format is empty", () => {
    const cands = [mk("logo.svg", null), mk("favicon.ico")];
    expect(pickBestCandidate(cands)?.path).toBe("favicon.ico");
  });
});

// ── hasRenderableDataUrl (empty-favicon bug) ──────────────────────────────────

import { hasRenderableDataUrl } from "../lib/repo-icon-fetcher";

describe("hasRenderableDataUrl", () => {
  it("is false for a null dataUrl", () => {
    expect(hasRenderableDataUrl({ dataUrl: null })).toBe(false);
  });
  it("is false for the exact prefix-only ICO data URL from the live bug (length 37)", () => {
    const empty = "data:image/vnd.microsoft.icon;base64,";
    expect(empty.length).toBe(37); // matches the live blank-icon cache evidence
    expect(hasRenderableDataUrl({ dataUrl: empty })).toBe(false);
  });
  it("is false for an empty string", () => {
    expect(hasRenderableDataUrl({ dataUrl: "" })).toBe(false);
  });
  it("is true for a data URL with real base64 payload after the comma", () => {
    expect(hasRenderableDataUrl({ dataUrl: "data:image/png;base64,AAAA" })).toBe(true);
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

// ── fetchAsDataUrl — empty body guard (empty-favicon bug) ─────────────────────

import { fetchAsDataUrl } from "../lib/repo-icon-fetcher";

describe("fetchAsDataUrl — empty-body guard", () => {
  const realFetch = globalThis.fetch;
  // Typed offline mock: matches typeof globalThis.fetch (call signature + preconnect) so
  // no `as`-cast is needed. Always restored in afterEach — global mocks are process-wide.
  const setMockFetch = (make: () => Response): void => {
    globalThis.fetch = Object.assign(
      (_input: string | URL | Request, _init?: RequestInit): Promise<Response> => Promise.resolve(make()),
      { preconnect: (_url: string | URL, _options?: unknown): void => {} },
    );
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns null when the response body is EMPTY even though HTTP is 200", async () => {
    setMockFetch(() =>
      new Response(new ArrayBuffer(0), {
        status: 200,
        headers: { "content-type": "image/vnd.microsoft.icon" },
      }),
    );
    expect(await fetchAsDataUrl("https://example/favicon.ico")).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    setMockFetch(() => new Response("nope", { status: 404 }));
    expect(await fetchAsDataUrl("https://example/missing.ico")).toBeNull();
  });

  it("returns a renderable data URL when the body has bytes", async () => {
    setMockFetch(() =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const out = await fetchAsDataUrl("https://example/logo.png");
    expect(out).toBe("data:image/png;base64,AQIDBA==");
    expect(hasRenderableDataUrl({ dataUrl: out })).toBe(true);
  });
});

// ── fetchRepoIcon — empty-favicon → avatar fallback (offline, deps-injected) ──

import { fetchRepoIcon, type RepoIconDeps, type IconResult } from "../lib/repo-icon-fetcher";

describe("fetchRepoIcon — empty-favicon never positive-caches a blank icon", () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = join(tmpdir(), `repo-icon-empty-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });
  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  const VALID = "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=";
  const AVATAR_URL = "https://avatars.githubusercontent.com/u/1?v=4";
  const AVATAR_DATA = "data:image/png;base64,QVZBVEFS";

  // Read back what was persisted to the disk cache for the slug.
  const readCacheFile = (ownerRepo: string): { schemaVersion: number; result: IconResult } | null => {
    const file = join(cacheDir, `${ownerRepo.replace(/\//g, "--")}.json`);
    try {
      return JSON.parse(readFileSync(file, "utf8")) as { schemaVersion: number; result: IconResult };
    } catch {
      return null;
    }
  };

  it("a hit whose body fetched EMPTY (null dataUrl) → falls through to the avatar fallback", async () => {
    const deps: RepoIconDeps = {
      resolveCandidates: () => [{ path: "favicon.ico", downloadUrl: "https://repo/favicon.ico" }],
      resolveAvatar: () => AVATAR_URL,
      fetchDataUrl: (url) => Promise.resolve(url === AVATAR_URL ? AVATAR_DATA : null), // favicon body empty → null
    };
    const res = await fetchRepoIcon("coalesce-labs/catalyst", cacheDir, deps);
    expect(res.found).toBe(true);
    if (!res.found) throw new Error("unreachable");
    expect(res.selectedPath).toBe(OWNER_AVATAR_PATH);
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].dataUrl).toBe(AVATAR_DATA);
    // cached found:true, and the cached candidate is renderable
    const cached = readCacheFile("coalesce-labs/catalyst");
    expect(cached?.schemaVersion).toBe(4);
    expect(cached?.result.found).toBe(true);
    if (cached?.result.found) {
      expect(cached.result.candidates.every((c) => hasRenderableDataUrl(c))).toBe(true);
    }
  });

  it("a hit whose body fetched a prefix-only empty data URL → still treated as no-icon → avatar fallback", async () => {
    const deps: RepoIconDeps = {
      resolveCandidates: () => [{ path: "favicon.ico", downloadUrl: "https://repo/favicon.ico" }],
      resolveAvatar: () => AVATAR_URL,
      // a length-37 prefix-only data URL (the live blank-icon evidence) is NOT renderable
      fetchDataUrl: (url) =>
        Promise.resolve(url === AVATAR_URL ? AVATAR_DATA : "data:image/vnd.microsoft.icon;base64,"),
    };
    const res = await fetchRepoIcon("coalesce-labs/catalyst", cacheDir, deps);
    expect(res.found).toBe(true);
    if (!res.found) throw new Error("unreachable");
    expect(res.selectedPath).toBe(OWNER_AVATAR_PATH);
  });

  it("empty favicon AND no avatar available → found:false, cached NEGATIVE (not positive)", async () => {
    const deps: RepoIconDeps = {
      resolveCandidates: () => [{ path: "favicon.ico", downloadUrl: "https://repo/favicon.ico" }],
      resolveAvatar: () => null, // no avatar either
      fetchDataUrl: () => Promise.resolve(null),
    };
    const res = await fetchRepoIcon("coalesce-labs/catalyst", cacheDir, deps);
    expect(res).toEqual({ found: false });
    const cached = readCacheFile("coalesce-labs/catalyst");
    expect(cached?.result).toEqual({ found: false }); // negative-cached, never found:true
  });

  it("a hit with valid content is KEPT and selected (no avatar fallback)", async () => {
    let avatarCalls = 0;
    const deps: RepoIconDeps = {
      resolveCandidates: () => [{ path: "logo.svg", downloadUrl: "https://repo/logo.svg" }],
      resolveAvatar: () => {
        avatarCalls++;
        return AVATAR_URL;
      },
      fetchDataUrl: () => Promise.resolve(VALID),
    };
    const res = await fetchRepoIcon("coalesce-labs/catalyst", cacheDir, deps);
    expect(res.found).toBe(true);
    if (!res.found) throw new Error("unreachable");
    expect(res.selectedPath).toBe("logo.svg");
    expect(res.dataUrl).toBe(VALID);
    expect(avatarCalls).toBe(0); // fallback not consulted when a renderable favicon exists
  });

  it("mixed empty + valid hits → only the valid candidate survives and is selected", async () => {
    const deps: RepoIconDeps = {
      resolveCandidates: () => [
        { path: "favicon.ico", downloadUrl: "https://repo/favicon.ico" }, // empty
        { path: "logo.svg", downloadUrl: "https://repo/logo.svg" }, // valid
      ],
      resolveAvatar: () => AVATAR_URL,
      fetchDataUrl: (url) => Promise.resolve(url === "https://repo/logo.svg" ? VALID : null),
    };
    const res = await fetchRepoIcon("coalesce-labs/catalyst", cacheDir, deps);
    expect(res.found).toBe(true);
    if (!res.found) throw new Error("unreachable");
    expect(res.candidates).toHaveLength(1); // empty one dropped
    expect(res.candidates[0].path).toBe("logo.svg");
    expect(res.selectedPath).toBe("logo.svg");
    expect(res.candidates.every((c) => hasRenderableDataUrl(c))).toBe(true);
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
