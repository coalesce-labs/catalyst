// codex-emitter.test.mjs — CTL-1463 Phase 4.
//
// Run: bun test scripts/packaging/__tests__/codex-emitter.test.mjs

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { resolveCodexVersion, buildCodexPluginJson, buildCodexCatalog, renderCodexCatalog } from "../emitters/codex.mjs";

let _tmpDirs = [];
function fixtureDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "codex-emitter-test-"));
  _tmpDirs.push(dir);
  return dir;
}
function writeFile(dir, relPath, contents) {
  const path = resolve(dir, relPath);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}
afterEach(() => {
  for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
  _tmpDirs = [];
});

function packManifest(overrides = {}) {
  return {
    packId: "catalyst-x",
    identity: {
      description: "d",
      author: { name: "a", email: "a@b.com" },
      homepage: "https://example.com",
      repository: "https://example.com/x.git",
      keywords: ["x"],
      license: "MIT",
    },
    distribution: {
      claude: { enabled: true, marketplace: { description: "market d", category: "development", keywords: ["mk"] } },
      codex: { enabled: true },
      agentsSkills: { enabled: true },
    },
    skills: {},
    ...overrides,
  };
}

describe("resolveCodexVersion", () => {
  test("CREATE: no existing .codex-plugin/plugin.json — seeds from claudeVersion", () => {
    const dir = fixtureDir();
    const version = resolveCodexVersion({ repoRoot: dir, pluginRelPath: "plugins/x", claudeVersion: "1.2.3" });
    expect(version).toBe("1.2.3");
  });

  test("REGENERATE, agreeing versions — PASSES, returns the (shared) version", () => {
    const dir = fixtureDir();
    writeFile(dir, "plugins/x/.codex-plugin/plugin.json", JSON.stringify({ version: "1.2.3" }));
    const version = resolveCodexVersion({ repoRoot: dir, pluginRelPath: "plugins/x", claudeVersion: "1.2.3" });
    expect(version).toBe("1.2.3");
  });

  test("REGENERATE, disagreeing versions — FAILS (throws), naming both versions", () => {
    const dir = fixtureDir();
    writeFile(dir, "plugins/x/.codex-plugin/plugin.json", JSON.stringify({ version: "1.1.0" }));
    expect(() => resolveCodexVersion({ repoRoot: dir, pluginRelPath: "plugins/x", claudeVersion: "1.2.3" })).toThrow();
    try {
      resolveCodexVersion({ repoRoot: dir, pluginRelPath: "plugins/x", claudeVersion: "1.2.3" });
    } catch (err) {
      expect(String(err.message)).toContain("1.1.0");
      expect(String(err.message)).toContain("1.2.3");
    }
  });
});

describe("buildCodexPluginJson", () => {
  test("has no `agents` field (Claude-only) and no marketplace-only fields", () => {
    const built = buildCodexPluginJson(packManifest(), "1.0.0");
    expect(Object.keys(built)).toEqual([
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "keywords",
      "license",
    ]);
  });
});

describe("Codex catalog — no version field at any depth, both directions", () => {
  test("a real catalog build contains no 'version' key anywhere (recursive check, not shallow)", () => {
    const entries = [{ pluginRelPath: "plugins/x", packManifest: packManifest() }];
    const catalog = buildCodexCatalog(entries);
    const json = JSON.stringify(catalog);
    const parsed = JSON.parse(json);

    function findVersionKeys(obj, path = "$") {
      const hits = [];
      if (obj !== null && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          if (k === "version") hits.push(`${path}.${k}`);
          hits.push(...findVersionKeys(v, `${path}.${k}`));
        }
      } else if (Array.isArray(obj)) {
        obj.forEach((v, i) => hits.push(...findVersionKeys(v, `${path}[${i}]`)));
      }
      return hits;
    }
    expect(findVersionKeys(parsed)).toEqual([]);
  });

  test("positive control: the SAME recursive check finds a planted version field", () => {
    const entries = [{ pluginRelPath: "plugins/x", packManifest: packManifest() }];
    const catalog = buildCodexCatalog(entries);
    catalog.plugins[0].version = "9.9.9"; // plant a violation directly on the built object

    function findVersionKeys(obj, path = "$") {
      const hits = [];
      if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
        for (const [k, v] of Object.entries(obj)) {
          if (k === "version") hits.push(`${path}.${k}`);
          hits.push(...findVersionKeys(v, `${path}.${k}`));
        }
      } else if (Array.isArray(obj)) {
        obj.forEach((v, i) => hits.push(...findVersionKeys(v, `${path}[${i}]`)));
      }
      return hits;
    }
    expect(findVersionKeys(catalog).length).toBeGreaterThan(0);
  });

  test("renderCodexCatalog's raw text contains no literal \"version\" substring", () => {
    const entries = [{ pluginRelPath: "plugins/x", packManifest: packManifest() }];
    const text = renderCodexCatalog(entries);
    expect(text.includes('"version"')).toBe(false);
  });
});
