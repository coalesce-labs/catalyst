// local-provider.test.mjs — CTL-1461 Phase 1: the real render interface.
//
// Run: bun test scripts/packaging/__tests__/local-provider.test.mjs

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  validateRenderedPack,
  isPortableFileRelPath,
  PORTABLE_FILE_DIRS as CONTRACT_PORTABLE_FILE_DIRS,
} from "../core/contract.mjs";
import {
  renderPluginPack,
  listPluginRelPaths,
  splitFrontmatter,
  isPortableSkillFile,
  PORTABLE_FILE_DIRS as LOCAL_PORTABLE_FILE_DIRS,
} from "../providers/local.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

let _tmpDirs = [];
function fixtureDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "local-provider-test-"));
  _tmpDirs.push(dir);
  return dir;
}
function writeFile(dir, relPath, contents) {
  const path = resolve(dir, relPath);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
  _tmpDirs = [];
});

// --- ground truth, computed independently of the provider under test -------
// Deliberately NOT hardcoded to the plan's illustrative "115 skills" figure:
// this ticket ships the pipeline, not a fixed skill census (a __tests__/ dir
// with no SKILL.md is not a skill; a README.md with no frontmatter is not an
// agent). The count this asserts against is whatever is really on disk right
// now, computed the same principled way the provider computes it — "has a
// SKILL.md" / "has a frontmatter block" — so a provider that silently skips a
// real directory still fails even though the target number moves over time.
function realSkillDirCount(pluginAbsPath) {
  const skillsDir = join(pluginAbsPath, "skills");
  if (!existsSync(skillsDir)) return 0;
  return readdirSync(skillsDir).filter(
    (name) => statSync(join(skillsDir, name)).isDirectory() && existsSync(join(skillsDir, name, "SKILL.md"))
  ).length;
}
function realAgentFileCount(pluginAbsPath) {
  const agentsDir = join(pluginAbsPath, "agents");
  if (!existsSync(agentsDir)) return 0;
  return readdirSync(agentsDir).filter((name) => {
    if (!name.endsWith(".md")) return false;
    const contents = require("node:fs").readFileSync(join(agentsDir, name), "utf8");
    return splitFrontmatter(contents) !== null;
  }).length;
}

describe("renderPluginPack — round-trip against every real plugin", () => {
  const pluginRelPaths = listPluginRelPaths(repoRoot);

  test("discovers exactly 8 plugin directories", () => {
    expect(pluginRelPaths.length).toBe(8);
  });

  for (const pluginRelPath of listPluginRelPaths(repoRoot)) {
    test(`${pluginRelPath}: provider output validates against the contract, and counts match a live filesystem count`, () => {
      const plugin = JSON.parse(
        require("node:fs").readFileSync(resolve(repoRoot, pluginRelPath, ".claude-plugin/plugin.json"), "utf8")
      );
      const pack = renderPluginPack({ repoRoot, pluginRelPath, packId: plugin.name });
      const result = validateRenderedPack(pack);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);

      const pluginAbsPath = resolve(repoRoot, pluginRelPath);
      expect(pack.skills.length).toBe(realSkillDirCount(pluginAbsPath));
      expect(pack.agents.length).toBe(realAgentFileCount(pluginAbsPath));
    });
  }

  test("sum of per-plugin skill counts across all 8 plugins is a positive, live-computed total (not hardcoded)", () => {
    let total = 0;
    for (const pluginRelPath of pluginRelPaths) {
      total += renderPluginPack({ repoRoot, pluginRelPath, packId: pluginRelPath }).skills.length;
    }
    expect(total).toBeGreaterThan(0);
    // Ground truth cross-check, computed the same way, independently of renderPluginPack.
    const independentTotal = pluginRelPaths.reduce(
      (sum, p) => sum + realSkillDirCount(resolve(repoRoot, p)),
      0
    );
    expect(total).toBe(independentTotal);
  });
});

describe("hooks detection — positive/negative control pair", () => {
  test("plugins/dev reports hooks.present === true (positive control)", () => {
    const pack = renderPluginPack({ repoRoot, pluginRelPath: "plugins/dev", packId: "catalyst-dev" });
    expect(pack.hooks.present).toBe(true);
    expect(pack.hooks.entryCount).toBeGreaterThan(0);
  });

  test("every other real plugin reports hooks.present === false (negative control — a detector returning true for everything would pass the positive test alone)", () => {
    const others = listPluginRelPaths(repoRoot).filter((p) => p !== "plugins/dev");
    expect(others.length).toBeGreaterThan(0);
    for (const pluginRelPath of others) {
      const pack = renderPluginPack({ repoRoot, pluginRelPath, packId: pluginRelPath });
      expect(pack.hooks.present).toBe(false);
      expect(pack.hooks.entryCount).toBe(0);
    }
  });
});

