// install-seam-guard.test.mjs — CAT-251 findings #1 + #2.
//
// INVARIANT: every call site selecting the doctor install profile injects the
// `skillsDirCheck` seam. Its live default reads host config and spawns git, while
// non-worker failures downgrade to WARN and can escape ordinary exit-code assertions.
//
// This guard walks the WHOLE scripts tree and classifies fail-closed: indirect,
// shorthand, computed, and spread profile selection is treated as install unless
// the call proves it has no profile or explicitly selects literal "activation".
//
// BLIND SPOTS: the argv/exec process boundary in install-lifecycle.mjs; dynamically
// assembled calls such as obj[name](...), imported aliases of either callee, options
// imported through a variable from another file, and the activation profile.
// The balanced-call parser is deliberately local rather than shared with other
// guards so one helper defect cannot silently weaken multiple invariants.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD_FILE = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = join(dirname(GUARD_FILE), "..");
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SOURCE_EXT = /\.(?:mjs|js|ts|tsx)$/;
const CALL_NAMES = ["installChecksForClass", "runDoctor"];
const ALLOWLIST = [
  {
    file: "execution-core/doctor.test.mjs",
    count: 2,
    ticket: "CAT-251",
    reason:
      "Two site-bound exemptions: recognized:false short-circuits before building the seam, " +
      "and the other site only stringifies its thunks. A third offender changes file×count.",
  },
];

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path, out);
    } else if (SOURCE_EXT.test(entry.name) && path !== GUARD_FILE) {
      out.push(path);
    }
  }
  return out.sort();
}

function balancedCall(src, open) {
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1] ?? "";
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced call at offset ${open}`);
}

function isCodePosition(src, offset) {
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < offset; i++) {
    const ch = src[i];
    const next = src[i + 1] ?? "";
    if (lineComment) { if (ch === "\n") lineComment = false; continue; }
    if (blockComment) { if (ch === "*" && next === "/") { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
    if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
  }
  return !quote && !lineComment && !blockComment;
}

function topLevelProperties(call) {
  const open = call.indexOf("{");
  if (open < 0) return [];
  const props = [];
  let start = open + 1;
  let braces = 1;
  let parens = 0;
  let brackets = 0;
  let quote = "";
  let escaped = false;
  for (let i = start; i < call.length; i++) {
    const ch = call[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "{") braces++;
    else if (ch === "}" && --braces === 0) { props.push(call.slice(start, i).trim()); break; }
    else if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
    else if (ch === "," && braces === 1 && parens === 0 && brackets === 0) {
      props.push(call.slice(start, i).trim());
      start = i + 1;
    }
  }
  return props.filter(Boolean);
}

function topLevelArgs(call) {
  const args = [];
  let start = 1;
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  let quote = "";
  let escaped = false;
  for (let i = 1; i < call.length - 1; i++) {
    const ch = call[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
    if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (ch === "{") braces++;
    else if (ch === "}") braces--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
    else if (ch === "," && parens === 0 && braces === 0 && brackets === 0) {
      args.push(call.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(call.slice(start, -1).trim());
  return args.filter(Boolean);
}

function isInstallCall(name, call) {
  if (name === "installChecksForClass") return true;
  const options = topLevelArgs(call)[0] ?? "";
  if (!options.trimStart().startsWith("{")) return true;
  const props = topLevelProperties(options);
  if (props.some((prop) => prop.startsWith("...") || prop.startsWith("["))) return true;
  const profile = props.find((prop) => /^profile\b/.test(prop));
  if (!profile) return false;
  return !/^profile\s*:\s*(["'])activation\1\s*$/.test(profile);
}

function hasInjectedSeam(name, call) {
  const args = topLevelArgs(call);
  const options = name === "runDoctor" ? args[0] : args[1];
  if (!options) return false;
  return topLevelProperties(options).some((prop) => {
    const uncommented = prop.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*(?:\n|$)/g, "").trim();
    return /^skillsDirCheck(?:\s*:|\s*$)/.test(uncommented);
  });
}

function callsIn(file) {
  const src = readFileSync(file, "utf8");
  const calls = [];
  for (const name of CALL_NAMES) {
    const pattern = new RegExp(`\\b${name}\\s*(?:(?:/\\*[\\s\\S]*?\\*/|//[^\\n]*\\n)\\s*)?\\(`, "g");
    for (const match of src.matchAll(pattern)) {
      const at = match.index;
      if (!isCodePosition(src, at)) continue;
      const prefix = src.slice(Math.max(0, at - 40), at);
      if (/function\s+$/.test(prefix) || /(?:export\s+)?const\s+$/.test(prefix)) continue;
      const open = at + match[0].lastIndexOf("(");
      const call = balancedCall(src, open);
      const line = src.slice(0, at).split("\n").length;
      const nearby = src.slice(Math.max(0, src.lastIndexOf("\n", at - 350)), at);
      calls.push({
        name,
        call,
        line,
        tail: src.slice(open + call.length, open + call.length + 160),
        marker: nearby.match(/INSTALL-SEAM-LIVE-OK\(([A-Z]+-\d+)\)\s*:\s*(.+)/),
      });
    }
  }
  return calls;
}

