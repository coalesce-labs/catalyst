// agentskills-spec.test.mjs — CTL-2215 Phase 1.
//
// One fixture per rule the grader enforces, in BOTH directions (a violating
// fixture and a clean fixture in the same file) — a single over-broad
// fixture proving the suite green for the wrong reason is exactly the
// mutation-control trap AGENTS.md names.
//
// Run: bun test scripts/packaging/__tests__/agentskills-spec.test.mjs

import { describe, test, expect } from "bun:test";

import { SPEC_FRONTMATTER_KEYS, checkAgentsSkillsConformance } from "../core/agentskills-spec.mjs";

function skillMd({ flatName = "pack-skill", frontmatter, body = "\n# Title\n\nBody text.\n" }) {
  return { flatName, relPath: `${flatName}/SKILL.md`, text: `---\n${frontmatter}---${body}` };
}

function cleanSkillMd(flatName, overrides = {}) {
  return skillMd({ flatName, frontmatter: `name: ${flatName}\ndescription: "a clean, valid description"\n`, ...overrides });
}

describe("SPEC_FRONTMATTER_KEYS", () => {
  test("matches the verified skills@1.5.23 parseSkillMd contract", () => {
    expect(SPEC_FRONTMATTER_KEYS.required).toEqual(["name", "description"]);
    expect(SPEC_FRONTMATTER_KEYS.optional).toEqual(["license", "metadata"]);
  });
});

describe("empty emit set", () => {
  test("→ inconclusive, never ok", () => {
    const result = checkAgentsSkillsConformance([]);
    expect(result.verdict).toBe("inconclusive");
    expect(result.checkedCount).toBe(0);
    expect(result.reason).toMatch(/empty emit set/);
  });

  test("non-SKILL.md files alone (e.g. only agents/openai.yaml) also count as an empty emit set", () => {
    const result = checkAgentsSkillsConformance([{ flatName: "a", relPath: "a/agents/openai.yaml", text: "policy: {}\n" }]);
    expect(result.verdict).toBe("inconclusive");
  });
});

describe("name — missing, empty, or non-string", () => {
  test("missing name → violation naming the skill and the field", () => {
    const result = checkAgentsSkillsConformance([skillMd({ flatName: "pack-x", frontmatter: `description: "d"\n` })]);
    expect(result.verdict).toBe("violations");
    expect(result.violations).toContainEqual(expect.objectContaining({ source: "pack-x", field: "name" }));
  });

  test("empty-string name → violation", () => {
    const result = checkAgentsSkillsConformance([skillMd({ flatName: "pack-x", frontmatter: `name: ""\ndescription: "d"\n` })]);
    expect(result.violations).toContainEqual(expect.objectContaining({ source: "pack-x", field: "name" }));
  });

  test("a clean fixture with a valid name produces no name violation", () => {
    const result = checkAgentsSkillsConformance([cleanSkillMd("pack-x")]);
    expect(result.violations.filter((v) => v.field === "name")).toEqual([]);
  });
});

describe("description — missing, empty, or non-string", () => {
  test("missing description → violation naming the skill and the field", () => {
    const result = checkAgentsSkillsConformance([skillMd({ flatName: "pack-y", frontmatter: `name: pack-y\n` })]);
    expect(result.verdict).toBe("violations");
    expect(result.violations).toContainEqual(expect.objectContaining({ source: "pack-y", field: "description" }));
  });

  test("a clean fixture with a valid description produces no description violation", () => {
    const result = checkAgentsSkillsConformance([cleanSkillMd("pack-y")]);
    expect(result.violations.filter((v) => v.field === "description")).toEqual([]);
  });
});

