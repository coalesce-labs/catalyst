// agents-skills-emitter.test.mjs — CTL-1463 Phase 4.
//
// Run: bun test scripts/packaging/__tests__/agents-skills-emitter.test.mjs

import { describe, test, expect } from "bun:test";

import { flatSkillName, buildSkillMd, planAgentsSkillsBundle } from "../emitters/agents-skills.mjs";
import { splitFrontmatter } from "../providers/local-provisional.mjs";

function pack(packId, skills) {
  return {
    contractVersion: 1,
    packId,
    sourceRoot: `plugins/${packId}`,
    skills,
    agents: [],
    hooks: { present: false, entryCount: 0 },
    mcpServers: null,
  };
}

function classifiedSkill(id, overrides = {}) {
  return {
    id,
    name: id,
    description: 'A skill with a colon: and "quotes" inside.',
    body: "# Title\n\nBody text.\n",
    files: [
      { relPath: "SKILL.md", bytesRef: "sha256:aaa", content: Buffer.from("original SKILL.md").toString("base64") },
      { relPath: "scripts/helper.sh", bytesRef: "sha256:bbb", content: Buffer.from("#!/bin/bash\necho hi\n").toString("base64") },
    ],
    neutral: { effects: [], invocation: "auto" },
    claudeOnly: { "allowed-tools": "Read", model: "haiku" },
    ...overrides,
  };
}

describe("flatSkillName", () => {
  test("is pack-qualified", () => {
    expect(flatSkillName("catalyst-dev", "linearis")).toBe("catalyst-dev-linearis");
  });
});

describe("buildSkillMd — exactly name + description frontmatter, no Claude-only key", () => {
  test("the emitted frontmatter has exactly the key set {name, description}", () => {
    const skill = classifiedSkill("linearis");
    const text = buildSkillMd(skill);
    const split = splitFrontmatter(text);
    expect(split).not.toBeNull();
    const parsed = Bun.YAML.parse(split.yamlText);
    expect(Object.keys(parsed).sort()).toEqual(["description", "name"]);
  });

  test("gnarly description (colon + embedded double quotes) round-trips through real YAML", () => {
    const skill = classifiedSkill("gnarly");
    const text = buildSkillMd(skill);
    const split = splitFrontmatter(text);
    const parsed = Bun.YAML.parse(split.yamlText);
    expect(parsed.description).toBe(skill.description);
  });

  test("the body is preserved verbatim", () => {
    const skill = classifiedSkill("s");
    const text = buildSkillMd(skill);
    const split = splitFrontmatter(text);
    expect(split.body).toBe(skill.body);
  });
});

describe("planAgentsSkillsBundle", () => {
  test("only neutral-classified skills are planned; unclassified skills are silently absent here (already omitted upstream by the loss classifier)", () => {
    const entries = [
      { packId: "catalyst-dev", pack: pack("catalyst-dev", [classifiedSkill("linearis"), { ...classifiedSkill("commit"), neutral: null }]) },
    ];
    const { files, emittedFlatNames } = planAgentsSkillsBundle(entries);
    expect(emittedFlatNames).toEqual(["catalyst-dev-linearis"]);
    expect(files.some((f) => f.relPath.startsWith("catalyst-dev-commit/"))).toBe(false);
  });

  test("SKILL.md is regenerated (not copied verbatim); scripts/ files ARE copied byte-for-byte", () => {
    const entries = [{ packId: "catalyst-dev", pack: pack("catalyst-dev", [classifiedSkill("linearis")]) }];
    const { files } = planAgentsSkillsBundle(entries);

    const skillMd = files.find((f) => f.relPath === "catalyst-dev-linearis/SKILL.md");
    expect(skillMd.text).not.toContain("original SKILL.md"); // NOT the verbatim source bytes

    const script = files.find((f) => f.relPath === "catalyst-dev-linearis/scripts/helper.sh");
    expect(script).toBeDefined();
    expect(Buffer.from(script.base64, "base64").toString("utf8")).toBe("#!/bin/bash\necho hi\n");
  });

  test("every emitted skill carries a .generated-by-catalyst-packaging marker", () => {
    const entries = [{ packId: "catalyst-dev", pack: pack("catalyst-dev", [classifiedSkill("linearis")]) }];
    const { files } = planAgentsSkillsBundle(entries);
    const marker = files.find((f) => f.relPath === "catalyst-dev-linearis/.generated-by-catalyst-packaging");
    expect(marker).toBeDefined();
    expect(JSON.parse(marker.text).pack).toBe("catalyst-dev");
  });

  test("a flat-name collision between two packs FAILS the build, naming both sources", () => {
    // Two different (packId, skillId) pairs whose hyphen-joined flat name
    // collides: "a"/"b-c" and "a-b"/"c" both flatten to "a-b-c".
    const forced = [
      { packId: "a", pack: pack("a", [classifiedSkill("b-c")]) },
      { packId: "a-b", pack: pack("a-b", [classifiedSkill("c")]) },
    ];
    expect(() => planAgentsSkillsBundle(forced)).toThrow(/collision/);
    try {
      planAgentsSkillsBundle(forced);
    } catch (err) {
      expect(String(err.message)).toContain("a/b-c");
      expect(String(err.message)).toContain("a-b/c");
    }
  });
});
