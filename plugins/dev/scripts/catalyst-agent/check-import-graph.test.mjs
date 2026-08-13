// check-import-graph.test.mjs (CTL-1825) — the guard that enforces the agent's "bare node, no
// node_modules" contract must itself be able to FAIL.
//
// The defect this suite exists to prevent: the audit keyed its external-import table by
// SPECIFIER, so the first `pino` it saw — the allowed, try/catch-guarded dynamic one in
// config.mjs — occupied the only row `pino` had, and a `import pinoStatic from "pino"` in any
// file walked afterwards was never recorded at all. The blanket `OPTIONAL_DYNAMIC_DEPS.has(spec)`
// exemption accepted any new unguarded `import("pino")` on top of that. Neither evasion could be
// caught by the runtime load probe either: the CI job installs the workspace's node_modules
// several steps before this check runs, so on the runner `pino` RESOLVES and both mutations load
// fine — then die on a launchd tick.
//
// Measured against the pre-fix guard on this staged tree: a static `pino` import in accounts.mjs
// exit 0, an unguarded `import("pino")` in host.mjs exit 0, unmutated exit 0. Post-fix: 1, 1, 0.
// Whether the old guard noticed a static import at all was pure walk order — the same mutation
// in build-info.mjs (visited BEFORE config.mjs, so it claimed the specifier's one row first) did
// fail. Coverage that depends on stack order is not coverage.
//
// The staged tree below reproduces that CI premise exactly — a faithful copy of the agent with
// a resolvable `pino` in node_modules — so a passing positive control means the harness is not
// simply failing everything.
//
// Run: cd plugins/dev/scripts/catalyst-agent && bun test check-import-graph.test.mjs

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyExternals, isGuarded, walkGraph, agentModules } from "./check-import-graph.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));

// A stand-in for the real package. Its only job is to make the specifier RESOLVE, which is the
// state the CI runner is in when this check runs — the whole reason the source audit, not the
// load probe, is the check that carries the contract.
const PINO_STUB = `const logger = {
  info() {}, warn() {}, error() {}, debug() {}, fatal() {}, trace() {}, child: () => logger,
};
export default function pino() { return logger; }
`;

// stageTree — a copy of the agent directory that the check can be run against for real, with
// the two cross-directory leaves (execution-core/, lib/) symlinked so the walk still reaches
// them. `mutate(agentDir)` applies the evasion under test before the check runs.
function stageTree(mutate) {
  const root = mkdtempSync(join(tmpdir(), "check-import-graph-"));
  const scripts = join(root, "scripts");
  const agent = join(scripts, "catalyst-agent");
  mkdirSync(agent, { recursive: true });
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith(".mjs") || f.endsWith(".test.mjs")) continue;
    copyFileSync(join(DIR, f), join(agent, f));
  }
  symlinkSync(resolve(DIR, "..", "execution-core"), join(scripts, "execution-core"));
  symlinkSync(resolve(DIR, "..", "lib"), join(scripts, "lib"));
  const pinoDir = join(scripts, "node_modules", "pino");
  mkdirSync(pinoDir, { recursive: true });
  writeFileSync(
    join(pinoDir, "package.json"),
    JSON.stringify({ name: "pino", version: "0.0.0-stub", type: "module", exports: "./index.mjs" }),
  );
  writeFileSync(join(pinoDir, "index.mjs"), PINO_STUB);
  if (mutate) mutate(agent);
  return { root, agent };
}

const append = (agent, file, text) => {
  const p = join(agent, file);
  writeFileSync(p, `${readFileSync(p, "utf8")}\n${text}\n`);
};

