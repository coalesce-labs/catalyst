// cli-inventory.test.mjs — CTL-1461 Phase 7: fixing defect 6 (silent/crashing
// inventory disagreement between release-please-config.json and disk).
//
// Run: bun test scripts/packaging/__tests__/cli-inventory.test.mjs
//
// See also inventory-cut.test.sh for the full end-to-end "simulated cut"
// rehearsal (a scratch multi-plugin repo, actually deleted directories,
// actually re-rendered) — this file covers the pure decision function in
// isolation, asserted on message text.

import { describe, test, expect } from "bun:test";

import { assertPluginInventoryAgreement, readConfigPackageOrder, repoRoot } from "../cli.mjs";
import { listPluginRelPaths } from "../providers/local.mjs";

describe("assertPluginInventoryAgreement — the real repo's current agreeing state", () => {
  test("the real config order and the real on-disk plugin set agree — no error", () => {
    const order = readConfigPackageOrder(repoRoot);
    const diskRelPaths = listPluginRelPaths(repoRoot);
    expect(() => assertPluginInventoryAgreement(order, diskRelPaths)).not.toThrow();
  });
});

describe("assertPluginInventoryAgreement — direction 1: config lists a plugin absent from disk", () => {
  test("throws, naming the plugin path and pointing at release-please-config.json", () => {
    const order = ["plugins/dev", "plugins/ghost"];
    const diskRelPaths = ["plugins/dev"];
    expect(() => assertPluginInventoryAgreement(order, diskRelPaths)).toThrow(/plugins\/ghost/);
    try {
      assertPluginInventoryAgreement(order, diskRelPaths);
    } catch (err) {
      expect(String(err.message)).toContain("plugins/ghost");
      expect(String(err.message)).toContain("release-please-config.json");
      expect(String(err.message)).not.toContain("TypeError");
    }
  });
});

describe("assertPluginInventoryAgreement — direction 2: a plugin on disk has no config entry", () => {
  test("throws, naming the plugin path and pointing at release-please-config.json", () => {
    const order = ["plugins/dev"];
    const diskRelPaths = ["plugins/dev", "plugins/orphan"];
    expect(() => assertPluginInventoryAgreement(order, diskRelPaths)).toThrow(/plugins\/orphan/);
    try {
      assertPluginInventoryAgreement(order, diskRelPaths);
    } catch (err) {
      expect(String(err.message)).toContain("plugins/orphan");
      expect(String(err.message)).toContain("release-please-config.json");
    }
  });
});

describe("assertPluginInventoryAgreement — negative control: identical sets in different orders never throw", () => {
  test("order and disk membership agree even when array order differs", () => {
    const order = ["plugins/a", "plugins/b", "plugins/c"];
    const diskRelPaths = ["plugins/c", "plugins/a", "plugins/b"];
    expect(() => assertPluginInventoryAgreement(order, diskRelPaths)).not.toThrow();
  });

  test("empty sets on both sides never throw", () => {
    expect(() => assertPluginInventoryAgreement([], [])).not.toThrow();
  });
});
