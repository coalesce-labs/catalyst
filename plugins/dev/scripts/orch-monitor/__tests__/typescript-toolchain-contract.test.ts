import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");

/**
 * Read a package's version off DISK by walking the node_modules ladder upward
 * from `fromDir`, exactly as the runtime resolver would.
 *
 * Deliberately NOT require.resolve / createRequire: module resolution is cached
 * process-wide and a fresh createRequire does not clear it, so a resolver-based
 * read can answer from cache rather than from the bytes on disk
 * (docs/architecture.md → "Installed-in-name-only", CTL-1831).
 *
 * Returns null when the package cannot be located — callers must treat null as
 * a FAILURE, never as a pass.
 */
function resolvePackageVersionOnDisk(id: string, fromDir: string): string | null {
  let dir = realpathSync(fromDir);
  for (;;) {
    const pkgJson = join(dir, "node_modules", ...id.split("/"), "package.json");
    if (existsSync(pkgJson)) {
      const parsed: unknown = JSON.parse(readFileSync(pkgJson, "utf8"));
      const version = (parsed as { version?: unknown }).version;
      return typeof version === "string" ? version : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function packageDirOnDisk(id: string, fromDir: string): string | null {
  let dir = realpathSync(fromDir);
  for (;;) {
    const candidate = join(dir, "node_modules", ...id.split("/"));
    if (existsSync(join(candidate, "package.json"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

describe("TypeScript toolchain contract (CTL-2179)", () => {
  // RED until Phase 2: today `.bin/tsc` is TypeScript 6.0.3.
  test("the tsc binary `bun run typecheck` invokes is TypeScript 7.x", () => {
    const tsc = join(ROOT, "node_modules", ".bin", "tsc");
    expect(existsSync(tsc)).toBe(true); // fail closed: absent bin is a failure
    const out = execFileSync(tsc, ["--version"], { encoding: "utf8" }).trim();
    expect(out).toMatch(/^Version 7\./);
  });

  // GREEN today; must STAY green. This is the direct pin for the #3909 failure.
  test("typescript-eslint resolves a TypeScript 6.x API, satisfying its peer bound", () => {
    const teslintDir = packageDirOnDisk("typescript-eslint", ROOT);
    expect(teslintDir).not.toBeNull(); // fail closed
    const version = resolvePackageVersionOnDisk("typescript", teslintDir!);
    expect(version).not.toBeNull(); // fail closed: "could not look" is not a pass
    const major = Number(version!.split(".")[0]);
    expect(major).toBe(6);
  });

  // GREEN today; must STAY green. The guard throws at import time on major >= 7,
  // so a successful import is the whole regression signal.
  test("typescript-eslint imports without throwing its TS-version guard", async () => {
    const mod = await import("typescript-eslint");
    expect(typeof mod.configs).toBe("object");
  });

  // AC2 pin: the split must not be paid for with lint coverage.
  test("the type-aware lint rule set and file scope are unchanged", () => {
    const cfg = readFileSync(join(ROOT, "eslint.config.js"), "utf8");
    for (const rule of [
      "@typescript-eslint/no-explicit-any",
      "@typescript-eslint/no-unused-vars",
      "@typescript-eslint/no-floating-promises",
      "@typescript-eslint/no-misused-promises",
      "@typescript-eslint/no-non-null-assertion",
    ]) {
      expect(cfg).toContain(rule);
    }
    expect(cfg).toContain("recommendedTypeChecked"); // type-aware linting still on
    expect(cfg).toContain("projectService: true");   // still project-backed
    // The ignore list must not have grown to route around the migration.
    expect(cfg).not.toContain('"cli/**"');
    expect(cfg).not.toContain('"lib/**"');
  });

  // AC3 pin: the UI's compiler declaration must be explicit and must not have
  // silently regressed below the pre-migration 5.8.3 floor (Phase 3, Branch A).
  test("the UI workspace declares an intentional, non-downgraded TypeScript", () => {
    const ui = JSON.parse(
      readFileSync(join(ROOT, "ui", "package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const dev = ui.devDependencies ?? {};
    const declared = dev["typescript"];
    expect(typeof declared).toBe("string");
    // Anchored at the start: an unanchored /\^?[0-4]\./ would false-positive on
    // e.g. "^6.0.2" itself (it matches the "0." inside ".0.2").
    expect(declared).not.toMatch(/^\^?[0-4]\./);
  });

  // Cross-runner pin (Phase 4): ubuntu-latest (quality) and macos-latest
  // (publish-desktop) both consume this lockfile, so the optional platform
  // binaries for each must be present.
  test("the lockfile carries TS 7 binaries for every CI runner platform", () => {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      cwd: ROOT,
    }).trim();
    expect(gitRoot.length).toBeGreaterThan(0); // fail closed: empty root is a failure
    const lockPath = join(gitRoot, "bun.lock");
    expect(existsSync(lockPath)).toBe(true); // fail closed: absent lockfile is a failure
    const lock = readFileSync(lockPath, "utf8");
    expect(lock.length).toBeGreaterThan(0); // fail closed: a zero-length read must fail
    for (const platform of [
      "@typescript/typescript-linux-x64",
      "@typescript/typescript-darwin-arm64",
      "@typescript/typescript-darwin-x64",
    ]) {
      expect(lock).toContain(`${platform}@7.0.2`);
    }
  });
});