describe("unrecognized frontmatter key — fail closed", () => {
  test("a fixture skill with an unknown frontmatter key throws, naming the key and the file", () => {
    const dir = fixtureDir();
    writeFile(
      dir,
      "plugins/x/skills/bogus/SKILL.md",
      `---\nname: bogus\ndescription: a bogus skill\ncategory: nope\n---\n\nbody\n`
    );
    expect(() => renderPluginPack({ repoRoot: dir, pluginRelPath: "plugins/x", packId: "x" })).toThrow(
      /category/
    );
    try {
      renderPluginPack({ repoRoot: dir, pluginRelPath: "plugins/x", packId: "x" });
    } catch (err) {
      expect(String(err.message)).toContain("SKILL.md");
      expect(String(err.message)).toContain("category");
    }
  });
});

describe("gnarly YAML round-trip fixture", () => {
  test("a multi-line folded description and a Bash(...)-style tools value with a colon and an asterisk round-trip exactly", () => {
    const dir = fixtureDir();
    writeFile(
      dir,
      "plugins/x/skills/gnarly/SKILL.md",
      [
        "---",
        "name: gnarly",
        "description:",
        '  "Reference doc: query the replica by direct SQL, or call `linear_read_ticket <ID>`.',
        '  Never shell out for a routine read."',
        "allowed-tools: Bash(ls *), Bash(git log *), mcp__serena__find_symbol",
        "---",
        "",
        "# Gnarly",
        "",
        "Body text.",
        "",
      ].join("\n")
    );
    const pack = renderPluginPack({ repoRoot: dir, pluginRelPath: "plugins/x", packId: "x" });
    const skill = pack.skills[0];
    expect(skill.description).toBe(
      "Reference doc: query the replica by direct SQL, or call `linear_read_ticket <ID>`. Never shell out for a routine read."
    );
    expect(skill.claudeOnly["allowed-tools"]).toBe("Bash(ls *), Bash(git log *), mcp__serena__find_symbol");
    expect(validateRenderedPack(pack).ok).toBe(true);
  });
});

describe("splitFrontmatter", () => {
  test("returns null for a file with no frontmatter block (e.g. a plain README)", () => {
    expect(splitFrontmatter("# Just a README\n\nNo frontmatter here.\n")).toBeNull();
  });
});

describe("files[] is scoped to SKILL.md + scripts/references/assets — real repo regression guard", () => {
  test("plugins/foundry/skills/setup-catalyst's __tests__/ fixture is NOT included in its files[] manifest", () => {
    const pack = renderPluginPack({ repoRoot, pluginRelPath: "plugins/foundry", packId: "catalyst-foundry" });
    const skill = pack.skills.find((s) => s.id === "setup-catalyst");
    expect(skill).toBeDefined();
    expect(skill.files.some((f) => f.relPath.startsWith("__tests__/"))).toBe(false);
    expect(skill.files.some((f) => f.relPath === "SKILL.md")).toBe(true);
  });

  test("a fixture skill with scripts/, references/, assets/, and an unrelated top-level dir only carries the portable four", () => {
    const dir = fixtureDir();
    writeFile(dir, "plugins/x/skills/s/SKILL.md", "---\nname: s\ndescription: d\n---\n\nbody\n");
    writeFile(dir, "plugins/x/skills/s/scripts/run.sh", "echo hi\n");
    writeFile(dir, "plugins/x/skills/s/references/notes.md", "notes\n");
    writeFile(dir, "plugins/x/skills/s/assets/logo.svg", "<svg/>\n");
    writeFile(dir, "plugins/x/skills/s/__tests__/fixture.test.sh", "test\n");
    writeFile(dir, "plugins/x/skills/s/random-notes.txt", "scratch\n");
    const pack = renderPluginPack({ repoRoot: dir, pluginRelPath: "plugins/x", packId: "x" });
    const relPaths = pack.skills[0].files.map((f) => f.relPath).sort();
    expect(relPaths).toEqual(["SKILL.md", "assets/logo.svg", "references/notes.md", "scripts/run.sh"]);
  });

  test("a sidecar (agents/portability.yaml) sitting beside SKILL.md is NOT copied into files[] — real repo fixture", () => {
    const pack = renderPluginPack({ repoRoot, pluginRelPath: "plugins/dev", packId: "catalyst-dev" });
    const skill = pack.skills.find((s) => s.id === "linearis");
    expect(skill).toBeDefined();
    expect(skill.files.some((f) => f.relPath.startsWith("agents/"))).toBe(false);
  });

  test("the same exclusion, via a synthetic fixture with scripts/ present too", () => {
    const dir = fixtureDir();
    writeFile(dir, "plugins/x/skills/s/SKILL.md", "---\nname: s\ndescription: d\n---\n\nbody\n");
    writeFile(dir, "plugins/x/skills/s/agents/portability.yaml", 'effects: []\ninvocation: auto\nexposure: ["catalog"]\n');
    writeFile(dir, "plugins/x/skills/s/scripts/run.sh", "echo hi\n");
    const pack = renderPluginPack({ repoRoot: dir, pluginRelPath: "plugins/x", packId: "x" });
    const relPaths = pack.skills[0].files.map((f) => f.relPath).sort();
    expect(relPaths).toEqual(["SKILL.md", "scripts/run.sh"]);
    // The sidecar was read for classification, not silently dropped:
    expect(pack.skills[0].neutral).toEqual({ effects: [], invocation: "auto", exposure: ["catalog"] });
  });

  test("mutation control: isPortableSkillFile with 'agents' injected into portableDirs treats the sidecar as portable — proving the real exclusion is membership-based, not incidental", () => {
    expect(isPortableSkillFile("agents/portability.yaml")).toBe(false);
    const widened = new Set([...LOCAL_PORTABLE_FILE_DIRS, "agents"]);
    expect(isPortableSkillFile("agents/portability.yaml", widened)).toBe(true);
  });

  test("mutation control: isPortableFileRelPath with 'agents' injected into portableDirs treats the sidecar as a valid portable path", () => {
    expect(isPortableFileRelPath("agents/portability.yaml")).toBe(false);
    const widened = new Set([...CONTRACT_PORTABLE_FILE_DIRS, "agents"]);
    expect(isPortableFileRelPath("agents/portability.yaml", widened)).toBe(true);
  });
});

