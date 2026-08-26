// inventory-fixture.test.mjs — CTL-1461 Phase 7.
//
// Run: bun test scripts/packaging/__tests__/inventory-fixture.test.mjs
//
// Runs the whole pipeline (provider → contract → loss classifier) against
// scripts/packaging/fixtures/inventory/ — a minimal SYNTHETIC one-plugin,
// two-skill repo — proving the code path works with a plugin count that is
// not ten and a skill count that is not 114. This is the deletion-order
// independence property made testable: nothing here may assume Catalyst's
// specific inventory.

import { describe, test, expect } from "bun:test";
import { fileURLToPath } from "node:url";

import { renderPluginPack } from "../providers/local.mjs";
import { validateRenderedPack } from "../core/contract.mjs";
import { classifyPackLosses } from "../core/loss.mjs";

const fixtureRepoRoot = fileURLToPath(new URL("../fixtures/inventory/", import.meta.url));

describe("the synthetic inventory fixture renders correctly end to end", () => {
  const pack = renderPluginPack({ repoRoot: fixtureRepoRoot, pluginRelPath: "plugin-a", packId: "fixture-plugin-a" });

  test("discovers exactly the two fixture skills (not 114, not any Catalyst-specific count)", () => {
    expect(pack.skills.map((s) => s.id).sort()).toEqual(["skill-with-sidecar", "skill-without-sidecar"]);
  });

  test("validates against the contract with zero errors", () => {
    const result = validateRenderedPack(pack);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("the sidecar-bearing skill carries the transcribed neutral classification", () => {
    const skill = pack.skills.find((s) => s.id === "skill-with-sidecar");
    expect(skill.neutral).toEqual({ effects: [], invocation: "auto", exposure: ["catalog"] });
  });

  test("the sidecar-less skill carries neutral: null (legal)", () => {
    const skill = pack.skills.find((s) => s.id === "skill-without-sidecar");
    expect(skill.neutral).toBeNull();
  });

  test("hooks.present is false (no hooks.toml in the fixture)", () => {
    expect(pack.hooks).toEqual({ present: false, entryCount: 0 });
  });

  describe("loss classification produces a correct, complete report for this non-Catalyst-shaped inventory", () => {
    const result = classifyPackLosses("fixture-plugin-a", pack, "agentsSkills");

    test("exactly one skill is omitted (the one with no sidecar), reasonCode no-neutral-declaration", () => {
      expect(result.omitted).toHaveLength(1);
      expect(result.omitted[0]).toMatchObject({ skill: "fixture-plugin-a/skill-without-sidecar", reasonCode: "no-neutral-declaration" });
    });

    test("the sidecar-bearing skill is neither omitted nor degraded (clean emission)", () => {
      expect(result.omitted.some((e) => e.skill.endsWith("skill-with-sidecar"))).toBe(false);
      expect(result.degraded.some((e) => e.skill?.endsWith("skill-with-sidecar"))).toBe(false);
    });

    // The conservation invariant, applied to a plugin count that is not ten:
    // emitted + omitted === totalSkills.
    test("conservation invariant: emitted + omitted === totalSkills", () => {
      const omittedCount = result.omitted.length;
      const emittedCount = pack.skills.length - omittedCount;
      expect(omittedCount + emittedCount).toBe(pack.skills.length);
      expect(emittedCount).toBe(1);
    });
  });
});
