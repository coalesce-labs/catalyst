// governance-config.test.mjs — CTL-1062. readGovernanceConfig() snapshot.
// Run: cd plugins/dev/scripts/execution-core && bun test governance-config.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readGovernanceConfig } from "./config.mjs";

const ENVS = [
  "CATALYST_BELIEFS_SHADOW", "CATALYST_DIAGNOSTICIAN", "CATALYST_INTENTS_ENFORCE",
  "CATALYST_ADVANCE_SHADOW_SUMMARY", "CATALYST_STALL_JANITOR",
  "EXECUTION_CORE_STALL_JANITOR_MODE", "CATALYST_WATCHDOG", "EXECUTION_CORE_WATCHDOG_MODE",
  "CATALYST_UNSTUCK_SWEEP", "EXECUTION_CORE_UNSTUCK_SWEEP_MODE", "CATALYST_LAYER2_CONFIG_FILE",
];
let saved = {};
beforeEach(() => { for (const k of ENVS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENVS) { saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); } saved = {}; });

describe("readGovernanceConfig (CTL-1062)", () => {
  test("defaults match the per-tick gate defaults when no env is set", () => {
    const g = readGovernanceConfig();
    expect(g.beliefsShadow).toBe(false);
    expect(g.diagnostician).toBe(false);
    expect(g.intentsEnforce).toBe(false);
    expect(g.advanceShadowSummary).toBe(false);
    expect(g.stallJanitor.mode).toBe("shadow");
    expect(g.watchdog.mode).toBe("shadow");
    expect(g.unstuckSweep.mode).toBe("off");
  });

  test("beliefs family flips to true only on exact '1'", () => {
    process.env.CATALYST_BELIEFS_SHADOW = "1";
    process.env.CATALYST_DIAGNOSTICIAN = "true"; // not "1" → still false
    const g = readGovernanceConfig();
    expect(g.beliefsShadow).toBe(true);
    expect(g.diagnostician).toBe(false);
  });

  test("mode subsystems reflect their env knobs", () => {
    process.env.CATALYST_STALL_JANITOR = "enforce";
    process.env.CATALYST_UNSTUCK_SWEEP = "shadow";
    const g = readGovernanceConfig();
    expect(g.stallJanitor.mode).toBe("enforce");
    expect(g.unstuckSweep.mode).toBe("shadow");
  });

  test("never throws on a malformed Layer-2 file", () => {
    process.env.CATALYST_LAYER2_CONFIG_FILE = "/nonexistent/path/config.json";
    expect(() => readGovernanceConfig()).not.toThrow();
  });

  test("returns a plain JSON-serializable object", () => {
    const g = readGovernanceConfig();
    expect(JSON.parse(JSON.stringify(g))).toEqual(g);
  });
});
