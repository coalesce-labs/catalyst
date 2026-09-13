// skill-self-containment.test.mjs — CTL-2306 Phase 2.
//
// Run: bun test scripts/packaging/__tests__/skill-self-containment.test.mjs
//
// A catalyst-dev skill must run from its own directory on any harness: Claude
// Code (plugin or skills-CLI install), Codex, Cursor, OpenCode, and the cloud
// runner's path shim. Before Phase 2 the skills reached their helpers through
// ${CLAUDE_PLUGIN_ROOT}, which only Claude Code's plugin rail sets — on Codex and
// OpenCode every such step silently skipped or failed.
//
// SELF_CONTAINED grows one skill cluster per PR; the last cluster replaces it with
// every skill. The runner's phase skills (catalyst-cloud's derived required set)
// come first because CTC-2171 re-bakes the runner image on them.
//
// Positive controls: fixture skills that violate each rule must be reported, so a
// clean result on the real tree is an absence and not a checker that stopped looking.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkSkillSelfContainment } from "../core/skill-self-containment.mjs";
import { planPluginVendoring } from "../cli.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const skillsRoot = join(repoRoot, "plugins/dev/skills");

// Cluster 1 (the runner's phase skills and the plan skills that share their subagents).
export const SELF_CONTAINED = [
  "create-plan",
  "implement-plan",
  "iterate-plan",
  "remediate-plan",
  "research-codebase",
  "scan-reward-hacking",
  "validate-plan",
  "validate-type-safety",
];

// catalyst-cloud's derived required set (scripts/skills-derived-skills.ts) minus
// describe-pr, which lands with the PR/merge cluster.
const RUNNER_PHASE_SKILLS = [
  "research-codebase",
  "create-plan",
  "implement-plan",
  "validate-plan",
  "remediate-plan",
  "validate-type-safety",
  "scan-reward-hacking",
];

const scratch = mkdtempSync(join(tmpdir(), "ctl-2306-self-containment-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function fixtureSkill(name, files) {
  const dir = join(scratch, name);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const PREAMBLE = "If you cannot, stop and report `skill_dir_unresolved`.";

describe("the checker sees each violation it exists to catch (positive controls)", () => {
  test("a plugin-root reference in SKILL.md", () => {
    const dir = fixtureSkill("uses-plugin-root", {
      "SKILL.md": '---\nname: x\n---\n```bash\n"${CLAUDE_PLUGIN_ROOT}/scripts/check.sh"\n```\n',
    });
    expect(checkSkillSelfContainment(dir).violations.map((v) => v.rule)).toContain("plugin-root-reference");
  });

  test("a skill-dir path that does not exist", () => {
    const dir = fixtureSkill("missing-script", {
      "SKILL.md": `---\nname: x\n---\n${PREAMBLE}\n\`\`\`bash\n"\${CLAUDE_SKILL_DIR}/scripts/absent.sh"\n\`\`\`\n`,
    });
    const v = checkSkillSelfContainment(dir).violations;
    expect(v.map((x) => x.rule)).toContain("skill-dir-path-missing");
    expect(v.find((x) => x.rule === "skill-dir-path-missing").detail).toContain("scripts/absent.sh");
  });

  test("a skill-dir command with no harness preamble", () => {
    const dir = fixtureSkill("no-preamble", {
      "SKILL.md": '---\nname: x\n---\n```bash\n"${CLAUDE_SKILL_DIR}/scripts/ok.sh"\n```\n',
      "scripts/ok.sh": "#!/usr/bin/env bash\n",
    });
    expect(checkSkillSelfContainment(dir).violations.map((v) => v.rule)).toContain("missing-skill-dir-preamble");
  });

  test("a script that sources a sibling the skill does not carry", () => {
    const dir = fixtureSkill("broken-sibling", {
      "SKILL.md": `---\nname: x\n---\n${PREAMBLE}\n\`\`\`bash\n"\${CLAUDE_SKILL_DIR}/scripts/a.sh"\n\`\`\`\n`,
      "scripts/a.sh": '#!/usr/bin/env bash\nSCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nsource "${SCRIPT_DIR}/lib/b.sh"\n',
    });
    const v = checkSkillSelfContainment(dir).violations;
    expect(v.map((x) => x.rule)).toContain("script-sibling-missing");
  });

  test("an optional reference marked in the script is not a violation", () => {
    const dir = fixtureSkill("optional-sibling", {
      "SKILL.md": "---\nname: x\n---\nno commands\n",
      "scripts/a.sh": '#!/usr/bin/env bash\nJSON="${LIB_DIR}/../../.claude-plugin/plugin.json" # self-containment: optional\n',
    });
    expect(checkSkillSelfContainment(dir).violations).toEqual([]);
  });

  test("a well-formed skill is clean, and the checker says what it read", () => {
    const dir = fixtureSkill("clean", {
      "SKILL.md": `---\nname: x\n---\n${PREAMBLE}\n\`\`\`bash\n"\${CLAUDE_SKILL_DIR}/scripts/a.sh"\n\`\`\`\n`,
      "scripts/a.sh": '#!/usr/bin/env bash\nSCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nsource "${SCRIPT_DIR}/lib/b.sh"\n',
      "scripts/lib/b.sh": "#!/usr/bin/env bash\n",
    });
    const result = checkSkillSelfContainment(dir);
    expect(result.violations).toEqual([]);
    expect(result.filesScanned).toBe(3);
  });
});

describe("cluster 1 of catalyst-dev is self-contained (CTL-2306)", () => {
  test("skill-dir-isolation.test.sh runs exactly the same skills", () => {
    const shell = readFileSync(join(repoRoot, "scripts/packaging/__tests__/skill-dir-isolation.test.sh"), "utf8");
    const match = shell.match(/^SKILLS="([^"]*)"$/m);
    expect(match).not.toBeNull();
    expect(match[1].split(" ").sort()).toEqual([...SELF_CONTAINED].sort());
  });

  test("the runner's phase skills are all in the self-contained set", () => {
    expect(RUNNER_PHASE_SKILLS.filter((s) => !SELF_CONTAINED.includes(s))).toEqual([]);
  });

  for (const skill of SELF_CONTAINED) {
    test(`${skill}: no plugin-root reference, every skill-dir path exists, every script sibling resolves`, () => {
      const result = checkSkillSelfContainment(join(skillsRoot, skill));
      expect(result.filesScanned).toBeGreaterThan(0);
      expect(result.violations).toEqual([]);
    });
  }

  test("every vendored copy is byte-identical to its one source (run `bun scripts/packaging/cli.mjs vendor --write`)", () => {
    const plan = planPluginVendoring(repoRoot);
    expect(plan.errors).toEqual([]);
    expect(plan.drift).toEqual([]);
    expect(plan.skillCount).toBeGreaterThan(0);
  });
});
