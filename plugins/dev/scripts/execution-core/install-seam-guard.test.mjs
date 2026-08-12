// install-seam-guard.test.mjs — CAT-251 findings #1 + #2, hardened by CAT-272.
//
// INVARIANT: every call site selecting the doctor install profile injects the
// `skillsDirCheck` seam. Its live default reads host config and spawns git, while
// non-worker failures downgrade to WARN and can escape ordinary exit-code assertions.
// (doctor.mjs returns the FAIL count only, so an omission is green on a developer Mac
// and red on every CI runner — that divergence turned main red for ~11h on 2026-08-09.)
//
// This guard walks the WHOLE scripts tree and classifies fail-closed: indirect,
// shorthand, computed, and spread profile selection is treated as install unless
// the call proves it has no profile or explicitly selects literal "activation".
//
// CAT-251 supplied the finding-1 mechanism (recursive scan + reachability/polarity
// classifier, replacing an in-file scan that matched the literal `profile: "install"`).
// CAT-272 hardened it three ways and retired the exemptions:
//   * present-but-absent seam values (`skillsDirCheck: undefined`) no longer count as
//     injection — doctor.mjs's destructuring default makes them identical to omission;
//   * the lexer has an explicit fail-CLOSED trust boundary, so a regex-literal desync
//     over-reports instead of silently skipping every later call site in that file;
//   * the single-argument census (`.toBe(2)`) became a named-offender SET assertion.
//     A count cannot see identity: swapping an exempt site for a live one keeps the
//     total at 2 and stays green. Both former exemptions are now injected, so the
//     allowlist is empty and the correct single-argument population is zero.
//
// It REPLACES the in-file CAT-154 seam guard formerly in doctor.test.mjs, which scanned
// only its own source file and therefore needed a self-exclusion region; excluding only
// this file from the walk resolves that structurally instead.
//
// BLIND SPOTS: the argv/exec process boundary in install-lifecycle.mjs (:370, :869)
// selects the profile across a process boundary that no source-text scan can classify;
// dynamically assembled calls such as obj[name](...), imported aliases of either callee,
// options imported through a variable from another file, .cjs sources, and the
// activation profile. The balanced-call parser is deliberately local rather than shared
// with event-log-read-guard.test.mjs so one helper defect cannot silently weaken two
// invariants at once.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD_FILE = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = join(dirname(GUARD_FILE), "..");
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SOURCE_EXT = /\.(?:mjs|js|ts|tsx)$/;
const CALL_NAMES = ["installChecksForClass", "runDoctor"];
// EMPTY IS THE INTENDED TERMINAL STATE (CAT-272). The two former exemptions — the
// `recognized: false` short-circuit and the stringify-only site — were retired by injecting the
// stub at both rather than reasoning about reachability, because reachability is a property of
// doctor.mjs that a future edit can change silently. Adding an entry back requires BOTH an
// in-source INSTALL-SEAM-LIVE-OK(<ticket>) marker AND a written reachability argument; prefer
// injecting the stub, which is free at every site examined so far.
const ALLOWLIST = [];

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

// Single lexer pass shared by position classification and the trust check, so the two can never
// disagree about what this file's lexer believes.
function lexStateAt(src, offset) {
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
  return { quote, lineComment, blockComment };
}

function isCodePosition(src, offset) {
  const { quote, lineComment, blockComment } = lexStateAt(src, offset);
  return !quote && !lineComment && !blockComment;
}

// A file that does not end in a neutral state desynced somewhere (almost always an unescaped
// quote inside a regex literal, which this lexer does not model). Its position classification is
// then unreliable in the fail-OPEN direction, so callers must stop trusting it.
function lexesCleanly(src) {
  const { quote, blockComment } = lexStateAt(src, src.length);
  // A trailing line comment is normal (a file ending without a newline) and is not a desync.
  return !quote && !blockComment;
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

// doctor.mjs:5425 destructures the seam with a LIVE default, so `skillsDirCheck: undefined`
// resolves to the real check — indistinguishable at runtime from omitting the key. A value
// matching this pattern is therefore NOT an injection, even though the key is present.
const ABSENT_SEAM_VALUE = /^(?:undefined|null|void\s+0)$/;

function hasInjectedSeam(name, call) {
  const args = topLevelArgs(call);
  const options = name === "runDoctor" ? args[0] : args[1];
  if (!options) return false;
  return topLevelProperties(options).some((prop) => {
    const uncommented = prop.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*(?:\n|$)/g, "").trim();
    if (!/^skillsDirCheck(?:\s*:|\s*$)/.test(uncommented)) return false;
    // Shorthand (`{ skillsDirCheck }`) binds whatever the surrounding scope holds; there is no
    // literal value to reject here, so it counts as injection.
    const colon = uncommented.indexOf(":");
    if (colon < 0) return true;
    return !ABSENT_SEAM_VALUE.test(uncommented.slice(colon + 1).trim());
  });
}

