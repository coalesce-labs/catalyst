// codex-emitter.test.mjs — CTL-1463 Phase 4.
//
// Run: bun test scripts/packaging/__tests__/codex-emitter.test.mjs

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  resolveCodexVersion,
  buildCodexPluginJson,
  buildCodexInterface,
  buildCodexCatalog,
  renderCodexCatalog,
} from "../emitters/codex.mjs";

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
      "interface",
    ]);
  });

  test("never emits `dependencies` — not in the Codex validator's allowed key set, even when identity.dependencies is set", () => {
    const built = buildCodexPluginJson(packManifest({ identity: { ...packManifest().identity, dependencies: ["catalyst-dev"] } }), "1.0.0");
    expect(Object.keys(built)).not.toContain("dependencies");
  });
});

describe("buildCodexInterface — the required Codex plugin interface block", () => {
  const REQUIRED_STRING_FIELDS = ["displayName", "shortDescription", "longDescription", "developerName", "category"];

  test("every required string field is present and non-empty", () => {
    const iface = buildCodexInterface(packManifest());
    for (const field of REQUIRED_STRING_FIELDS) {
      expect(typeof iface[field]).toBe("string");
      expect(iface[field].length).toBeGreaterThan(0);
    }
  });

  test("capabilities is a non-empty array of non-empty strings", () => {
    const iface = buildCodexInterface(packManifest());
    expect(Array.isArray(iface.capabilities)).toBe(true);
    expect(iface.capabilities.length).toBeGreaterThan(0);
    for (const cap of iface.capabilities) {
      expect(typeof cap).toBe("string");
      expect(cap.length).toBeGreaterThan(0);
    }
  });

  test("defaultPrompt is present (validator requires presence of defaultPrompt or default_prompt)", () => {
    const iface = buildCodexInterface(packManifest());
    expect(iface.defaultPrompt).toBeDefined();
    expect(Array.isArray(iface.defaultPrompt)).toBe(true);
    expect(iface.defaultPrompt.length).toBeGreaterThan(0);
  });

  test("displayName is derived deterministically from packId", () => {
    const iface = buildCodexInterface(packManifest({ packId: "catalyst-pm-ops" }));
    expect(iface.displayName).toBe("Catalyst Pm Ops");
  });

  test("category falls back to the claude marketplace category, title-cased", () => {
    const manifest = packManifest();
    manifest.distribution.claude.marketplace.category = "development";
    expect(buildCodexInterface(manifest).category).toBe("Development");
  });

  test("shortDescription is truncated at 128 characters", () => {
    const longSentence = "x".repeat(200) + ".";
    const manifest = packManifest({ identity: { ...packManifest().identity, description: longSentence } });
    const iface = buildCodexInterface(manifest);
    expect(iface.shortDescription.length).toBeLessThanOrEqual(128);
  });

  test("no unknown keys — matches exactly the validator's allowed interface key set", () => {
    const ALLOWED = new Set([
      "displayName",
      "shortDescription",
      "longDescription",
      "developerName",
      "category",
      "capabilities",
      "websiteURL",
      "privacyPolicyURL",
      "termsOfServiceURL",
      "brandColor",
      "composerIcon",
      "logo",
      "logoDark",
      "screenshots",
      "defaultPrompt",
      "default_prompt",
    ]);
    const iface = buildCodexInterface(packManifest());
    for (const key of Object.keys(iface)) {
      expect(ALLOWED.has(key)).toBe(true);
    }
  });
});

describe("buildCodexCatalog — marketplace entry schema (source object + policy block)", () => {
  test("`source` is an object shaped {source: 'local', path: './<pluginRelPath>'}, not a bare string", () => {
    const entries = [{ pluginRelPath: "plugins/x", packManifest: packManifest() }];
    const catalog = buildCodexCatalog(entries);
    const entry = catalog.plugins[0];
    expect(typeof entry.source).toBe("object");
    expect(entry.source).toEqual({ source: "local", path: "./plugins/x" });
  });

  test("every entry carries a `policy` block with installation + authentication", () => {
    const entries = [{ pluginRelPath: "plugins/x", packManifest: packManifest() }];
    const catalog = buildCodexCatalog(entries);
    const entry = catalog.plugins[0];
    expect(entry.policy).toEqual({ installation: "AVAILABLE", authentication: "ON_INSTALL" });
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
