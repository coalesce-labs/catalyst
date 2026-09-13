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
// Positive controls: fixture skills that violate each rule must be reported, so a
// clean result on the real tree is an absence and not a checker that stopped looking.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkSkillSelfContainment } from "../core/skill-self-containment.mjs";
import { planPluginVendoring } from "../cli.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const skillsRoot = join(repoRoot, "plugins/dev/skills");

// SELF_CONTAINED is every catalyst-dev skill. It grew one cluster per PR (#4133 to #4138) and
// cluster 4d, create-worktree, completed it; a skill added later is checked from its first commit.
export const SELF_CONTAINED = readdirSync(skillsRoot)
  .filter((name) => existsSync(join(skillsRoot, name, "SKILL.md")))
  .sort();

// catalyst-cloud's derived required set (scripts/skills-derived-skills.ts): every skill the
// runner dispatches, by argv or in-session. CTC-2171 re-bakes the runner image on these.
const RUNNER_PHASE_SKILLS = [
  "research-codebase",
  "create-plan",
  "implement-plan",
  "validate-plan",
  "describe-pr",
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

  // A repo-relative path into another part of the plugin is the same defect as a plugin-root
  // path: it resolves only with cwd inside the catalyst checkout (remediate-plan pointed the
  // runner at plugins/dev/skills/validate-plan/SKILL.md, which no tenant repo has).
  test("a repo-relative path into the plugin's skills, references, templates or agents", () => {
    const dir = fixtureSkill("repo-relative-paths", {
      "SKILL.md": "---\nname: x\n---\nRead `plugins/dev/skills/ask/references/threading.md` first.\n",
      "references/more.md": "See plugins/dev/references/review-thread-resolution.md and plugins/dev/templates/x.json.\n",
    });
    expect(checkSkillSelfContainment(dir).violations.filter((v) => v.rule === "plugin-root-reference").length).toBe(2);
  });

  // Codex review on #4136 (P1): concierge followed `steward/references/cloud-detection.md`, whose
  // commands source helpers from ${CLAUDE_SKILL_DIR} — concierge's directory, not steward's. A
  // pointer into a sibling skill's directory breaks the same way a plugin-root path does.
  test("a path into a sibling skill's references, scripts or assets", () => {
    const parent = join(scratch, "siblings");
    mkdirSync(join(parent, "steward", "references"), { recursive: true });
    writeFileSync(join(parent, "steward", "SKILL.md"), "---\nname: steward\n---\n");
    writeFileSync(join(parent, "steward", "references", "cloud-detection.md"), "x\n");
    mkdirSync(join(parent, "concierge"), { recursive: true });
    writeFileSync(
      join(parent, "concierge", "SKILL.md"),
      "---\nname: concierge\n---\nGate reads on `steward/references/cloud-detection.md`. The `ask` skill decides asks.\n"
    );
    const v = checkSkillSelfContainment(join(parent, "concierge")).violations;
    expect(v.map((x) => [x.rule, x.detail])).toEqual([["sibling-skill-path", "steward/references/cloud-detection.md"]]);
  });

  // Some instructions are genuinely for catalyst maintainers working in a catalyst checkout
  // (regenerating the reference-class corpus, running this repo's own tests). They say so on
  // the line, and only those lines may name a repo-relative plugin path.
  test("a line marked `(catalyst-checkout only)` may name a repo-relative plugin path; an unmarked line may not", () => {
    const dir = fixtureSkill("maintainer-line", {
      "SKILL.md": "---\nname: x\n---\n```bash\nplugins/dev/scripts/estimate/refresh-corpus.sh   # (catalyst-checkout only)\nplugins/dev/scripts/compound-log.sh write X\n```\n",
    });
    const v = checkSkillSelfContainment(dir).violations;
    expect(v.map((x) => [x.rule, x.line])).toEqual([["plugin-root-reference", 6]]);
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

  test("a sibling path that climbs out of the skill is a violation even when the file exists there", () => {
    // create-worktree.sh reached the thoughts-init script as ${SCRIPT_DIR}/../../../scripts/…, which
    // resolves only in the catalyst checkout layout.
    const dir = fixtureSkill("climbs-out", {
      "SKILL.md": "---\nname: x\n---\nno commands\n",
      "scripts/a.sh": '#!/usr/bin/env bash\nSCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nbash "${SCRIPT_DIR}/../../outside-scripts/init.sh"\n',
    });
    mkdirSync(join(dir, "..", "outside-scripts"), { recursive: true });
    writeFileSync(join(dir, "..", "outside-scripts", "init.sh"), "#!/usr/bin/env bash\n");
    const v = checkSkillSelfContainment(dir).violations;
    expect(v).toEqual([expect.objectContaining({ rule: "script-sibling-missing", detail: "../../outside-scripts/init.sh" })]);
  });

  test("an optional reference marked in the script is not a violation", () => {
    const dir = fixtureSkill("optional-sibling", {
      "SKILL.md": "---\nname: x\n---\nno commands\n",
      "scripts/a.sh": '#!/usr/bin/env bash\nLIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\nJSON="${LIB_DIR}/../../.claude-plugin/plugin.json" # self-containment: optional\n',
    });
    expect(checkSkillSelfContainment(dir).violations).toEqual([]);
  });

  test("a sibling reached through an inline dirname of a self-file variable is checked too", () => {
    const dir = fixtureSkill("inline-dirname", {
      "SKILL.md": "---\nname: x\n---\nno commands\n",
      "scripts/a.sh":
        '#!/usr/bin/env bash\nsource_path="${BASH_SOURCE[0]:-$0}"\ncontract="$(cd "$(dirname "$source_path")" 2>/dev/null && pwd)/contract.sh"\n',
    });
    expect(checkSkillSelfContainment(dir).violations.map((v) => v.detail)).toEqual(["contract.sh"]);
  });

  test("a path under the repo root, $HOME or the cwd is not the skill's concern", () => {
    const dir = fixtureSkill("external-paths", {
      "SKILL.md": "---\nname: x\n---\nno commands\n",
      "scripts/a.sh":
        '#!/usr/bin/env bash\nREPO_ROOT="$(git rev-parse --show-toplevel)"\ncfg="${REPO_ROOT}/.catalyst/config.json"\nhere="$(pwd)/.catalyst/config.json"\n',
    });
    expect(checkSkillSelfContainment(dir).violations).toEqual([]);
  });

  test("a JS module importing a relative module the skill does not carry", () => {
    const dir = fixtureSkill("broken-import", {
      "SKILL.md": "---\nname: x\n---\nno commands\n",
      "scripts/a.mjs":
        'import { x } from "./lib/present.mjs";\nimport { y } from "../scripts/lib/absent.mjs";\nconst helper = new URL("./lib/gone.sh", import.meta.url).pathname;\n',
      "scripts/lib/present.mjs": "export const x = 1;\n",
    });
    expect(checkSkillSelfContainment(dir).violations.map((v) => v.detail).sort()).toEqual(["../scripts/lib/absent.mjs", "./lib/gone.sh"]);
  });

  // Codex review on #4135: a side-effect import and a CommonJS require are dependencies too.
  test("a bare side-effect import and a CommonJS require of a missing relative module", () => {
    const dir = fixtureSkill("bare-and-require", {
      "SKILL.md": "---\nname: x\n---\nno commands\n",
      "scripts/a.mjs": 'import "./polyfill-missing.mjs";\nimport "./present.mjs";\n',
      "scripts/b.cjs": 'const x = require("./gone.cjs");\nconst y = require( "./present.cjs" );\nconst fs = require("node:fs");\n',
      "scripts/present.mjs": "export {};\n",
      "scripts/present.cjs": "module.exports = {};\n",
    });
    expect(checkSkillSelfContainment(dir).violations.map((v) => v.detail).sort()).toEqual(["./gone.cjs", "./polyfill-missing.mjs"]);
  });

  // Found by skill-dir-isolation.test.sh, not by this checker: board-vocabulary.mjs reads a JSON
  // file located from its own URL. The static rule now sees that shape too.
  test("a JS module reading a file joined onto its own directory", () => {
    const dir = fixtureSkill("dirname-join", {
      "SKILL.md": "---\nname: x\n---\nno commands\n",
      "scripts/a.mjs":
        'import { dirname, join } from "node:path";\nimport { fileURLToPath } from "node:url";\nexport const P = join(dirname(fileURLToPath(import.meta.url)), "contract.default.json");\nexport const Q = join(import.meta.dirname, "present.json");\n',
      "scripts/present.json": "{}\n",
    });
    expect(checkSkillSelfContainment(dir).violations.map((v) => v.detail)).toEqual(["contract.default.json"]);
  });

  test("a type-only import inside a JSDoc comment is not a runtime dependency", () => {
    const dir = fixtureSkill("jsdoc-import", {
      "SKILL.md": "---\nname: x\n---\nno commands\n",
      "scripts/a.mjs": '/**\n * @param {import("./types.d.mts").Spec} spec\n */\nexport function f(spec) { return spec; }\n// import("./also-not-real.mjs")\n',
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

describe("every catalyst-dev skill is self-contained (CTL-2306)", () => {
  test("the skill set is read from the tree, not an empty directory listing", () => {
    expect(SELF_CONTAINED.length).toBeGreaterThanOrEqual(31);
    expect(SELF_CONTAINED).toContain("create-worktree");
  });

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
