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
//    specifier must be `node:`-prefixed. This is not redundant with (1): check (1) is only as
//    strict as the machine it runs on, and a stray `node_modules` anywhere above the checkout
//    would let a bare npm specifier resolve in CI while the launchd runtime — which has none —
//    fails. The audit is a statement about the SOURCE, so it holds on any machine.
//
// Both checks are gated on their own non-vacuity (see ASSERTIONS below): a walk that visits
// nothing passes every "no bad specifier found" test there is, and reporting that as a clean
// result would reproduce this ticket's defect inside the guard for it.
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
const OPTIONAL_DYNAMIC_DEPS = new Set(["pino"]);

function specifiersIn(source) {
  const out = [];
  for (const { kind, re } of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) out.push({ spec: m[1], kind });
  }
  return out;
}

// agentModules — every module this directory ships, tests and this file excluded.
function agentModules() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))
    .map((f) => join(DIR, f))
    .filter((p) => p !== SELF)
    .sort();
}

// walkGraph — follow relative specifiers transitively from every agent module, recording each
// visited file and every non-relative specifier seen along the way.
function walkGraph(entries) {
  const visited = new Set();
  const external = new Map(); // specifier → {kind, file} of the first importer seen
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
    for (const { spec, kind } of specifiersIn(source)) {
      if (spec.startsWith("./") || spec.startsWith("../")) {
        queue.push(resolve(dirname(file), spec));
      } else if (!external.has(spec)) {
        external.set(spec, { kind, file });
      }
    }
  }
  return { visited, external };
}

const problems = [];
const rel = (p) => relative(DIR, p);

let modules;
try {
  modules = agentModules();
} catch (err) {
  console.error(`check-import-graph: cannot enumerate agent modules: ${err?.message}`);
  process.exit(2);
}

// ── ASSERTIONS: non-vacuity first ─────────────────────────────────────────────
// Everything below is a "nothing bad found" test, and every such test passes trivially on an
// empty input set (`[].every(p)` is `true`). These gates are what make a clean result mean
// "looked and found nothing" rather than "could not look".
if (modules.length < MIN_AGENT_MODULES) {
  problems.push(
    `enumerated only ${modules.length} agent module(s) (floor ${MIN_AGENT_MODULES}) — the check would pass vacuously`,
  );
}

// ── CHECK 1: loadability under THIS runtime ───────────────────────────────────
for (const file of modules) {
  try {
    await import(pathToFileURL(file).href);
  } catch (err) {
    problems.push(`${rel(file)} does not load under ${process.release?.name ?? "this runtime"}: ${err?.message}`);
  }
}

// ── CHECK 2: source-level specifier audit ─────────────────────────────────────
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
if (graph.external.size === 0) {
  problems.push("the specifier scan found no imports at all — it is not parsing this graph");
}
for (const [spec, { kind, file }] of graph.external) {
  if (spec.startsWith("node:")) continue;
  if (kind === "dynamic" && OPTIONAL_DYNAMIC_DEPS.has(spec)) continue;
  problems.push(
    `${rel(file)} ${kind}-imports "${spec}" — the agent's runtime is bare node with no ` +
      `node_modules, so only node:* is loadable (an optional dependency must be a guarded ` +
      `dynamic import declared in OPTIONAL_DYNAMIC_DEPS)`,
  );
}

if (problems.length > 0) {
  console.error("check-import-graph: FAIL");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  `check-import-graph: OK — ${modules.length} agent modules load under ${process.release?.name ?? "this runtime"}; ` +
    `${graph.visited.size} files walked; ${graph.external.size} external specifiers, all node:*`,
);