function callsInSource(src) {
  // Fail-closed: when the lexer desynced we cannot tell code from string, so we stop skipping
  // and classify every match as code. That over-reports rather than silently hiding call sites.
  const trustPositions = lexesCleanly(src);
  const calls = [];
  for (const name of CALL_NAMES) {
    const pattern = new RegExp(`\\b${name}\\s*(?:(?:/\\*[\\s\\S]*?\\*/|//[^\\n]*\\n)\\s*)?\\(`, "g");
    for (const match of src.matchAll(pattern)) {
      const at = match.index;
      if (trustPositions && !isCodePosition(src, at)) continue;
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
const ALL_CALLS = FILES.flatMap((file) => callsInSource(readFileSync(file, "utf8")).map((call) => ({
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
  // Liveness floor. A walk that silently narrows — a bad SKIP_DIRS entry, a thrown readdir
  // swallowed upstream, an extension regex typo — would still pass every assertion above while
  // scanning almost nothing. CTL-1529 round 3 is the precedent: 4 of 16 directories were being
  // enumerated and three unbounded reads sat unnoticed. Measured here: ~1700 files.
  expect(FILES.length).toBeGreaterThan(100);
});

test("each allowlisted site carries a substantive marker", () => {
  for (const entry of ALLOWLIST) {
    expect(entry.ticket).toMatch(/^[A-Z]+-\d+$/);
    expect(entry.reason.length).toBeGreaterThan(40);
  }
  for (const site of VIOLATIONS) {
    expect(site.marker?.[1]).toMatch(/^[A-Z]+-\d+$/);
    expect(site.marker?.[2].trim().length ?? 0).toBeGreaterThan(10);
  }
});

// CAT-272 finding 2. The predecessor tripwire asserted a COUNT of single-argument sites
// (`.toBe(2)`), which cannot see identity: swap one genuinely-exempt site for a live one and the
// count is unchanged, so the guard stays green while the invariant breaks. This asserts a SET and
// names its offenders — a new single-argument site fails regardless of the total.
test("no installChecksForClass call site relies on the live seam default", () => {
  const singleArg = ALL_CALLS
    .filter((site) => site.name === "installChecksForClass" && site.file !== "execution-core/doctor.mjs")
    .filter((site) => topLevelArgs(site.call).length < 2)
    .map((site) => `${site.file}:${site.line}`)
    .sort();
  expect(singleArg).toEqual([]);
});

test("the marker cannot self-exempt a non-allowlisted file", () => {
  const allowed = new Set(ALLOWLIST.map(({ file }) => file));
  const stray = FILES.filter((file) => !allowed.has(relative(SCRIPTS_DIR, file)))
    .filter((file) => /INSTALL-SEAM-LIVE-OK\(/.test(readFileSync(file, "utf8")))
    .map((file) => relative(SCRIPTS_DIR, file));
  expect(stray).toEqual([]);
});

// The lexer trust boundary (fail-closed). `isCodePosition` does not understand regex literals,
// so a regex containing an odd number of quote characters — `/don't/` is the canonical case —
// flips it into a permanent in-string state. Every later call site in that file then reads as
// "inside a string" and is silently SKIPPED: a fail-OPEN hole that hides real violations and
// reports nothing. `lexesCleanly` re-runs the lexer to EOF; if the file does not end in a
// neutral state we stop trusting position classification for that file and treat every match as
// code. Over-reporting is the safe direction — a false positive is visible and arguable, a
// silent skip is neither.
describe("the lexer trust boundary is fail-closed", () => {
  const DESYNC = `const re = /don't/;\nrunDoctor({ profile: "install" });\n`;
  const CLEAN = `const s = "runDoctor({ profile: 'install' })";\n// runDoctor({ profile: "install" })\n`;

  test("a regex literal with an odd quote count is detected as a desync", () => {
    expect(lexesCleanly(DESYNC)).toBe(false);
    expect(lexesCleanly(CLEAN)).toBe(true);
  });

  test("a violation hidden behind a desync is still reported", () => {
    const calls = callsInSource(DESYNC);
    expect(calls.map((c) => c.name)).toEqual(["runDoctor"]);
    expect(isInstallCall("runDoctor", calls[0].call)).toBe(true);
    expect(hasInjectedSeam("runDoctor", calls[0].call)).toBe(false);
  });

  test("a cleanly-lexing file still skips string and comment matches", () => {
    expect(callsInSource(CLEAN)).toEqual([]);
  });

  test("the desync is a live condition in this tree, and costs nothing today", () => {
    const desyncing = FILES.filter((file) => !lexesCleanly(readFileSync(file, "utf8")));
    // If this ever hits zero the fixture above is the only coverage left — that is fine, but the
    // floor below (no desyncing file contains a callee) would then be vacuous, so say so loudly.
    expect(desyncing.length).toBeGreaterThan(0);
    // No desyncing file contains either callee, so the fail-closed over-report currently adds no
    // false positives. If this fails, a real call site sits in an untrustworthy file — inject the
    // seam there rather than narrowing the lexer.
    const withCallee = desyncing
      .filter((file) => CALL_NAMES.some((name) => readFileSync(file, "utf8").includes(`${name}(`)))
      .map((file) => relative(SCRIPTS_DIR, file));
    expect(withCallee).toEqual([]);
  });
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

  // doctor.mjs:5425 destructures `skillsDirCheck = () => checkSkillsDirPlugins(...)`. A
  // destructuring default fires on `undefined` — so a site that passes the key with an absent
  // VALUE gets the LIVE check, exactly as if the key were missing. Matching the key alone is
  // therefore fail-OPEN: it reads the most dangerous shape (present-but-absent) as injected.
  test("a present-but-absent seam value does not count as injection", () => {
    expect(hasInjectedSeam("runDoctor", `({ profile: "install", skillsDirCheck: undefined })`)).toBe(false);
    expect(hasInjectedSeam("runDoctor", `({ profile: "install", skillsDirCheck: void 0 })`)).toBe(false);
    // `null` does NOT trigger the destructuring default — it defeats the live check by making the
    // call throw instead. That is not injection either; it is a different bug.
    expect(hasInjectedSeam("runDoctor", `({ profile: "install", skillsDirCheck: null })`)).toBe(false);
  });

  // The census (`.toBe(2)`) that the zero-single-arg set replaced was ALSO doing anti-vacuity
  // duty: a detector that silently saw nothing still had to produce 2. With the count gone,
  // vacuity has to be excluded positively — the detector must be shown to read arity correctly
  // AND to be looking at real call sites in this tree.
  test("the single-argument detector is live, not vacuous", () => {
    expect(topLevelArgs(`(nc)`)).toHaveLength(1);
    expect(topLevelArgs(`(nc, { skillsDirCheck })`)).toHaveLength(2);
    // The nested-object shape the predecessor heuristic got wrong: a whole-text /,\s*\{/ matched
    // the comma-brace INSIDE argument one and read this as two arguments. Pinned as a test now
    // rather than left as a comment on a deleted helper.
    expect(topLevelArgs(`(nodeClassOf({ class: "worker", extra: { x: 1 } }))`)).toHaveLength(1);
    expect(topLevelArgs(`(nodeClassOf({ a: 1, b: 2 }), { skillsDirCheck: stub })`)).toHaveLength(2);
    // …and it is actually reading real sites, not an empty set.
    const real = ALL_CALLS.filter((s) => s.name === "installChecksForClass" && s.file === "execution-core/doctor.test.mjs");
    expect(real.length).toBeGreaterThan(0);
    expect(real.every((s) => topLevelArgs(s.call).length === 2)).toBe(true);
  });

  test("real seam values are still accepted", () => {
    for (const value of ["stub", "passingSkillsDirCheck", "opts.skillsDirCheck", "() => []", "makeStub()"]) {
      expect(hasInjectedSeam("installChecksForClass", `(nc, { skillsDirCheck: ${value} })`)).toBe(true);
    }
  });
});
