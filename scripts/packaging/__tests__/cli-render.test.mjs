// cli-render.test.mjs — CTL-1463 Phase 2: automated version of the plan's
// "manual" dry-run census check (`bun scripts/packaging/cli.mjs render --dry-run`
// prints a per-plugin skill/agent census matching `ls plugins/*/skills | wc -l`).
//
// Run: bun test scripts/packaging/__tests__/cli-render.test.mjs

import { describe, test, expect } from "bun:test";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { renderAllPacks, repoRoot } from "../cli.mjs";

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
  test("renders all 10 plugins, all valid, with a skill total matching an independent filesystem count", () => {
    const results = renderAllPacks(repoRoot);
    expect(results.length).toBe(10);
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
