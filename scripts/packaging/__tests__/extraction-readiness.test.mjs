// extraction-readiness.test.mjs — CTL-1463 Phase 6.
//
// Run: bun test scripts/packaging/__tests__/extraction-readiness.test.mjs

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkExtractionReadiness } from "../core/extraction-readiness.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

let _tmpDirs = [];
function fixtureDir() {
  const dir = mkdtempSync(resolve(tmpdir(), "extraction-readiness-test-"));
  _tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
  _tmpDirs = [];
});

describe("checkExtractionReadiness — the real repo today", () => {
  test("returns inconclusive, naming CTL-1461 as not landed (the shared fixture set does not exist yet)", () => {
    const result = checkExtractionReadiness({ repoRoot });
    expect(result.verdict).toBe("inconclusive");
    expect(result.reason).toContain("CTL-1461 not landed");
  });
});

describe("checkExtractionReadiness — three-valued, never a bare boolean pass on absence", () => {
  test("absent directory → inconclusive", () => {
    const dir = fixtureDir();
    const result = checkExtractionReadiness({ repoRoot: dir });
    expect(result.verdict).toBe("inconclusive");
  });

  test("EMPTY directory (a stray mkdir, not a fixture set) → still inconclusive, never ready", () => {
    const dir = fixtureDir();
    mkdirSync(resolve(dir, "scripts/packaging/fixtures/shared-contract"), { recursive: true });
    const result = checkExtractionReadiness({ repoRoot: dir });
    expect(result.verdict).toBe("inconclusive");
    expect(result.reason).toContain("empty");
  });

  test("a planted fixture-suite marker flips the verdict to ready — proving the check CAN move", () => {
    const dir = fixtureDir();
    const contractDir = resolve(dir, "scripts/packaging/fixtures/shared-contract");
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(resolve(contractDir, "example.json"), "{}");
    const result = checkExtractionReadiness({ repoRoot: dir });
    expect(result.verdict).toBe("ready");
  });
});
