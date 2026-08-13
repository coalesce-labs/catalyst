#!/usr/bin/env node
// check-import-graph.mjs (CTL-1825) — prove the agent's module graph is loadable by the
// runtime that actually runs it: plain `node`, from a launchd plist, with no node_modules.
//
// ─── WHY THIS FILE EXISTS AND WHAT IT REPLACES ────────────────────────────────
//
// CTL-1825 gave the agent its one execution-core import (`checkout-sync.mjs`'s root
// enumeration), and shipped a CI step to guard the "bare node, zero npm deps" rule that
// import stretches:
//
//     bun build --target=node catalyst-agent.mjs --outfile=/dev/null
//
// That guard CANNOT FAIL for the class it claims to catch. Measured, not assumed: adding a
// side-effectful `import { Database } from "bun:sqlite"` to `build-info.mjs` leaves that
// command at exit 0, emitting a bundle that still contains the `bun:sqlite` specifier —
// while `node -e 'import("./build-info.mjs")'` on the same tree fails with
// ERR_UNSUPPORTED_ESM_URL_SCHEME. A bundler resolves `bun:*` as an external and a tree-shaken
// import is dropped entirely, so `bun build` answers "can this be bundled", which is not the
// question. A guard that cannot fail is worse than no guard — it is affirmative evidence of
// safety where none exists, which is the exact defect CTL-1825 is about. So it is replaced,
// not patched, by the two checks below, which use the real runtime as the instrument.
//
// ─── THE TWO CHECKS ───────────────────────────────────────────────────────────
//
// 1. LOADABILITY. Every agent module is `import()`ed under this process's runtime (CI runs it
//    with `node`). Anything the runtime cannot resolve — `bun:*`, a missing sibling, a syntax
//    error, a transitive import into `execution-core/config.mjs`'s `bun:sqlite` graph — throws
//    here exactly as it would at 3am on a launchd tick. Every `*.mjs` in this directory is
//    imported directly, not just the entry point, because the four domain samplers are reached
//    only through LAZY `import()` at tick time: importing `catalyst-agent.mjs` alone would
//    exercise none of them, and `build-info.mjs` (the CTL-1825 edge) is behind one of them.
//
// 2. SPECIFIER AUDIT. The transitive static-import graph is walked and every non-relative
//    specifier must be `node:`-prefixed. This is not redundant with (1) — it is the check that
//    carries the dependency-free contract, and (1) cannot. Check (1) is only as strict as the
//    machine it runs on, and the CI job that runs this file installs the workspace's
//    node_modules SEVERAL STEPS EARLIER, so on the runner `pino` (and every other hoisted
//    package) RESOLVES: an `import ... from "pino"` added to any agent module loads fine under
//    (1) and dies on a launchd tick. The audit is a statement about the SOURCE, so it holds on
//    any machine, node_modules present or not.
//
// Both checks are gated on their own non-vacuity (see ASSERTIONS below): a walk that visits
// nothing passes every "no bad specifier found" test there is, and reporting that as a clean
// result would reproduce this ticket's defect inside the guard for it.
//
// The audit keeps EVERY occurrence of an external specifier, not one row per specifier name.
// Keyed by name alone, the allowed dynamic `pino` import would occupy the only slot `pino` has
// and hide every later import of it — the same "first sample stands in for the population"
// shape as the gauge this ticket is about.
//
// Run: node check-import-graph.mjs      (exit 0 = clean, 1 = violation, 2 = the check itself
//                                        could not run)

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, relative, resolve } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// Floors for the non-vacuity gates. Deliberately well below the real counts (currently 10
// agent modules and 12 graph files) so ordinary growth never trips them — they exist to catch
// an enumeration that has silently gone to zero or near-zero, not to pin exact numbers.
const MIN_AGENT_MODULES = 6;
const MIN_GRAPH_FILES = 8;

// The cross-directory leaves CTL-1825 introduced. The walk MUST reach both: they are the only
// files outside this directory in the agent's graph, and they are the whole reason this check
// is stricter than it used to need to be. If a refactor drops the edge, this check must stop
// claiming to guard it rather than silently guarding nothing.
const REQUIRED_GRAPH_MEMBERS = ["execution-core/checkout-sync.mjs", "lib/secret-contract.mjs"];

