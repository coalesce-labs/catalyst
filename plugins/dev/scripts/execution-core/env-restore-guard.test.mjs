// env-restore-guard.test.mjs — CAT-251 HOME restoration regression guard.
//
// INVARIANT: deleting process.env.HOME is permitted only as the undefined arm
// of a conditional restoration on the same line. A test that leaves HOME unset
// can make a later `gh` invocation write `.local/state/gh/device-id` below cwd.
//
// This deliberately does not flag bare HOME assignments: a line-oriented rule
// would match both the canonical `else process.env.HOME = savedHome` arm and
// ordinary setters. Those shapes need targeted behavioral assertions instead.
// Snapshot-set equality fails for both new offenders and stale exemptions.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SOURCE_EXT = /\.(?:mjs|js|ts|tsx)$/;
const OFFENDER = /delete\s+process\.env\.HOME/;
const GUARDED = /if\s*\(\s*([A-Za-z_$][\w$]*)\s*===\s*undefined\s*\)\s*delete\s+process\.env\.HOME\s*;/;
const ALLOWLIST = [];

function sourceFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) files.push(...sourceFiles(join(dir, entry.name)));
    } else if (SOURCE_EXT.test(entry.name)) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

test("every process.env.HOME deletion is a conditional restoration", () => {
  const offenders = [];
  for (const file of sourceFiles(SCRIPTS_DIR)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!OFFENDER.test(line)) return;
      const guarded = line.match(GUARDED);
      const restore = guarded && new RegExp(
        `^\\s*else\\s+process\\.env\\.HOME\\s*=\\s*${guarded[1]}\\s*;`,
      ).test(lines[index + 1] ?? "");
      if (!restore) offenders.push(`${relative(SCRIPTS_DIR, file)}:${index + 1}`);
    });
  }
  expect(offenders.sort()).toEqual(ALLOWLIST.slice().sort());
});

test("the canonical-pair classifier rejects unrelated or incomplete guards", () => {
  const deletion = ["delete", "process.env.HOME;"].join(" ");
  const classified = (lines) => {
    const guarded = lines[0].match(GUARDED);
    return Boolean(guarded && new RegExp(
      `^\\s*else\\s+process\\.env\\.HOME\\s*=\\s*${guarded[1]}\\s*;`,
    ).test(lines[1] ?? ""));
  };

  expect(classified([
    `if (savedHome === undefined) ${deletion}`,
    "else process.env.HOME = savedHome;",
  ])).toBe(true);
  expect(classified([
    `if (unrelated === undefined) ${deletion}`,
    "else process.env.HOME = savedHome;",
  ])).toBe(false);
  expect(classified([`if (savedHome === undefined) ${deletion}`])).toBe(false);
});
