// inventory-guard.test.mjs — CTL-1461 Phase 7.
//
// Run: bun test scripts/packaging/__tests__/inventory-guard.test.mjs

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scanForInventoryAssumptions, ALLOWLISTED_SKILL_IDENTIFIERS } from "../core/inventory-guard.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

let _tmpDirs = [];
function fixtureDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "inventory-guard-test-"));
  _tmpDirs.push(dir);
  return dir;
}
function writeFile(dir, relPath, contents) {
  const path = resolve(dir, relPath);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  return path;
}
afterEach(() => {
  for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
  _tmpDirs = [];
});

describe("scanForInventoryAssumptions — the real production packaging tree is clean", () => {
  test("scripts/packaging/{core,emitters,providers,cli.mjs} + the CI gate report zero violations, and the scan actually looked", () => {
    const result = scanForInventoryAssumptions({
      repoRoot,
      paths: [
        "scripts/packaging/core",
        "scripts/packaging/emitters",
        "scripts/packaging/providers",
        "scripts/packaging/cli.mjs",
        ".github/workflows/packaging-gate.yml",
      ],
    });
    // The positive control: a scan of paths that don't exist returns zero
    // hits and reads as a pass — asserting filesScanned > 0 rules that out.
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });
});

describe("scanForInventoryAssumptions — planted-violation mutation controls", () => {
  test("a planted hardcoded skill count ('114 skills') is caught", () => {
    const dir = fixtureDir();
    writeFile(dir, "core/evil.mjs", "// TOTAL: 114 skills across 10 plugins\n");
    const result = scanForInventoryAssumptions({ repoRoot: dir, paths: ["core"] });
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.violations.some((v) => v.kind === "hardcoded-skill-count")).toBe(true);
  });

  test("a planted hardcoded plugin count ('10 plugins') is caught", () => {
    const dir = fixtureDir();
    writeFile(dir, "core/evil.mjs", "// this pipeline handles exactly 10 plugins\n");
    const result = scanForInventoryAssumptions({ repoRoot: dir, paths: ["core"] });
    expect(result.violations.some((v) => v.kind === "hardcoded-plugin-count")).toBe(true);
  });

  test("removing the planted line makes the scan clean again — proving the scan can see the violation, not just always fail", () => {
    const dir = fixtureDir();
    writeFile(dir, "core/fixed.mjs", "export const fine = 1;\n");
    const result = scanForInventoryAssumptions({ repoRoot: dir, paths: ["core"] });
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  test("a planted hardcoded plugin list (3+ real plugin ids on one line) is caught", () => {
    const dir = fixtureDir();
    writeFile(
      dir,
      "core/evil.mjs",
      `const ORDER = ["catalyst-dev", "catalyst-foundry", "catalyst-meta", "catalyst-legacy"];\n`
    );
    const result = scanForInventoryAssumptions({ repoRoot: dir, paths: ["core"] });
    expect(result.violations.some((v) => v.kind === "hardcoded-plugin-list")).toBe(true);
  });

  test("2 real plugin ids on one line is NOT flagged as a list (negative control on the threshold)", () => {
    const dir = fixtureDir();
    writeFile(dir, "core/fine.mjs", `// e.g. catalyst-dev and catalyst-meta both ship a sidecar\n`);
    const result = scanForInventoryAssumptions({ repoRoot: dir, paths: ["core"] });
    expect(result.violations.some((v) => v.kind === "hardcoded-plugin-list")).toBe(false);
  });

  test("a real skill identifier outside the allowlist is caught", () => {
    const dir = fixtureDir();
    writeFile(dir, "core/evil.mjs", `// see catalyst-dev/commit for an example\n`);
    const result = scanForInventoryAssumptions({ repoRoot: dir, paths: ["core"] });
    const hit = result.violations.find((v) => v.kind === "real-skill-identifier");
    expect(hit).toBeDefined();
    expect(hit.text).toBe("catalyst-dev/commit");
  });

  test("each of the three allowlisted skill identifiers is NOT flagged (negative control)", () => {
    const dir = fixtureDir();
    writeFile(dir, "core/fine.mjs", ALLOWLISTED_SKILL_IDENTIFIERS.map((id) => `// ${id}`).join("\n") + "\n");
    const result = scanForInventoryAssumptions({ repoRoot: dir, paths: ["core"] });
    expect(result.violations.some((v) => v.kind === "real-skill-identifier")).toBe(false);
  });

  test("__tests__/ is excluded by default — a real skill identifier there is not flagged", () => {
    const dir = fixtureDir();
    writeFile(dir, "core/__tests__/some.test.mjs", `// catalyst-dev/commit\n`);
    const result = scanForInventoryAssumptions({ repoRoot: dir, paths: ["core"] });
    expect(result.violations).toEqual([]);
  });
});
