// env-restore-guard.test.mjs — CAT-251 HOME restoration regression guard.
//
// INVARIANT: deleting process.env.HOME is permitted only as the undefined arm
// of a conditional restoration. A test that leaves HOME unset can make a later
// `gh` invocation write `.local/state/gh/device-id` below cwd.
//
// This deliberately does not flag bare HOME assignments: a line-oriented rule
// would match both the canonical `else process.env.HOME = savedHome` arm and
// ordinary setters. Those shapes need targeted behavioral assertions instead.
// Snapshot-set equality fails for both new offenders and stale exemptions.
// This guard covers only the shapes its line-oriented detector can see. Named
// blind spots are bracket notation, Reflect.deleteProperty, assignment of
// undefined, a delete split across lines, and deletion through an env alias.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SOURCE_EXT = /\.(?:mjs|js|ts|tsx)$/;
const OFFENDER = /delete\s+process\.env\.HOME/;
const GUARDED = /if\s*\(\s*([A-Za-z_$][\w$]*)\s*===\s*undefined\s*\)\s*delete\s+process\.env\.HOME\s*;/;
const BRACED_GUARD = /^\s*if\s*\(\s*([A-Za-z_$][\w$]*)\s*===\s*undefined\s*\)\s*\{\s*$/;
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

function classifyPair(lines, index) {
  const inlineGuard = lines[index].match(GUARDED);
  if (inlineGuard) {
    return new RegExp(
      `^\\s*else\\s+process\\.env\\.HOME\\s*=\\s*${inlineGuard[1]}\\s*;`,
    ).test(lines[index + 1] ?? "");
  }

  const bracedGuard = (lines[index - 1] ?? "").match(BRACED_GUARD);
  return Boolean(bracedGuard
    && /^\s*delete\s+process\.env\.HOME\s*;\s*$/.test(lines[index])
    && /^\s*}\s*else\s*{\s*$/.test(lines[index + 1] ?? "")
    && new RegExp(
      `^\\s*process\\.env\\.HOME\\s*=\\s*${bracedGuard[1]}\\s*;`,
    ).test(lines[index + 2] ?? ""));
}

test("every process.env.HOME deletion is a conditional restoration", () => {
  const files = sourceFiles(SCRIPTS_DIR);
  const offenders = [];
  expect(files.length).toBeGreaterThan(0);
  expect(files).toContain(join(SCRIPTS_DIR, "broker", "watchdog-map-bounding.test.mjs"));
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!OFFENDER.test(line)) return;
      if (!classifyPair(lines, index)) {
        offenders.push(`${relative(SCRIPTS_DIR, file)}:${index + 1}`);
      }
    });
  }
  expect(offenders.sort()).toEqual(ALLOWLIST.slice().sort());
});

test("the canonical-pair classifier rejects unrelated or incomplete guards", () => {
  const deletion = ["delete", "process.env.HOME;"].join(" ");

  expect(classifyPair([
    `if (savedHome === undefined) ${deletion}`,
    "else process.env.HOME = savedHome;",
  ], 0)).toBe(true);
  expect(classifyPair([
    "if (savedHome === undefined) {",
    deletion,
    "} else {",
    "  process.env.HOME = savedHome;",
    "}",
  ], 1)).toBe(true);
  expect(classifyPair([
    `if (unrelated === undefined) ${deletion}`,
    "else process.env.HOME = savedHome;",
  ], 0)).toBe(false);
  expect(classifyPair([`if (savedHome === undefined) ${deletion}`], 0)).toBe(false);
});