describe("duplicate name across two emitted skills", () => {
  test("→ violation naming both sources", () => {
    const result = checkAgentsSkillsConformance([
      skillMd({ flatName: "pack-a-shared", frontmatter: `name: shared\ndescription: "one"\n` }),
      skillMd({ flatName: "pack-b-shared", frontmatter: `name: shared\ndescription: "two"\n` }),
    ]);
    expect(result.verdict).toBe("violations");
    const dup = result.violations.find((v) => v.field === "name" && v.message.includes("duplicate"));
    expect(dup).toBeDefined();
    expect(dup.source).toContain("pack-a-shared");
    expect(dup.source).toContain("pack-b-shared");
  });

  test("two clean fixtures with distinct names produce no duplicate-name violation", () => {
    const result = checkAgentsSkillsConformance([cleanSkillMd("pack-a"), cleanSkillMd("pack-b")]);
    expect(result.verdict).toBe("ok");
  });
});

describe("frontmatter key outside {name, description, license, metadata}", () => {
  test("an unknown key → violation", () => {
    const result = checkAgentsSkillsConformance([
      skillMd({ flatName: "pack-z", frontmatter: `name: pack-z\ndescription: "d"\nmodel: haiku\n` }),
    ]);
    expect(result.verdict).toBe("violations");
    expect(result.violations).toContainEqual(expect.objectContaining({ source: "pack-z", field: "model" }));
  });

  test("license and metadata (the optional keys) are accepted with no violation", () => {
    const result = checkAgentsSkillsConformance([
      skillMd({ flatName: "pack-z", frontmatter: `name: pack-z\ndescription: "d"\nlicense: MIT\nmetadata:\n  foo: bar\n` }),
    ]);
    expect(result.verdict).toBe("ok");
  });
});

describe("metadata.internal: true", () => {
  test("present anywhere in the emitted set → violation", () => {
    const result = checkAgentsSkillsConformance([
      skillMd({ flatName: "pack-w", frontmatter: `name: pack-w\ndescription: "d"\nmetadata:\n  internal: true\n` }),
    ]);
    expect(result.verdict).toBe("violations");
    expect(result.violations).toContainEqual(expect.objectContaining({ source: "pack-w", field: "metadata.internal" }));
  });

  test("metadata.internal: false is not a violation (only true is guarded)", () => {
    const result = checkAgentsSkillsConformance([
      skillMd({ flatName: "pack-w", frontmatter: `name: pack-w\ndescription: "d"\nmetadata:\n  internal: false\n` }),
    ]);
    expect(result.verdict).toBe("ok");
  });
});

describe("unparseable YAML frontmatter", () => {
  test("→ violation, not a throw", () => {
    const broken = { flatName: "pack-v", relPath: "pack-v/SKILL.md", text: "---\nname: [unterminated\n---\nbody\n" };
    expect(() => checkAgentsSkillsConformance([broken])).not.toThrow();
    const result = checkAgentsSkillsConformance([broken]);
    expect(result.verdict).toBe("violations");
    expect(result.violations).toContainEqual(expect.objectContaining({ source: "pack-v", field: "frontmatter" }));
  });

  test("no frontmatter block at all → violation naming the frontmatter field", () => {
    const noFrontmatter = { flatName: "pack-u", relPath: "pack-u/SKILL.md", text: "just a body, no frontmatter\n" };
    const result = checkAgentsSkillsConformance([noFrontmatter]);
    expect(result.verdict).toBe("violations");
    expect(result.violations).toContainEqual(expect.objectContaining({ source: "pack-u", field: "frontmatter" }));
  });
});

describe("positive control — a fixture violating every rule at once, and one satisfying all of them", () => {
  test("the all-violations fixture produces a non-empty violation list covering every rule", () => {
    const result = checkAgentsSkillsConformance([
      skillMd({ flatName: "pack-bad", frontmatter: `description: ""\nmodel: haiku\nmetadata:\n  internal: true\n` }),
    ]);
    expect(result.verdict).toBe("violations");
    const fields = result.violations.map((v) => v.field).sort();
    expect(fields).toEqual(["description", "metadata.internal", "model", "name"]);
  });

  test("the fully-clean fixture produces an empty violation list", () => {
    const result = checkAgentsSkillsConformance([cleanSkillMd("pack-good")]);
    expect(result.verdict).toBe("ok");
    expect(result.violations).toEqual([]);
    expect(result.checkedCount).toBe(1);
  });
});
