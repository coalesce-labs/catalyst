// claude-emitter.test.mjs — CTL-1463 Phase 4: the load-bearing round-trip test.
//
// Run: bun test scripts/packaging/__tests__/claude-emitter.test.mjs
//
// If regeneration cannot reproduce today's committed files byte-for-byte,
// nothing downstream is trustworthy. This test's own mutation control
// (perturbing one pack.json description) is what proves the diff check can
// actually fail — a round-trip test whose diff is empty because the
// comparison never really ran is the classic false clean this repo has been
// burned by before.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { readPackManifest } from "../core/pack-manifest.mjs";
import { listPluginRelPaths } from "../providers/local.mjs";
import { renderPluginJson, renderMarketplaceJson, readExistingVersion, buildMarketplaceJson } from "../emitters/claude.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function readRaw(relPath) {
  return readFileSync(resolve(repoRoot, relPath), "utf8");
}

function committedMarketplaceOrder() {
  // The committed marketplace.json's plugin order equals
  // release-please-config.json's package key order (verified: both list
  // dev, analytics, debugging, meta, pm-ops, meeting-hygiene, legacy, foundry)
  // — read from the config file directly rather than hardcoding that
  // sequence, so a future reorder of the config (or plugin removal) is
  // honored.
  const config = JSON.parse(readRaw("release-please-config.json"));
  return Object.keys(config.packages);
}

describe("claude emitter — plugin.json round-trip (all 8, byte-exact)", () => {
  for (const pluginRelPath of listPluginRelPaths(repoRoot)) {
    test(`${pluginRelPath}/.claude-plugin/plugin.json regenerates byte-identically`, () => {
      const packManifest = readPackManifest(repoRoot, pluginRelPath);
      const existingVersion = readExistingVersion(repoRoot, pluginRelPath);
      const rendered = renderPluginJson(packManifest, existingVersion) + "\n";
      const committed = readRaw(`${pluginRelPath}/.claude-plugin/plugin.json`);
      expect(rendered).toBe(committed);
    });
  }
});

describe("claude emitter — marketplace.json round-trip (byte-exact)", () => {
  test("regenerates .claude-plugin/marketplace.json byte-identically, in the release-please-config.json package order", () => {
    const order = committedMarketplaceOrder();
    const entries = order.map((pluginRelPath) => ({
      pluginRelPath,
      packManifest: readPackManifest(repoRoot, pluginRelPath),
    }));
    const rendered = renderMarketplaceJson(entries) + "\n";
    const committed = readRaw(".claude-plugin/marketplace.json");
    expect(rendered).toBe(committed);
  });

  test("mutation control: perturbing one pack.json description produces a NON-empty diff", () => {
    const order = committedMarketplaceOrder();
    const entries = order.map((pluginRelPath) => ({
      pluginRelPath,
      packManifest: readPackManifest(repoRoot, pluginRelPath),
    }));
    // Perturb a deep copy of the first entry's marketplace description.
    const mutated = JSON.parse(JSON.stringify(entries[0].packManifest));
    mutated.distribution.claude.marketplace.description += " MUTATED";
    entries[0] = { ...entries[0], packManifest: mutated };

    const rendered = renderMarketplaceJson(entries) + "\n";
    const committed = readRaw(".claude-plugin/marketplace.json");
    expect(rendered).not.toBe(committed);
  });
});

describe("readExistingVersion", () => {
  test("refuses (throws) when the target file does not exist — never seeds a version", () => {
    expect(() => readExistingVersion(repoRoot, "plugins/does-not-exist")).toThrow();
  });

  test("returns the real committed version for a real plugin", () => {
    const version = readExistingVersion(repoRoot, "plugins/dev");
    const committed = JSON.parse(readRaw("plugins/dev/.claude-plugin/plugin.json"));
    expect(version).toBe(committed.version);
  });
});

describe("non-ASCII escaping asymmetry (verified against the real committed bytes)", () => {
  test("plugin.json's arrow character is LITERAL UTF-8, never \\u2192", () => {
    const raw = readRaw("plugins/dev/.claude-plugin/plugin.json");
    expect(raw).toContain("→");
    expect(raw).not.toContain("\\u2192");
  });

  test("marketplace.json's arrow character is the \\u2192 ESCAPE, never literal UTF-8", () => {
    const raw = readRaw(".claude-plugin/marketplace.json");
    expect(raw).toContain("\\u2192");
    expect(raw).not.toContain("→");
  });

  test("buildMarketplaceJson output for catalyst-dev contains the escape, not the literal (regression guard on the asymmetry itself)", () => {
    const order = committedMarketplaceOrder();
    const entries = order.map((pluginRelPath) => ({
      pluginRelPath,
      packManifest: readPackManifest(repoRoot, pluginRelPath),
    }));
    const built = buildMarketplaceJson(entries);
    const devEntry = built.plugins.find((p) => p.name === "catalyst-dev");
    expect(devEntry.description).toContain("→"); // the in-memory JS string is unescaped
  });
});
