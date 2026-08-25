import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dir, "..");

// Reads a package's version off disk (not via require.resolve, which is process-cached); null (a failure) if not found.
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

function tscVersionAt(root: string): string {
  const tsc = join(root, "node_modules", ".bin", "tsc");
  expect(existsSync(tsc)).toBe(true); // fail closed: absent bin is a failure
  return execFileSync(tsc, ["--version"], { encoding: "utf8" }).trim();
}

describe("TypeScript toolchain contract (CTL-2179)", () => {
  test("the tsc binary `bun run typecheck` invokes is TypeScript 7.x", () => {
    expect(tscVersionAt(ROOT)).toMatch(/^Version 7\./);
  });

  test("the UI workspace's own resolved tsc binary is also TypeScript 7.x", () => {
    expect(tscVersionAt(join(ROOT, "ui"))).toMatch(/^Version 7\./);
  });

  test("typescript-eslint resolves a TypeScript 6.x API, satisfying its peer bound", () => {
    const teslintDir = packageDirOnDisk("typescript-eslint", ROOT);
    expect(teslintDir).not.toBeNull(); // fail closed
    const version = resolvePackageVersionOnDisk("typescript", teslintDir!);
    expect(version).not.toBeNull(); // fail closed: "could not look" is not a pass
    const major = Number(version!.split(".")[0]);
    expect(major).toBe(6);
  });

  // The guard throws at import time on major >= 7, so a successful import is the whole regression signal.
  test("typescript-eslint imports without throwing its TS-version guard", async () => {
    const mod = await import("typescript-eslint");
    expect(typeof mod.configs).toBe("object");
  });

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

  test("the UI workspace declares an intentional, non-downgraded TypeScript", () => {
    const ui = JSON.parse(
      readFileSync(join(ROOT, "ui", "package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string> };
    const dev = ui.devDependencies ?? {};
    const declared = dev["typescript"];
    expect(typeof declared).toBe("string");
    // Assert the declared MAJOR, not a blocklist of rejected ones. A blocklist of
    // 0.x-4.x still admitted "^5.8.3" -- the exact pre-split value -- and nothing
    // else in this suite covers the declaration: the UI's `.bin/tsc` keeps
    // resolving to the `@typescript/native` alias even with a nested typescript@5
    // installed beside it, so test 2 does not stand in for this one.
    const major = Number(/^\D*(\d+)/.exec(declared ?? "")?.[1]);
    expect(Number.isInteger(major)).toBe(true); // fail closed: an unparseable range is a failure
    expect(major).toBeGreaterThanOrEqual(6);
  });

  // ubuntu-latest (quality) and macos-latest (publish-desktop) both consume this lockfile.
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