// Static `import`/`export ... from` specifiers, plus dynamic `import("literal")`. Anchored at
// a line start (after optional indentation) so a specifier quoted inside a `//` comment — of
// which this codebase has many — is not counted as an edge. Dynamic imports built from a
// non-literal (`import(new URL("./host.mjs", import.meta.url).href)`, which is how the agent
// loads its domain samplers) are invisible to any static scan; check (1) covers those by
// importing every module in this directory directly.
const SPECIFIER_PATTERNS = [
  { kind: "static", re: /(?:^|\n)[ \t]*import\s+(?:[^'"();]*?\sfrom\s+)?['"]([^'"]+)['"]/g },
  { kind: "static", re: /(?:^|\n)[ \t]*export\s+[^'"();]*?\sfrom\s+['"]([^'"]+)['"]/g },
  { kind: "dynamic", re: /import\(\s*['"]([^'"]+)['"]\s*\)/g },
];

// The one declared npm dependency, and it is OPTIONAL by construction. `config.mjs` wraps
// `await import("pino")` in a try/catch and substitutes a console shim with the same surface;
// the shim IS the agent's expected steady state, since the launchd runtime has no
// node_modules (CTL-1418 turned the fallback notice down to debug for exactly that reason).
//
// The distinction the allowlist encodes is real and not a courtesy: a STATIC bare specifier
// aborts module load outright and nothing downstream gets a say, while a dynamic one is an
// expression whose failure the caller can catch — and here does. Anything else, static or
// dynamic, fails: an unguarded second npm import is how "zero npm deps" stops being true
// without anyone noticing.
//
// So each row pins ONE import by its IDENTITY, never by its name: file, kind, and proof that
// it sits inside a `try {} catch` that can absorb the failure. A row is spent by the first
// occurrence that matches it in full, and a spent row exempts nothing else — a second
// `import("pino")`, guarded or not, in config.mjs or anywhere else, has no row left to inherit
// and fails. An UNMATCHED row fails too: if the guarded import is deleted or moved, this file
// must stop advertising an exemption it is no longer describing.
const OPTIONAL_DYNAMIC_DEPS = [
  { spec: "pino", kind: "dynamic", file: "config.mjs", guard: "try/catch" },
];

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

function specifiersIn(source) {
  const out = [];
  for (const { kind, re } of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) {
      // The static patterns anchor on the preceding newline, so step past it to land on the
      // `import`/`export` keyword itself — the index is what the line number and the
      // guard-range containment test below are both computed from.
      const index = m.index + (m[0].startsWith("\n") ? 1 : 0);
      out.push({ spec: m[1], kind, index, line: lineOf(source, index) });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

// ── Guard proof ───────────────────────────────────────────────────────────────
// An exemption is only granted to an import whose failure something actually catches, so the
// scanner has to answer "is this occurrence lexically inside a `try {} catch`?". Both helpers
// below fail CLOSED: anything they cannot parse confidently reports "not guarded", which
// DENIES the exemption and fails the check loudly, rather than granting one it cannot justify.

// blankNonCode — replace the CONTENTS of comments, strings, and template literals with spaces,
// preserving length (so indices still line up) and newlines (so line numbers still do). Brace
// arithmetic then sees only code: a `}` inside a string or a `// try {` in a comment cannot
// move the depth. `reliable` is false when the braces do not balance, which is the signal that
// something (an unhandled construct, a regex literal containing a quote) desynced the scan.
function blankNonCode(source) {
  const out = [...source];
  const blank = (i) => {
    if (i < out.length && out[i] !== "\n") out[i] = " ";
  };
  const stack = [{ template: false, depth: 0, substitution: false }];
  let i = 0;
  while (i < source.length) {
    const top = stack[stack.length - 1];
    const c = source[i];
    const d = source[i + 1];
    if (top.template) {
      if (c === "\\") {
        blank(i);
        blank(i + 1);
        i += 2;
      } else if (c === "`") {
        blank(i);
        i += 1;
        stack.pop();
      } else if (c === "$" && d === "{") {
        // A `${}` substitution is code, but its braces are the template's, not the program's —
        // blank them and track the nesting on the stack so they never reach the depth counter.
        blank(i);
        blank(i + 1);
        i += 2;
        stack.push({ template: false, depth: 0, substitution: true });
      } else {
        blank(i);
        i += 1;
      }
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < source.length && source[i] !== "\n") blank(i++);
      continue;
    }
    if (c === "/" && d === "*") {
      blank(i);
      blank(i + 1);
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) blank(i++);
      blank(i);
      blank(i + 1);
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      blank(i++);
      while (i < source.length) {
        if (source[i] === "\\") {
          blank(i);
          blank(i + 1);
          i += 2;
          continue;
        }
        if (source[i] === c || source[i] === "\n") {
          blank(i++);
          break;
        }
        blank(i++);
      }
      continue;
    }
    if (c === "`") {
      blank(i++);
      stack.push({ template: true });
      continue;
    }
    if (c === "{") {
      top.depth += 1;
      i += 1;
      continue;
    }
    if (c === "}") {
      if (top.depth === 0 && top.substitution) {
        blank(i++);
        stack.pop();
        continue;
      }
      top.depth -= 1;
      i += 1;
      continue;
    }
    i += 1;
  }
  const balanced = stack.length === 1 && stack[0].depth === 0;
  return { text: out.join(""), reliable: balanced };
}

// tryCatchRanges — the [openBrace, closeBrace] span of every `try { … }` that is followed by a
// `catch`. A `try/finally` is deliberately NOT a range: `finally` runs the cleanup and then
// re-throws, so it does not make a failed import survivable.
function tryCatchRanges(blanked) {
  const ranges = [];
  for (const m of blanked.matchAll(/\btry\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < blanked.length; i++) {
      if (blanked[i] === "{") depth += 1;
      else if (blanked[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue; // unterminated — no range, so nothing inside it is guarded
    if (!/^\s*catch\b/.test(blanked.slice(close + 1, close + 32))) continue;
    ranges.push([open, close]);
  }
  return ranges;
}

// guardRanges — the file's catchable spans, or NONE if the blanking pass desynced. An
// unreliable scan therefore reports every occurrence as unguarded, which denies the exemption.
function guardRanges(source) {
  const { text, reliable } = blankNonCode(source);
  return reliable ? tryCatchRanges(text) : [];
}

const inRanges = (ranges, index) => ranges.some(([open, close]) => index > open && index < close);

// isGuarded — is the import at `index` inside a `try {} catch` that can absorb its failure?
export function isGuarded(source, index) {
  return inRanges(guardRanges(source), index);
}

// agentModules — every module this directory ships, tests and this file excluded.
export function agentModules() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .map((f) => join(DIR, f))
    .filter((p) => p !== SELF)
    .sort();
}

// walkGraph — follow relative specifiers transitively from every agent module, recording each
// visited file and EVERY non-relative specifier occurrence seen along the way. Occurrences, not
// a specifier→importer map: two imports of the same package are two facts to validate, and the
// second is exactly what an evasion looks like.
export function walkGraph(entries) {
  const visited = new Set();
  const external = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch (err) {
      throw new Error(`unreadable module in the agent graph: ${file} (${err?.message})`);
    }
    // Guard ranges are per-file and only ever needed for a bare specifier, so pay for the
    // blanking pass once, and only in a file that actually has one.
    let ranges = null;
    const guardedAt = (index) => {
      if (ranges === null) ranges = guardRanges(source);
      return inRanges(ranges, index);
    };
    for (const { spec, kind, index, line } of specifiersIn(source)) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        queue.push(resolve(dirname(file), spec));
        continue;
      }
      const bare = !spec.startsWith("node:");
      external.push({ spec, kind, file, line, guarded: bare ? guardedAt(index) : false });
    }
  }
  // Stable order so the reported violation is the same one on every run and every machine —
  // the walk itself is queue-ordered, which is an implementation detail.
  external.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { visited, external };
}

const rel = (p) => relative(DIR, p);

// denialReason — why this particular occurrence gets no exemption. Named precisely, because
// "add it to the allowlist" is the wrong fix for most of these and the message has to say so.
function denialReason(occ, relFile, spentRow) {
  const row = OPTIONAL_DYNAMIC_DEPS.find((e) => e.spec === occ.spec);
  if (!row) return `"${occ.spec}" is not a declared optional dependency`;
  if (occ.kind !== row.kind) {
    return (
      `the declared "${occ.spec}" exemption covers a ${row.kind} import only — a static bare ` +
      `specifier aborts module load outright, so no fallback downstream ever runs`
    );
  }
  if (relFile !== row.file) return `the declared "${occ.spec}" exemption is pinned to ${row.file}`;
  if (!occ.guarded) {
    return `this import is not inside a ${row.guard} that could absorb its failure`;
  }
  return (
    `the declared "${occ.spec}" exemption is already spent by ${spentRow} — one row exempts ` +
    `exactly one import, so a second one cannot inherit it`
  );
}

// classifyExternals — the verdict on EVERY recorded occurrence, plus the stale-row check.
// Pure and exported so a test can assert the counts without staging a whole tree.
export function classifyExternals(occurrences, relOf = (p) => p) {
  const problems = [];
  const exempted = [];
  const spent = OPTIONAL_DYNAMIC_DEPS.map(() => null);
  for (const occ of occurrences) {
    if (occ.spec.startsWith("node:")) continue;
    const relFile = relOf(occ.file);
    const where = `${relFile}:${occ.line}`;
    const row = OPTIONAL_DYNAMIC_DEPS.findIndex(
      (e, i) =>
        spent[i] === null &&
        e.spec === occ.spec &&
        e.kind === occ.kind &&
        e.file === relFile &&
        occ.guarded === true,
    );
    if (row >= 0) {
      spent[row] = where;
      exempted.push(occ);
      continue;
    }
    const already = OPTIONAL_DYNAMIC_DEPS.findIndex((e) => e.spec === occ.spec);
    problems.push(
      `${where} ${occ.kind}-imports "${occ.spec}" — the agent's runtime is bare node with no ` +
        `node_modules, so only node:* is loadable; ` +
        denialReason(occ, relFile, already >= 0 ? spent[already] : null),
    );
  }
  // The other direction: a row that matched nothing is a claim this file can no longer back.
  for (const [i, e] of OPTIONAL_DYNAMIC_DEPS.entries()) {
    if (spent[i] !== null) continue;
    problems.push(
      `the declared "${e.spec}" exemption (${e.kind} import in ${e.file}, inside a ${e.guard}) ` +
        `matched no import in the graph — it was moved, reshaped, or deleted, and this check is ` +
        `advertising a guard it is no longer describing`,
    );
  }
  return { problems, exempted };
}

async function main() {
  const problems = [];

  let modules;
  try {
    modules = agentModules();
  } catch (err) {
    console.error(`check-import-graph: cannot enumerate agent modules: ${err?.message}`);
    process.exit(2);
  }

  // ── ASSERTIONS: non-vacuity first ───────────────────────────────────────────
  // Everything below is a "nothing bad found" test, and every such test passes trivially on an
  // empty input set (`[].every(p)` is `true`). These gates are what make a clean result mean
  // "looked and found nothing" rather than "could not look".
  if (modules.length < MIN_AGENT_MODULES) {
    problems.push(
      `enumerated only ${modules.length} agent module(s) (floor ${MIN_AGENT_MODULES}) — the check would pass vacuously`,
    );
  }

  // ── CHECK 1: loadability under THIS runtime ─────────────────────────────────
  for (const file of modules) {
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      problems.push(`${rel(file)} does not load under ${process.release?.name ?? "this runtime"}: ${err?.message}`);
    }
  }

  // ── CHECK 2: source-level specifier audit ───────────────────────────────────
  let graph;
  try {
    graph = walkGraph(modules);
  } catch (err) {
    console.error(`check-import-graph: ${err?.message}`);
    process.exit(2);
  }

  if (graph.visited.size < MIN_GRAPH_FILES) {
    problems.push(
      `walked only ${graph.visited.size} file(s) (floor ${MIN_GRAPH_FILES}) — the specifier audit would pass vacuously`,
    );
  }
  for (const member of REQUIRED_GRAPH_MEMBERS) {
    const reached = [...graph.visited].some((f) => f.replaceAll("\\", "/").endsWith(`/${member}`));
    if (!reached) {
      problems.push(`the walk never reached ${member} — the edge this check exists to guard is unguarded`);
    }
  }
  // The scanner itself must have parsed something: zero external specifiers across a graph this
  // size means the regexes matched nothing, not that the agent imports nothing (every module in
  // it imports from `node:`).
  if (graph.external.length === 0) {
    problems.push("the specifier scan found no imports at all — it is not parsing this graph");
  }
  const audit = classifyExternals(graph.external, rel);
  problems.push(...audit.problems);

  if (problems.length > 0) {
    console.error("check-import-graph: FAIL");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const exempt = audit.exempted.map((o) => `${rel(o.file)}:${o.line} ${o.spec}`).join(", ");
  console.log(
    `check-import-graph: OK — ${modules.length} agent modules load under ${process.release?.name ?? "this runtime"}; ` +
      `${graph.visited.size} files walked; ${graph.external.length} external import occurrences, ` +
      `all node:* except ${audit.exempted.length} declared-optional (${exempt})`,
  );
}

// Run only when executed, so the helpers above can be unit-tested by importing this file.
// Compared as RESOLVED paths, not as URLs: CI invokes this as `node check-import-graph.mjs`
// from the agent directory, so `argv[1]` is relative — a `file://${argv[1]}` comparison would
// never match and the whole check would silently no-op while still exiting 0.
if (process.argv[1] && resolve(process.argv[1]) === resolve(SELF)) await main();
