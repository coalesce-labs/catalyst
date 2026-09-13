// dev-pack-hooks.test.mjs — CTL-2306 Phase 1.
//
// Run: bun test scripts/packaging/__tests__/dev-pack-hooks.test.mjs
//
// The REAL catalyst-dev pack renders with no hooks, so the safety gate's
// pack-wide `pack-hooks-present` veto no longer removes every dev skill from the
// codex and agentsSkills targets. The dev skills may still be omitted for a
// DIFFERENT, per-skill reason (a missing agents/portability.yaml sidecar) until
// CTL-2306 Phase 3 — this test pins only that hooks are no longer the reason.
//
// Positive control first: the same provider call against a scratch plugin that
// DOES carry a hooks.toml must report it, so a green result here is a real
// absence and not a provider that stopped looking.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { renderPluginPack } from "../providers/local.mjs";
import { classifySkillEmission, REASON } from "../core/safety-gate.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scratchRoot = mkdtempSync(join(tmpdir(), "ctl-2306-hooks-control-"));

afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }));

describe("catalyst-dev carries no hooks (CTL-2306)", () => {
  test("control: the provider reports a hooks.toml planted in a scratch plugin", () => {
    const pluginDir = join(scratchRoot, "plugin-with-hooks");
    mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(pluginDir, "skills"), { recursive: true });
    writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "control" }));
    writeFileSync(join(pluginDir, "hooks.toml"), '[[hooks]]\nname = "control"\n');

    const pack = renderPluginPack({ repoRoot: scratchRoot, pluginRelPath: "plugin-with-hooks", packId: "control" });
    expect(pack.hooks).toEqual({ present: true, entryCount: 1 });
  });

  const devPack = renderPluginPack({ repoRoot, pluginRelPath: "plugins/dev", packId: "catalyst-dev" });

  test("the real plugins/dev pack renders hooks.present false", () => {
    expect(devPack.skills.length).toBeGreaterThan(0);
    expect(devPack.hooks).toEqual({ present: false, entryCount: 0 });
  });

  test("no dev skill is vetoed from a non-Claude target for pack-hooks-present", () => {
    const vetoed = [];
    for (const target of ["codex", "agentsSkills"]) {
      for (const skill of devPack.skills) {
        const verdict = classifySkillEmission(skill, devPack.hooks, target);
        if (verdict.reasonCode === REASON.HOOKS_PRESENT) vetoed.push(`${target}/${skill.id}`);
      }
    }
    expect(vetoed).toEqual([]);
  });
});