describe("relocation identity — the provider's neutral output equals the frozen literals transcribed from pack.json before this ticket deleted it", () => {
  // These three objects are HAND-TRANSCRIBED from the plan's "What is already
  // true" table, never derived by reading pack.json (deleted) or by running
  // the code under test — an expected value produced by the code under test
  // can only ever confirm itself.
  const EXPECTED = {
    "plugins/dev": { packId: "catalyst-dev", skillId: "linearis", neutral: { effects: [], invocation: "auto", exposure: ["catalog"] } },
    "plugins/foundry": {
      packId: "catalyst-foundry",
      skillId: "setup-catalyst",
      neutral: { effects: ["file-read", "file-write", "shell-exec"], invocation: "explicit", exposure: ["catalog"] },
    },
    "plugins/meta": {
      packId: "catalyst-meta",
      skillId: "validate-frontmatter",
      // invocation is "explicit" here (not the pre-CTL-1461 "auto") — the
      // Phase 2 invocation-parity fix landed together with the sidecar so the
      // tree is never in a state that violates the safety gate.
      neutral: { effects: ["file-read", "file-write"], invocation: "explicit", exposure: ["catalog"] },
    },
  };

  for (const [pluginRelPath, { packId, skillId, neutral }] of Object.entries(EXPECTED)) {
    test(`${pluginRelPath}/${skillId}: neutral deep-equals the transcribed literal`, () => {
      const pack = renderPluginPack({ repoRoot, pluginRelPath, packId });
      const skill = pack.skills.find((s) => s.id === skillId);
      expect(skill).toBeDefined();
      expect(skill.neutral).toEqual(neutral);
    });
  }
});

describe("neutral classification — sidecar absence, malformed YAML, and unknown key", () => {
  test("a skill with no sidecar yields neutral: null (legal — it simply cannot reach a non-Claude target)", () => {
    const dir = fixtureDir();
    writeFile(dir, "plugins/x/skills/s/SKILL.md", "---\nname: s\ndescription: d\n---\n\nbody\n");
    const pack = renderPluginPack({ repoRoot: dir, pluginRelPath: "plugins/x", packId: "x" });
    expect(pack.skills[0].neutral).toBeNull();
    expect(validateRenderedPack(pack).ok).toBe(true);
  });

  test("a sidecar with malformed YAML is a hard error naming the sidecar file", () => {
    const dir = fixtureDir();
    writeFile(dir, "plugins/x/skills/s/SKILL.md", "---\nname: s\ndescription: d\n---\n\nbody\n");
    writeFile(dir, "plugins/x/skills/s/agents/portability.yaml", "effects: [\nunterminated");
    expect(() => renderPluginPack({ repoRoot: dir, pluginRelPath: "plugins/x", packId: "x" })).toThrow(
      /portability\.yaml/
    );
  });

  test("a sidecar with an unknown key is a hard error naming the key", () => {
    const dir = fixtureDir();
    writeFile(dir, "plugins/x/skills/s/SKILL.md", "---\nname: s\ndescription: d\n---\n\nbody\n");
    writeFile(
      dir,
      "plugins/x/skills/s/agents/portability.yaml",
      'effects: []\ninvocation: auto\nexposure: ["catalog"]\nbogus: true\n'
    );
    expect(() => renderPluginPack({ repoRoot: dir, pluginRelPath: "plugins/x", packId: "x" })).toThrow(/bogus/);
  });
});
