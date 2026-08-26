// pack-manifest.test.mjs — CTL-1463 Phase 3.
//
// Run: bun test scripts/packaging/__tests__/pack-manifest.test.mjs

import { describe, test, expect } from "bun:test";
import { fileURLToPath } from "node:url";

import { validatePackManifest, readPackManifest } from "../core/pack-manifest.mjs";
import { listPluginRelPaths } from "../providers/local.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("validatePackManifest — all 6 real pack.json files", () => {
  const pluginRelPaths = listPluginRelPaths(repoRoot);

  test("discovers 6 plugins", () => {
    expect(pluginRelPaths.length).toBe(6);
  });

  for (const pluginRelPath of pluginRelPaths) {
    test(`${pluginRelPath}/pack.json validates`, () => {
      const pack = readPackManifest(repoRoot, pluginRelPath);
      expect(pack).not.toBeNull();
      const result = validatePackManifest(pack);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    });
  }
});

describe("validatePackManifest — rejection rules", () => {
  function validPack() {
    return {
      packId: "catalyst-x",
      identity: {
        description: "x",
        author: { name: "a", email: "a@b.com" },
        homepage: "https://example.com",
        repository: "https://example.com/x.git",
        keywords: ["x"],
        license: "MIT",
      },
      distribution: {
        claude: { enabled: true, marketplace: { description: "x", category: "development", keywords: ["x"] } },
        codex: { enabled: true },
        agentsSkills: { enabled: true },
      },
    };
  }

  test("a version key is rejected naming release-please as the owner", () => {
    const pack = validPack();
    pack.version = "1.2.3";
    const result = validatePackManifest(pack);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("release-please"))).toBe(true);
  });

  test("a skills key is rejected naming agents/portability.yaml as the new owner", () => {
    const pack = validPack();
    pack.skills = { commit: { effects: [], invocation: "auto", exposure: ["catalog"] } };
    const result = validatePackManifest(pack);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("agents/portability.yaml"))).toBe(true);
  });

  test("an unknown top-level key is rejected", () => {
    const pack = validPack();
    pack.bogus = true;
    const result = validatePackManifest(pack);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("bogus"))).toBe(true);
  });

  test("the valid fixture passes (positive control)", () => {
    expect(validatePackManifest(validPack()).ok).toBe(true);
  });
});