// runGuard — exit code + output of the real check, run by the real runtime, against the staged
// tree. `node`, not `process.execPath`: this guard is a statement about node specifically.
function runGuard(mutate) {
  const { root, agent } = stageTree(mutate);
  try {
    const r = spawnSync("node", ["check-import-graph.mjs"], { cwd: agent, encoding: "utf8" });
    // Fail loudly rather than skipping — a check that cannot be run is not a check that passed.
    expect(r.error).toBeUndefined();
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("check-import-graph — positive control", () => {
  test("the real, unmodified tree passes", () => {
    const r = spawnSync("node", ["check-import-graph.mjs"], { cwd: DIR, encoding: "utf8" });
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain("check-import-graph: OK");
    expect(r.status).toBe(0);
  });

  test("the staged copy passes too, with pino installed exactly as CI has it", () => {
    const r = runGuard(null);
    expect(r.out).toContain("check-import-graph: OK");
    expect(r.code).toBe(0);
  });
});

describe("check-import-graph — the two evasions the first-occurrence keying allowed", () => {
  // Evasion (a). accounts.mjs is walked AFTER config.mjs, so before the fix `pino` already had
  // its one row (the guarded dynamic one) by the time this import was read and it was never
  // recorded at all; the load probe resolved it out of the installed node_modules. Measured:
  // exit 0. On launchd it is ERR_MODULE_NOT_FOUND at module load, before anything can catch it.
  test("a STATIC import of pino in a module walked after the allowed dynamic one is rejected", () => {
    const r = runGuard((agent) => append(agent, "accounts.mjs", 'import pinoStatic from "pino";\nexport { pinoStatic };'));
    expect(r.out).toMatch(/accounts\.mjs:\d+ static-imports "pino"/);
    expect(r.out).toContain("covers a dynamic import only");
    expect(r.code).toBe(1);
  });

  // The same mutation in the file that OWNS the exemption. The pre-fix guard also failed this
  // one, but only by accident — within a single file the static pattern is scanned before the
  // dynamic one, so the static import happened to claim the row first. Pinned here so the
  // behaviour no longer depends on which regex runs first.
  test("a STATIC import of pino in config.mjs itself is rejected", () => {
    const r = runGuard((agent) => append(agent, "config.mjs", 'import pinoStatic from "pino";\nexport { pinoStatic };'));
    expect(r.out).toMatch(/config\.mjs:\d+ static-imports "pino"/);
    expect(r.code).toBe(1);
  });

  // Evasion (b). Before the fix the exemption was a bare `Set.has(spec)` test applied to
  // whichever occurrence happened to be recorded, so an unguarded dynamic import of the same
  // package anywhere in the graph was waved through.
  test("a new UNGUARDED dynamic import of pino in another module is rejected", () => {
    const r = runGuard((agent) => append(agent, "host.mjs", 'export const sneak = () => import("pino");'));
    expect(r.out).toMatch(/host\.mjs:\d+ dynamic-imports "pino"/);
    expect(r.out).toContain("pinned to config.mjs");
    expect(r.code).toBe(1);
  });

  test("an unguarded dynamic import of pino in config.mjs itself is rejected — the exemption is not file-wide", () => {
    const r = runGuard((agent) => append(agent, "config.mjs", 'export const sneak = () => import("pino");'));
    expect(r.out).toMatch(/config\.mjs:\d+ dynamic-imports "pino"/);
    expect(r.out).toContain("not inside a try/catch");
    expect(r.code).toBe(1);
  });

  test("even a SECOND guarded dynamic import of pino is rejected — one row, one import", () => {
    const r = runGuard((agent) =>
      append(
        agent,
        "config.mjs",
        'export async function sneak() {\n  try {\n    return await import("pino");\n  } catch {\n    return null;\n  }\n}',
      ),
    );
    expect(r.out).toMatch(/already spent by config\.mjs:\d+/);
    expect(r.code).toBe(1);
  });

  test("deleting the guarded import fails the check instead of silently guarding nothing", () => {
    const r = runGuard((agent) => {
      const p = join(agent, "config.mjs");
      writeFileSync(p, readFileSync(p, "utf8").replace('await import("pino")', "{ default: null }"));
    });
    expect(r.out).toContain("matched no import in the graph");
    expect(r.code).toBe(1);
  });
});

describe("walkGraph — every occurrence is retained, not one row per specifier", () => {
  test("the real graph reports more occurrences than it has distinct specifiers", () => {
    const { external } = walkGraph(agentModules());
    const distinct = new Set(external.map((o) => o.spec));
    // The old map-by-specifier shape could only ever report `distinct.size` rows; the literal
    // gap between these two numbers is the population it was discarding.
    expect(external.length).toBeGreaterThan(distinct.size);
  });

  test("two imports of one specifier in one file are two occurrences", () => {
    const root = mkdtempSync(join(tmpdir(), "walkgraph-"));
    try {
      const f = join(root, "two.mjs");
      writeFileSync(f, 'import a from "pino";\nexport const b = () => import("pino");\n');
      const { external } = walkGraph([f]);
      expect(external.length).toBe(2);
      expect(external.map((o) => o.kind).sort()).toEqual(["dynamic", "static"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("isGuarded — the exemption's proof obligation", () => {
  const at = (src, needle) => src.indexOf(needle);

  test("an import inside try/catch is guarded", () => {
    const src = 'try {\n  const x = await import("pino");\n} catch {}\n';
    expect(isGuarded(src, at(src, 'import("pino")'))).toBe(true);
  });

  test("an import after the catch block is not", () => {
    const src = 'try {\n  noop();\n} catch {}\nconst x = await import("pino");\n';
    expect(isGuarded(src, at(src, 'import("pino")'))).toBe(false);
  });

  test("try/finally is not a guard — finally cleans up and the failure still propagates", () => {
    const src = 'try {\n  const x = await import("pino");\n} finally {\n  done();\n}\n';
    expect(isGuarded(src, at(src, 'import("pino")'))).toBe(false);
  });

  test("a brace inside a string or comment cannot fake a guard", () => {
    const src = 'const s = "try {";\n// try {\nconst x = await import("pino");\n';
    expect(isGuarded(src, at(src, 'import("pino")'))).toBe(false);
  });

  test("a template literal's ${} braces do not desync the scan", () => {
    const src = 'try {\n  const s = `a${b ? "}" : "{"}c`;\n  const x = await import("pino");\n} catch {}\n';
    expect(isGuarded(src, at(src, 'import("pino")'))).toBe(true);
  });
});

describe("classifyExternals — the verdict, without staging a tree", () => {
  const occ = (over) => ({ spec: "pino", kind: "dynamic", file: "config.mjs", line: 1, guarded: true, ...over });

  test("the one declared import is exempt and everything else is a problem", () => {
    const { problems, exempted } = classifyExternals([
      occ({}),
      occ({ line: 2 }),
      occ({ kind: "static", line: 3 }),
      occ({ file: "host.mjs", line: 4 }),
      occ({ guarded: false, line: 5 }),
      { spec: "node:fs", kind: "static", file: "config.mjs", line: 6, guarded: false },
    ]);
    expect(exempted.length).toBe(1);
    expect(problems.length).toBe(4);
  });

  test("an occurrence set with no declared import at all is a problem, not a clean pass", () => {
    const { problems, exempted } = classifyExternals([
      { spec: "node:os", kind: "static", file: "config.mjs", line: 1, guarded: false },
    ]);
    expect(exempted.length).toBe(0);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("matched no import in the graph");
  });
});
