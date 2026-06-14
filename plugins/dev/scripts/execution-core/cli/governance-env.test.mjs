// cli/governance-env.test.mjs — CTL-1084. buildGovernanceExports unit tests.
// Run: cd plugins/dev/scripts/execution-core && bun test cli/governance-env.test.mjs

import { describe, test, expect } from "bun:test";
import { buildGovernanceExports } from "./governance-env.mjs";

describe("buildGovernanceExports (CTL-1084)", () => {
  test("emits resolved durable value when env unset (the no-ritual fix)", () => {
    const lines = buildGovernanceExports({
      env: {}, governance: { beliefsShadow: true, diagnostician: false,
        intentsEnforce: false, advanceShadowSummary: false },
    });
    expect(lines).toContain('export CATALYST_BELIEFS_SHADOW="1"');
    expect(lines).toContain('export CATALYST_DIAGNOSTICIAN="0"');
  });

  test("preserves an explicit env override verbatim (still '1')", () => {
    const lines = buildGovernanceExports({
      env: { CATALYST_BELIEFS_SHADOW: "1" },
      governance: { beliefsShadow: true, diagnostician: false,
        intentsEnforce: false, advanceShadowSummary: false },
    });
    expect(lines).toContain('export CATALYST_BELIEFS_SHADOW="1"');
  });

  test("output is eval-safe: only export lines for the four known flags", () => {
    const lines = buildGovernanceExports({ env: {}, governance: {
      beliefsShadow: false, diagnostician: false, intentsEnforce: false, advanceShadowSummary: false,
    }});
    const names = lines.split("\n").filter(Boolean).map((l) => l.split("=")[0]);
    expect(names.sort()).toEqual([
      "export CATALYST_ADVANCE_SHADOW_SUMMARY", "export CATALYST_BELIEFS_SHADOW",
      "export CATALYST_DIAGNOSTICIAN", "export CATALYST_INTENTS_ENFORCE",
    ]);
  });

  test("all four flags emit '1' when governance all-true", () => {
    const lines = buildGovernanceExports({ env: {}, governance: {
      beliefsShadow: true, diagnostician: true, intentsEnforce: true, advanceShadowSummary: true,
    }});
    expect(lines).toContain('export CATALYST_BELIEFS_SHADOW="1"');
    expect(lines).toContain('export CATALYST_DIAGNOSTICIAN="1"');
    expect(lines).toContain('export CATALYST_INTENTS_ENFORCE="1"');
    expect(lines).toContain('export CATALYST_ADVANCE_SHADOW_SUMMARY="1"');
  });

  test("all four flags emit '0' when governance all-false", () => {
    const lines = buildGovernanceExports({ env: {}, governance: {
      beliefsShadow: false, diagnostician: false, intentsEnforce: false, advanceShadowSummary: false,
    }});
    expect(lines).toContain('export CATALYST_BELIEFS_SHADOW="0"');
    expect(lines).toContain('export CATALYST_DIAGNOSTICIAN="0"');
    expect(lines).toContain('export CATALYST_INTENTS_ENFORCE="0"');
    expect(lines).toContain('export CATALYST_ADVANCE_SHADOW_SUMMARY="0"');
  });
});