const FILES = sourceFiles(SCRIPTS_DIR);
const ALL_CALLS = FILES.flatMap((file) => callsIn(file).map((call) => ({
  ...call,
  file: relative(SCRIPTS_DIR, file),
})));
// doctor.mjs owns the implementation and deliberately supplies the live default;
// consumer sites across the rest of the tree are the hermeticity boundary.
const VIOLATIONS = ALL_CALLS.filter((site) => site.file !== "execution-core/doctor.mjs"
  && isInstallCall(site.name, site.call) && !hasInjectedSeam(site.name, site.call));

test("every install-profile call site injects the skillsDirCheck seam", () => {
  const counts = new Map();
  for (const site of VIOLATIONS) counts.set(site.file, (counts.get(site.file) ?? 0) + 1);
  const found = [...counts].map(([file, count]) => `${file} x${count}`).sort();
  const allowed = ALLOWLIST.map(({ file, count }) => `${file} x${count}`).sort();
  expect(found).toEqual(allowed);
});

test("the scan is anchored: it finds the definition and real doctor test calls", () => {
  const doctor = readFileSync(join(SCRIPTS_DIR, "execution-core", "doctor.mjs"), "utf8");
  expect(doctor).toMatch(/function\s+installChecksForClass\s*\(/);
  expect(ALL_CALLS.filter((site) => site.file === "execution-core/doctor.test.mjs").length).toBeGreaterThan(0);
});

test("the walk covers sibling files and excludes only this guard", () => {
  expect(FILES).toContain(join(SCRIPTS_DIR, "execution-core", "doctor.test.mjs"));
  expect(FILES).toContain(join(SCRIPTS_DIR, "execution-core", "doctor.mjs"));
  expect(FILES).not.toContain(GUARD_FILE);
});

test("each allowlisted site carries a substantive marker", () => {
  for (const entry of ALLOWLIST) {
    expect(entry.ticket).toMatch(/^[A-Z]+-\d+$/);
    expect(entry.reason.length).toBeGreaterThan(40);
  }
  for (const site of VIOLATIONS) {
    expect(site.marker?.[1]).toBe("CAT-251");
    expect(site.marker?.[2].trim().length ?? 0).toBeGreaterThan(10);
  }
});

test("the exemptions remain bound to their non-executing site identities", () => {
  const sites = VIOLATIONS.filter((site) => site.file === "execution-core/doctor.test.mjs");
  const shortCircuit = sites.filter((site) => /recognized\s*:\s*false/.test(site.call));
  const stringifyOnly = sites.filter((site) => /^\s*\.map\(\(f\)\s*=>\s*f\.toString\(\)\)/.test(site.tail));
  expect(shortCircuit).toHaveLength(1);
  expect(stringifyOnly).toHaveLength(1);
  expect(shortCircuit[0].line).not.toBe(stringifyOnly[0].line);
});

test("the marker cannot self-exempt a non-allowlisted file", () => {
  const allowed = new Set(ALLOWLIST.map(({ file }) => file));
  const stray = FILES.filter((file) => !allowed.has(relative(SCRIPTS_DIR, file)))
    .filter((file) => /INSTALL-SEAM-LIVE-OK\(/.test(readFileSync(file, "utf8")))
    .map((file) => relative(SCRIPTS_DIR, file));
  expect(stray).toEqual([]);
});

describe("the classifier's own coverage", () => {
  const install = [
    `runDoctor({ profile: "install", log })`,
    `runDoctor({ profile: 'install', log })`,
    `runDoctor({ profile, log })`,
    `runDoctor({ profile: PROFILE_INSTALL, log })`,
    `runDoctor({ [key]: "install", log })`,
    `runDoctor({ ...opts })`,
    ["installChecksForClass", "(nc)"].join(""),
    ["installChecksForClass", "(nc, { log })"].join(""),
    `runDoctor(\n  { profile: "install", log },\n)`,
    `runDoctor /* formatter-safe */ ({ profile: "install", log })`,
    `runDoctor\n({ profile: "install", log })`,
    `runDoctor(opts)`,
  ];
  const nonInstall = [
    `runDoctor({ log, json: true })`,
    `runDoctor({ profile: "activation", log })`,
    `runDoctor({ nested: { profile: "install" }, log })`,
  ];
  test("requires the seam for every indirect and wrapped install shape", () => {
    for (const fixture of install) {
      const name = fixture.startsWith("runDoctor") ? "runDoctor" : "installChecksForClass";
      expect(isInstallCall(name, fixture.slice(fixture.indexOf("(")))).toBe(true);
    }
  });
  test("does not classify provably non-install calls", () => {
    for (const fixture of nonInstall) expect(isInstallCall("runDoctor", fixture.slice(fixture.indexOf("(")))).toBe(false);
  });
  test("only a top-level option property satisfies seam injection", () => {
    expect(hasInjectedSeam("runDoctor", `({ profile: "install", skillsDirCheck })`)).toBe(true);
    expect(hasInjectedSeam("installChecksForClass", `(nc, { skillsDirCheck: stub })`)).toBe(true);
    expect(hasInjectedSeam("runDoctor", `({ profile: "install", note: "skillsDirCheck" })`)).toBe(false);
    expect(hasInjectedSeam("runDoctor", `({ profile: "install", nested: { skillsDirCheck } })`)).toBe(false);
  });
});
