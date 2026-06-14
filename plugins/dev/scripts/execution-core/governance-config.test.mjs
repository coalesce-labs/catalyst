// governance-config.test.mjs — CTL-1062/CTL-1084. readGovernanceConfig() snapshot
// and three-layer beliefs resolution.
// Run: cd plugins/dev/scripts/execution-core && bun test governance-config.test.mjs

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGovernanceConfig, readGovernanceSources } from "./config.mjs";

const ENVS = [
  "CATALYST_BELIEFS_SHADOW", "CATALYST_DIAGNOSTICIAN", "CATALYST_INTENTS_ENFORCE",
  "CATALYST_ADVANCE_SHADOW_SUMMARY", "CATALYST_STALL_JANITOR",
  "EXECUTION_CORE_STALL_JANITOR_MODE", "CATALYST_WATCHDOG", "EXECUTION_CORE_WATCHDOG_MODE",
  "CATALYST_UNSTUCK_SWEEP", "EXECUTION_CORE_UNSTUCK_SWEEP_MODE", "CATALYST_LAYER2_CONFIG_FILE",
];
let saved = {};
beforeEach(() => { for (const k of ENVS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENVS) { saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); } saved = {}; });

// Helper: create a temp Layer-2 config file with the given governance block,
// redirect CATALYST_LAYER2_CONFIG_FILE, run fn, then clean up.
function withLayer2(governance, fn) {
  const dir = mkdtempSync(join(tmpdir(), "gov-l2-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ catalyst: { governance } }));
  const prev = process.env.CATALYST_LAYER2_CONFIG_FILE;
  process.env.CATALYST_LAYER2_CONFIG_FILE = p;
  try { return fn(); }
  finally {
    prev === undefined ? delete process.env.CATALYST_LAYER2_CONFIG_FILE
                       : (process.env.CATALYST_LAYER2_CONFIG_FILE = prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

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

// ── CTL-1084: three-layer beliefs resolution + readGovernanceSources ─────────
describe("beliefs flags are three-layer (CTL-1084)", () => {
  test("Layer-2 catalyst.governance.beliefsShadow=true survives with no env (no ritual)", () => {
    withLayer2({ beliefsShadow: true, intentsEnforce: true }, () => {
      const g = readGovernanceConfig();
      expect(g.beliefsShadow).toBe(true);
      expect(g.intentsEnforce).toBe(true);
      expect(g.diagnostician).toBe(false); // not set in L2 → default off
    });
  });

  test("env var wins over Layer-2 (explicit override)", () => {
    withLayer2({ beliefsShadow: false }, () => {
      process.env.CATALYST_BELIEFS_SHADOW = "1";
      const g = readGovernanceConfig();
      expect(g.beliefsShadow).toBe(true);
      delete process.env.CATALYST_BELIEFS_SHADOW;
    });
  });

  test("env '0' explicitly disables even when Layer-2 enables", () => {
    withLayer2({ beliefsShadow: true }, () => {
      process.env.CATALYST_BELIEFS_SHADOW = "0";
      expect(readGovernanceConfig().beliefsShadow).toBe(false);
      delete process.env.CATALYST_BELIEFS_SHADOW;
    });
  });

  test("readGovernanceSources tags each beliefs flag's origin", () => {
    withLayer2({ beliefsShadow: true }, () => {
      process.env.CATALYST_DIAGNOSTICIAN = "1";
      const s = readGovernanceSources();
      expect(s.beliefsShadow).toBe("config");       // from Layer-2
      expect(s.diagnostician).toBe("env-override");  // explicit env
      expect(s.intentsEnforce).toBe("default");      // neither
      delete process.env.CATALYST_DIAGNOSTICIAN;
    });
  });

  test("malformed Layer-2 never throws; falls back to default off", () => {
    process.env.CATALYST_LAYER2_CONFIG_FILE = "/nonexistent/x.json";
    expect(() => readGovernanceConfig()).not.toThrow();
    expect(readGovernanceConfig().beliefsShadow).toBe(false);
  });

  test("existing CTL-1062 default test: all false with no env AND no Layer-2 governance", () => {
    // Regression guard: the three-layer change must not alter the no-env/no-L2 defaults.
    const g = readGovernanceConfig();
    expect(g.beliefsShadow).toBe(false);
    expect(g.diagnostician).toBe(false);
    expect(g.intentsEnforce).toBe(false);
    expect(g.advanceShadowSummary).toBe(false);
  });
});
