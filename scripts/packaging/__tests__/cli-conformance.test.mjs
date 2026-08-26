// cli-conformance.test.mjs — CTL-2215 Phase 1.
//
// Tests the `conformance` subcommand's WIRING (arg parsing, verdict → exit
// code), not the grading rules themselves (agentskills-spec.test.mjs owns
// those). cmdConformance is pure aside from console.log — it returns
// { exitCode, result } instead of calling process.exit directly — so these
// assertions never spawn a subprocess and never risk killing the test
// runner.
//
// Run: bun test scripts/packaging/__tests__/cli-conformance.test.mjs

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { cmdConformance, runAgentsSkillsConformance, repoRoot } from "../cli.mjs";

let _tmpDirs = [];
function fixtureDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "cli-conformance-test-"));
  _tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
  _tmpDirs = [];
});

/**
 * buildFixtureRepo(root, { skillFrontmatter, agentsSkillsEnabled }) — the
 * minimal on-disk shape renderAllPacks needs: one plugin, one skill, a
 * release-please-config.json entry agreeing with disk. Mirrors
 * inventory-cut.test.sh's `build_plugin` shape (bash), reimplemented here in
 * JS so cmdConformance can be exercised as a plain function call.
 */
function buildFixtureRepo(root, { skillFrontmatter, agentsSkillsEnabled = true } = {}) {
  const pluginDir = resolve(root, "plugins/fixture-plugin");
  mkdirSync(resolve(pluginDir, ".claude-plugin"), { recursive: true });
  mkdirSync(resolve(pluginDir, "skills/only-skill/agents"), { recursive: true });

  writeFileSync(
    resolve(pluginDir, ".claude-plugin/plugin.json"),
    JSON.stringify(
      {
        name: "fixture-plugin",
        version: "0.0.1",
        description: "Synthetic fixture plugin.",
        author: { name: "Fixture", email: "fixture@example.com" },
        homepage: "https://example.com",
        repository: "https://example.com/fixture.git",
        keywords: ["fixture"],
        license: "MIT",
      },
      null,
      2
    )
  );

  writeFileSync(
    resolve(pluginDir, "pack.json"),
    JSON.stringify(
      {
        packId: "fixture-plugin",
        identity: {
          description: "Synthetic fixture plugin.",
          author: { name: "Fixture", email: "fixture@example.com" },
          homepage: "https://example.com",
          repository: "https://example.com/fixture.git",
          keywords: ["fixture"],
          license: "MIT",
        },
        distribution: {
          claude: { enabled: true, marketplace: { description: "Fixture", category: "development", keywords: ["fixture"] } },
          codex: { enabled: true },
          agentsSkills: { enabled: agentsSkillsEnabled },
        },
      },
      null,
      2
    )
  );

  writeFileSync(
    resolve(pluginDir, "skills/only-skill/SKILL.md"),
    skillFrontmatter ?? "---\nname: only-skill\ndescription: The only skill in the fixture plugin.\n---\n\n# Only Skill\n\nFixture body.\n"
  );
  writeFileSync(resolve(pluginDir, "skills/only-skill/agents/portability.yaml"), 'effects: []\ninvocation: auto\nexposure: ["catalog"]\n');

  writeFileSync(
    resolve(root, "release-please-config.json"),
    JSON.stringify({ packages: { "plugins/fixture-plugin": { "release-type": "simple", component: "fixture-plugin" } } }, null, 2)
  );
}

describe("cmdConformance — the real repo", () => {
  test("exits 0 with verdict ok and checkedCount matching the current tree", () => {
    const { exitCode, result } = cmdConformance(["--target", "agentsSkills"], repoRoot);
    expect(exitCode).toBe(0);
    expect(result.verdict).toBe("ok");
    expect(result.checkedCount).toBeGreaterThan(0);
  });
});

describe("cmdConformance — unknown/missing --target", () => {
  test("exits non-zero, never reaches a runner", () => {
    const { exitCode, result } = cmdConformance([], repoRoot);
    expect(exitCode).toBe(1);
    expect(result).toBeNull();
  });

  test("an unsupported target name (e.g. codex) also exits non-zero", () => {
    const { exitCode, result } = cmdConformance(["--target", "codex"], repoRoot);
    expect(exitCode).toBe(1);
    expect(result).toBeNull();
  });
});

describe("cmdConformance — a clean fixture repo", () => {
  test("exits 0 with verdict ok", () => {
    const root = fixtureDir();
    buildFixtureRepo(root);
    const { exitCode, result } = cmdConformance(["--target", "agentsSkills"], root);
    expect(exitCode).toBe(0);
    expect(result.verdict).toBe("ok");
    expect(result.checkedCount).toBe(1);
  });
});

describe("cmdConformance — a fixture repo whose skill violates the spec", () => {
  test("exits non-zero with verdict violations", () => {
    const root = fixtureDir();
    buildFixtureRepo(root, { skillFrontmatter: "---\nname: only-skill\n---\n\n# Only Skill\n\nMissing description.\n" });
    const { exitCode, result } = cmdConformance(["--target", "agentsSkills"], root);
    expect(exitCode).toBe(1);
    expect(result.verdict).toBe("violations");
    expect(result.violations.length).toBeGreaterThan(0);
  });
});

describe("cmdConformance — a fixture repo with an empty emit set", () => {
  test("agentsSkills disabled pack-wide → exits non-zero with verdict inconclusive, never ok", () => {
    const root = fixtureDir();
    buildFixtureRepo(root, { agentsSkillsEnabled: false });
    const { exitCode, result } = cmdConformance(["--target", "agentsSkills"], root);
    expect(exitCode).toBe(1);
    expect(result.verdict).toBe("inconclusive");
  });
});

describe("runAgentsSkillsConformance — an unreadable source root", () => {
  test("a repoRootPath with no readable plugin source (missing release-please-config.json, missing plugins/) is inconclusive, never ok", () => {
    const root = fixtureDir(); // deliberately left empty — nothing to read
    const result = runAgentsSkillsConformance(root);
    expect(result.verdict).toBe("inconclusive");
    expect(result.reason).toMatch(/could not build/);
  });

  test("the same unreadable root, through cmdConformance, exits non-zero", () => {
    const root = fixtureDir();
    const { exitCode, result } = cmdConformance(["--target", "agentsSkills"], root);
    expect(exitCode).toBe(1);
    expect(result.verdict).toBe("inconclusive");
  });
});
