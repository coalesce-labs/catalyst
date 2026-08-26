// codex-emitter.test.mjs — CTL-1463 Phase 4.
//
// Run: bun test scripts/packaging/__tests__/codex-emitter.test.mjs

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveCodexVersion,
  buildCodexPluginJson,
  buildCodexInterface,
  buildCodexCatalog,
  renderCodexCatalog,
  renderCodexPluginJson,
  buildCodexGeneratedMarker,
} from "../emitters/codex.mjs";
import { readPackManifest } from "../core/pack-manifest.mjs";
import { readExistingVersion } from "../emitters/claude.mjs";
import { listPluginRelPaths } from "../providers/local.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

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

// buildCodexGeneratedMarker's sourceHash — CTL-1461 Phase 3 regressions.
//
// PR #4015's first CI run failed the drift gate on plugins/dev's marker even
// though nothing about plugins/dev changed. Two things came out of
// diagnosing it: (1) hashing a bare JS string via `Hash.update()` relies on
// its default string encoding, which is needless ambiguity for content that
// can contain non-ASCII bytes (plugins/dev's real description has a literal
// `→`) — fixed by hashing an explicit `Buffer.from(str, "utf8")`. (2) the
// ACTUAL failure that day was unrelated to encoding: `main` had moved (an
// unrelated release-please version bump) between branch and CI's merge
// check, and `version` was part of the hash input — so Codex's own review of
// this PR (#4015, P1) correctly flagged that folding `version` into
// `sourceHash` would repeat this failure on every future release PR. Fixed
// by hashing `packManifest` alone; version's own content is already visible
// and diffed directly in plugin.json.
//
// The expected hash below is HAND-COMPUTED independently via
// `printf '%s' '<the exact JSON>' | shasum -a 256` — never derived by running
// the code under test, so it can only confirm the fixed behavior, not the
// bug that produced a different answer.
describe("buildCodexGeneratedMarker — sourceHash is a runtime-independent UTF-8 byte hash", () => {
  test("a manifest containing a literal non-ASCII character hashes to the independently-computed value", () => {
    const packManifest = { packId: "x", description: "research → plan" };
    const marker = buildCodexGeneratedMarker(packManifest);
    expect(marker.sourceHash).toBe("sha256:985e4e4b340e1a29db7fdeee3a182951f150a15e0644863c14efde1b31163fbe");
  });

  test("the same inputs, rebuilt from scratch (no shared object reference), hash identically", () => {
    const a = buildCodexGeneratedMarker({ packId: "x", description: "research → plan" });
    const b = buildCodexGeneratedMarker(JSON.parse('{"packId":"x","description":"research → plan"}'));
    expect(a.sourceHash).toBe(b.sourceHash);
  });

  test("mutation control: a different description hashes differently", () => {
    const a = buildCodexGeneratedMarker({ packId: "x", description: "research → plan" });
    const b = buildCodexGeneratedMarker({ packId: "x", description: "research → plan → implement" });
    expect(a.sourceHash).not.toBe(b.sourceHash);
  });

  test("Codex #4015 P1 regression: sourceHash does NOT vary with version — a routine release-please bump must never invalidate a committed marker", () => {
    const packManifest = { packId: "x", description: "research → plan" };
    expect(buildCodexGeneratedMarker(packManifest).sourceHash).toBe(buildCodexGeneratedMarker(packManifest).sourceHash);
    // buildCodexGeneratedMarker no longer even accepts a version argument —
    // asserted structurally too: the function's arity is 1.
    expect(buildCodexGeneratedMarker.length).toBe(1);
  });
});

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

// --- CTL-1461 Phase 3: round-trip against the REAL committed tree ----------
// Prior coverage here used synthetic in-memory fixtures only (the research's
// finding). This is what actually proves the drift gate has something real
// to compare against for the Codex target, the way claude-emitter.test.mjs
// already does for the Claude target.
describe("codex emitter — round-trip against the real committed .codex-plugin/plugin.json (all codex-enabled plugins)", () => {
  const codexEnabledPluginRelPaths = listPluginRelPaths(repoRoot).filter(
    (p) => readPackManifest(repoRoot, p).distribution.codex?.enabled === true
  );

  test("at least one real plugin is codex-enabled (positive control on the filter itself)", () => {
    expect(codexEnabledPluginRelPaths.length).toBeGreaterThan(0);
  });

  for (const pluginRelPath of codexEnabledPluginRelPaths) {
    test(`${pluginRelPath}/.codex-plugin/plugin.json regenerates byte-identically`, () => {
      const manifest = readPackManifest(repoRoot, pluginRelPath);
      const claudeVersion = readExistingVersion(repoRoot, pluginRelPath);
      const version = resolveCodexVersion({ repoRoot, pluginRelPath, claudeVersion });
      const rendered = renderCodexPluginJson(manifest, version) + "\n";
      const committed = readFileSync(resolve(repoRoot, pluginRelPath, ".codex-plugin/plugin.json"), "utf8");
      expect(rendered).toBe(committed);
    });
  }

  test("mutation control: perturbing one plugin's description produces a NON-empty diff against the real committed file", () => {
    const pluginRelPath = codexEnabledPluginRelPaths[0];
    const manifest = readPackManifest(repoRoot, pluginRelPath);
    const claudeVersion = readExistingVersion(repoRoot, pluginRelPath);
    const version = resolveCodexVersion({ repoRoot, pluginRelPath, claudeVersion });

    const mutated = JSON.parse(JSON.stringify(manifest));
    mutated.identity.description += " MUTATED";
    const rendered = renderCodexPluginJson(mutated, version) + "\n";
    const committed = readFileSync(resolve(repoRoot, pluginRelPath, ".codex-plugin/plugin.json"), "utf8");
    expect(rendered).not.toBe(committed);
  });
});

describe("codex emitter — round-trip against the real committed .agents/plugins/marketplace.json", () => {
  function realConfigOrder() {
    const config = JSON.parse(readFileSync(resolve(repoRoot, "release-please-config.json"), "utf8"));
    return Object.keys(config.packages);
  }

  test("regenerates the real committed catalog byte-identically", () => {
    const order = realConfigOrder().filter((p) => readPackManifest(repoRoot, p).distribution.codex?.enabled === true);
    const entries = order.map((pluginRelPath) => ({ pluginRelPath, packManifest: readPackManifest(repoRoot, pluginRelPath) }));
    const rendered = renderCodexCatalog(entries) + "\n";
    const committed = readFileSync(resolve(repoRoot, ".agents/plugins/marketplace.json"), "utf8");
    expect(rendered).toBe(committed);
  });

  test("mutation control: perturbing one entry's description produces a NON-empty diff against the real committed catalog", () => {
    const order = realConfigOrder().filter((p) => readPackManifest(repoRoot, p).distribution.codex?.enabled === true);
    const entries = order.map((pluginRelPath) => ({ pluginRelPath, packManifest: readPackManifest(repoRoot, pluginRelPath) }));
    const mutated = JSON.parse(JSON.stringify(entries[0].packManifest));
    mutated.identity.description += " MUTATED";
    entries[0] = { ...entries[0], packManifest: mutated };

    const rendered = renderCodexCatalog(entries) + "\n";
    const committed = readFileSync(resolve(repoRoot, ".agents/plugins/marketplace.json"), "utf8");
    expect(rendered).not.toBe(committed);
  });
});
