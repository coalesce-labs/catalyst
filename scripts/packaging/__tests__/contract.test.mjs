// contract.test.mjs — CTL-1463 Phase 1.
//
// Run: bun test scripts/packaging/__tests__/contract.test.mjs
//
// Every fixture in fixtures/packs/ is exercised here (a fixture-coverage
// assertion at the bottom fails if one is added and never referenced — an
// unused fixture is decoration, not a test).

import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateRenderedPack, SUPPORTED_CONTRACT_VERSION } from "../core/contract.mjs";

const fixturesDir = fileURLToPath(new URL("../fixtures/packs/", import.meta.url));
const usedFixtures = new Set();

function loadFixture(name) {
  usedFixtures.add(name);
  return JSON.parse(readFileSync(`${fixturesDir}${name}`, "utf8"));
}

describe("SUPPORTED_CONTRACT_VERSION", () => {
  test("is 1", () => {
    expect(SUPPORTED_CONTRACT_VERSION).toBe(1);
  });
});

describe("validateRenderedPack — positive controls", () => {
  test("a valid minimal fixture passes with zero errors", () => {
    const result = validateRenderedPack(loadFixture("valid-minimal.json"));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a valid fixture with a fully-classified skill passes", () => {
    const result = validateRenderedPack(loadFixture("valid-classified-skill.json"));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a valid fixture with hooks present passes", () => {
    const result = validateRenderedPack(loadFixture("valid-with-hooks.json"));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test("a valid fixture with an agent passes", () => {
    const result = validateRenderedPack(loadFixture("valid-with-agents.json"));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

describe("validateRenderedPack — each rule rejects its fixture", () => {
  test("missing contractVersion is rejected", () => {
    const result = validateRenderedPack(loadFixture("invalid-missing-contract-version.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("contractVersion is missing"))).toBe(true);
  });

  test("an unrecognized contractVersion is rejected naming BOTH versions", () => {
    const result = validateRenderedPack(loadFixture("invalid-bad-contract-version.json"));
    expect(result.ok).toBe(false);
    const msg = result.errors.find((e) => e.includes("not supported"));
    expect(msg).toBeDefined();
    expect(msg).toContain("2"); // received
    expect(msg).toContain("1"); // supported
  });

  test("contractVersion widened to >= 1 would let this pass — mutation control", () => {
    // Simulates the mutation "widen the check to `>= 1`" named in the plan's
    // mutation-control table: a pack claiming version 2 must NOT validate
    // under the real (strict-equality) rule.
    const pack = loadFixture("invalid-bad-contract-version.json");
    expect(pack.contractVersion >= 1).toBe(true); // the mutated rule would accept it
    expect(validateRenderedPack(pack).ok).toBe(false); // the real rule must not
  });

  test("an unknown top-level key is rejected naming the key", () => {
    const result = validateRenderedPack(loadFixture("invalid-unknown-top-level-key.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("bogusTopLevelField"))).toBe(true);
  });

  test("a half-declared neutral classification (effects present, invocation missing) is rejected", () => {
    const result = validateRenderedPack(loadFixture("invalid-skill-half-classified.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("invocation"))).toBe(true);
  });

  test("an unknown skill key is rejected naming the key", () => {
    const result = validateRenderedPack(loadFixture("invalid-skill-unknown-key.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("bogusSkillField"))).toBe(true);
  });

  test("a non-object pack is rejected", () => {
    const result = validateRenderedPack(loadFixture("invalid-not-object.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("validateRenderedPack — both directions of the neutral-classification gate", () => {
  test("a skill with neutral: null is legal (cannot reach a non-Claude target, but is not an error)", () => {
    const pack = loadFixture("valid-classified-skill.json");
    pack.skills[0].neutral = null;
    const result = validateRenderedPack(pack);
    expect(result.ok).toBe(true);
  });

  test("the same skill with a FULL neutral declaration also passes (both directions)", () => {
    const pack = loadFixture("valid-classified-skill.json");
    expect(pack.skills[0].neutral).not.toBeNull();
    const result = validateRenderedPack(pack);
    expect(result.ok).toBe(true);
  });

  test("the same skill with effects deleted from neutral fails", () => {
    const pack = loadFixture("valid-classified-skill.json");
    delete pack.skills[0].neutral.effects;
    const result = validateRenderedPack(pack);
    expect(result.ok).toBe(false);
  });
});

describe("validateRenderedPack — portable file boundary", () => {
  test("rejects a file relPath that escapes the skill directory", () => {
    const pack = loadFixture("valid-classified-skill.json");
    pack.skills[0].files = [
      {
        relPath: "../../../../outside.txt",
        bytesRef: `sha256:${"a".repeat(64)}`,
        content: "eA==",
      },
    ];
    const result = validateRenderedPack(pack);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("outside.txt") && e.includes("portable"))).toBe(true);
  });

  test("rejects a file entry with missing content instead of accepting a half-readable contract", () => {
    const pack = loadFixture("valid-classified-skill.json");
    pack.skills[0].files = [
      { relPath: "scripts/run.sh", bytesRef: `sha256:${"b".repeat(64)}` },
    ];
    const result = validateRenderedPack(pack);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("content"))).toBe(true);
  });

  test("rejects duplicate relPaths within one skill", () => {
    const pack = loadFixture("valid-classified-skill.json");
    const file = { relPath: "assets/icon.svg", bytesRef: `sha256:${"c".repeat(64)}`, content: "eA==" };
    pack.skills[0].files = [file, { ...file }];
    const result = validateRenderedPack(pack);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate") && e.includes("assets/icon.svg"))).toBe(true);
  });
});

describe("hooks.entryCount / hooks.present consistency", () => {
  test("entryCount must be 0 when present is false", () => {
    const pack = loadFixture("valid-minimal.json");
    pack.hooks = { present: false, entryCount: 3 };
    const result = validateRenderedPack(pack);
    expect(result.ok).toBe(false);
  });

  test("a negative entryCount is rejected", () => {
    const pack = loadFixture("valid-with-hooks.json");
    pack.hooks.entryCount = -1;
    expect(validateRenderedPack(pack).ok).toBe(false);
  });
});

describe("mcpServers presence", () => {
  test("a missing mcpServers key is rejected (the key itself is required, even though null is legal)", () => {
    const pack = loadFixture("valid-minimal.json");
    delete pack.mcpServers;
    expect(validateRenderedPack(pack).ok).toBe(false);
  });

  test("mcpServers: null is legal", () => {
    const pack = loadFixture("valid-minimal.json");
    pack.mcpServers = null;
    expect(validateRenderedPack(pack).ok).toBe(true);
  });
});

describe("fixture coverage", () => {
  test("every fixture file in fixtures/packs/ is exercised by at least one assertion above", () => {
    const onDisk = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
    expect(onDisk.length).toBeGreaterThan(0); // positive control on the directory read itself
    const unused = onDisk.filter((f) => !usedFixtures.has(f));
    expect(unused).toEqual([]);
  });
});
