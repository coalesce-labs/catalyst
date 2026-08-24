// packaging-seam.test.mjs — CTL-1463 Phase 1: the CTL-1461 adapter-seam guard.
//
// Run: bun test scripts/packaging/__tests__/packaging-seam.test.mjs
//
// The seam is what makes CTL-1461's later provider swap mechanical rather than
// a rewrite (see the plan's "coordinator decision" section): the core
// (`core/`, `emitters/`) must never import a provider module and must never
// read a `plugins/*/` path literal. This test both proves the REAL tree is
// currently clean AND proves the scanner can actually see a violation planted
// in a temp fixture — a scan whose "clean" result comes from scanning zero
// files is the false-clean shape this repo has been burned by before.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { scanForSeamViolations, countProviderImporters } from "../core/seam-guard.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

let _tmpDirs = [];
function fixtureDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "packaging-seam-test-"));
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

describe("scanForSeamViolations — the real tree", () => {
  test("scripts/packaging/core is clean, and the scan actually looked (non-zero file count)", () => {
    const result = scanForSeamViolations({ roots: ["scripts/packaging/core"], repoRoot });
    // The positive control this bullet in the plan calls out explicitly: a
    // scan of a directory that does not exist returns zero hits and reads as
    // a pass. Asserting filesScanned > 0 is what rules that out.
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  test("scripts/packaging/emitters is clean (empty dir at Phase 1 is fine; a zero count here is expected, not asserted non-zero)", () => {
    const result = scanForSeamViolations({ roots: ["scripts/packaging/emitters"], repoRoot });
    expect(result.violations).toEqual([]);
  });
});

describe("scanForSeamViolations — planted-violation mutation control", () => {
  test("a planted `import ... from '../providers/x.mjs'` in a fixture emitter is caught", () => {
    const dir = fixtureDir();
    writeFile(
      dir,
      "emitters/evil.mjs",
      `import { renderEvil } from "../providers/x.mjs";\nexport const evil = renderEvil;\n`
    );
    const result = scanForSeamViolations({ roots: ["emitters"], repoRoot: dir });
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations.some((v) => v.kind === "providers-import")).toBe(true);
  });

  test("removing the planted line makes the scan clean again — proving the scan can see the violation, not just always fail", () => {
    const dir = fixtureDir();
    writeFile(dir, "emitters/fixed.mjs", `export const fine = 1;\n`);
    const result = scanForSeamViolations({ roots: ["emitters"], repoRoot: dir });
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.violations).toEqual([]);
  });

  test("a planted `plugins/` path literal is caught", () => {
    const dir = fixtureDir();
    writeFile(dir, "core/evil.mjs", `import { readFileSync } from "node:fs";\nreadFileSync("plugins/dev/skills");\n`);
    const result = scanForSeamViolations({ roots: ["core"], repoRoot: dir });
    expect(result.violations.some((v) => v.kind === "plugins-path-literal")).toBe(true);
  });

  test("a markdown-style backtick mention of `plugins/dev` in a comment is NOT a violation (prose, not code)", () => {
    const dir = fixtureDir();
    writeFile(dir, "core/prose.mjs", "// see `plugins/dev` for an example\nexport const ok = 1;\n");
    const result = scanForSeamViolations({ roots: ["core"], repoRoot: dir });
    expect(result.violations).toEqual([]);
  });
});

describe("countProviderImporters", () => {
  test("the real production tree has exactly one provider importer: cli.mjs", () => {
    const result = countProviderImporters({
      repoRoot,
      packagingRoot: "scripts/packaging",
      providerBasename: "local-provisional.mjs",
      excludeDirNames: ["__tests__"],
    });
    expect(result.count).toBe(1);
    expect(result.files[0]).toBe(resolve(repoRoot, "scripts/packaging/cli.mjs"));
  });

  test("in a fixture tree, the provider is imported by exactly the one designated file", () => {
    const dir = fixtureDir();
    writeFile(dir, "providers/local-provisional.mjs", "export const render = () => {};\n");
    writeFile(dir, "cli.mjs", 'import { render } from "./providers/local-provisional.mjs";\n');
    writeFile(dir, "emitters/claude.mjs", "export const emit = () => {};\n");
    const result = countProviderImporters({
      repoRoot: dir,
      packagingRoot: ".",
      providerBasename: "local-provisional.mjs",
    });
    expect(result.count).toBe(1);
    expect(result.files[0]).toContain("cli.mjs");
  });

  test("a second importer is caught — the seam widening quietly", () => {
    const dir = fixtureDir();
    writeFile(dir, "providers/local-provisional.mjs", "export const render = () => {};\n");
    writeFile(dir, "cli.mjs", 'import { render } from "./providers/local-provisional.mjs";\n');
    writeFile(dir, "emitters/claude.mjs", 'import { render } from "../providers/local-provisional.mjs";\n');
    const result = countProviderImporters({
      repoRoot: dir,
      packagingRoot: ".",
      providerBasename: "local-provisional.mjs",
    });
    expect(result.count).toBe(2);
  });
});
