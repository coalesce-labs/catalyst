// gh-state-ignore-guard.test.mjs — CAT-251 finding #3 residual (Codex P2 on #3274).
//
// INVARIANT: the `gh` state artifact written when HOME is unset
// (`<cwd>/.local/state/gh/…`, see .gitignore's rationale) must be git-ignored from
// EVERY directory a workflow runs tests in — not just the repo root.
//
// The directory list is DERIVED from .github/workflows/*.yml, never hardcoded: a
// hardcoded list fails OPEN the day someone adds another `working-directory`.

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  cwd: dirname(fileURLToPath(import.meta.url)),
  encoding: "utf8",
}).trim();
const WORKFLOW_DIR = join(REPO_ROOT, ".github", "workflows");
const WD = /^\s*working-directory:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/;

function workingDirFrom(line) {
  if (!/\bworking-directory\s*:/.test(line)) return null;
  const match = line.match(WD);
  if (!match) throw new Error(`unresolved working-directory: ${line.trim()}`);
  const value = match[1] ?? match[2] ?? match[3];
  if (/\$\{\{/.test(value)) throw new Error(`dynamic working-directory is not statically provable: ${value}`);
  return value.replace(/\/+$/, "") || ".";
}

function declaredWorkingDirs() {
  const dirs = new Set(["."]);
  for (const file of readdirSync(WORKFLOW_DIR)) {
    if (!/\.ya?ml$/.test(file)) continue;
    for (const line of readFileSync(join(WORKFLOW_DIR, file), "utf8").split("\n")) {
      const dir = workingDirFrom(line);
      if (dir) dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

function isIgnored(relPath) {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", relPath], { cwd: REPO_ROOT });
    return true;
  } catch {
    return false;
  }
}

test("the workflow scan finds the real working-directory set (fail closed)", () => {
  const dirs = declaredWorkingDirs();
  expect(dirs.length).toBeGreaterThan(1);
  expect(dirs).toContain("plugins/dev/scripts/execution-core");
  expect(dirs).toContain("plugins/dev/scripts/broker");
});

test("gh state is ignored from every declared working directory", () => {
  const unignored = declaredWorkingDirs()
    .map((dir) => (dir === "." ? "" : dir))
    .map((dir) => posix.join(dir, ".local/state/gh/device-id"))
    .filter((path) => !isIgnored(path));
  expect(unignored).toEqual([]);
});

test("the pattern does not over-reach into unrelated package-local .local content", () => {
  const mustStayVisible = [
    "plugins/dev/scripts/execution-core/.local/share/keep-me.txt",
    "plugins/dev/scripts/broker/.local/state/other/file.txt",
  ];
  expect(mustStayVisible.filter(isIgnored)).toEqual([]);
});

test("workflow directory parsing handles comments and rejects dynamic paths", () => {
  expect(workingDirFrom(`  working-directory: "plugins/dev/scripts" # nested suite`)).toBe("plugins/dev/scripts");
  expect(workingDirFrom("  working-directory: plugins/dev/scripts/broker # broker suite")).toBe("plugins/dev/scripts/broker");
  expect(() => workingDirFrom("  working-directory: ${{ matrix.directory }}")).toThrow(/unresolved|dynamic/);
});
