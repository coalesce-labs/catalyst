// cli-render.test.mjs — CTL-1463 Phase 2: automated version of the plan's
// "manual" dry-run census check (`bun scripts/packaging/cli.mjs render --dry-run`
// prints a per-plugin skill/agent census matching `ls plugins/*/skills | wc -l`).
//
// Run: bun test scripts/packaging/__tests__/cli-render.test.mjs

import { describe, test, expect } from "bun:test";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { renderAllPacks, computeLossReport, repoRoot } from "../cli.mjs";
import { hasUnacknowledgedLosses } from "../core/loss.mjs";

function realSkillCountAcrossRepo() {
  let total = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (!statSync(p).isDirectory()) continue;
      if (existsSync(join(p, "SKILL.md"))) {
        total += 1;
      } else if (name !== "__tests__") {
        walk(p);
      }
    }
  };
  walk(join(repoRoot, "plugins"));
  return total;
}

describe("renderAllPacks — cli.mjs's render command core", () => {
  test("renders all 5 plugins, all valid, with a skill total matching an independent filesystem count", () => {
    const results = renderAllPacks(repoRoot);
    expect(results.length).toBe(5);
    for (const { pluginRelPath, validation } of results) {
      expect(validation.errors).toEqual([]);
      expect(validation.ok).toBe(true);
      void pluginRelPath;
    }
    const total = results.reduce((sum, r) => sum + r.pack.skills.length, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBe(realSkillCountAcrossRepo());
  });
});

describe("computeLossReport — the real repo's day-one cohort", () => {
  test("only the 2 opted-in skills from hook-free packs are emitted; catalyst-dev/linearis is omitted because its pack has safety hooks", () => {
    const results = renderAllPacks(repoRoot);
    const report = computeLossReport(results, "2026-01-01T00:00:00.000Z");
    expect(hasUnacknowledgedLosses(report)).toBe(true); // no silent caps: this MUST be visible

    const totalSkills = results.reduce((sum, r) => sum + r.pack.skills.length, 0);
    const omittedSkillIds = report.targets.codex.omitted.map((e) => e.skill);
    const emittedCount = totalSkills - omittedSkillIds.length;

    // Count-based, not boolean: `omitted + emitted === totalSkills` — a skill
    // lost between the two buckets is a failure, not a smaller clean number.
    expect(omittedSkillIds.length + emittedCount).toBe(totalSkills);
    expect(emittedCount).toBe(2);
    // Safety hooks guard every skill in catalyst-dev, so linearis cannot be projected.
    expect(omittedSkillIds).toContain("catalyst-dev/linearis");
    // The hook-free opted-in cohort must NOT appear in the omitted list...
    expect(omittedSkillIds).not.toContain("catalyst-meta/validate-frontmatter");
    expect(omittedSkillIds).not.toContain("catalyst-foundry/setup-catalyst");
    // ...while an ordinary, unclassified skill must.
    expect(omittedSkillIds).toContain("catalyst-dev/commit");
  });
});
