// cli-header-backtick-guard.test.mjs — CTL-1937.
//
// WHY A BACKTICK IN A cli/*.mjs IS A LOADED WEAPON
//
// These files carry no shebang, and the house style documents each command with a
// backticked example on the first line:
//
//     // cli/drain.mjs — CTL-1095. [backticked example of the wrapper command]
//
// Under bash, a leading slash-slash is NOT a comment and backticks are COMMAND
// SUBSTITUTION. So executing one of these with a shell runs the documented command —
// which, for a CLI module, is the wrapper that runs the module again. Measured
// 2026-08-17 22:42-23:08 CT: a chain of 7,592 bash processes, 87% of kern.maxprocperuid,
// fork() failing for every agent on the machine for ~25 minutes. The literal
// "[--off] [--json]" in every ps line was the doc comment's own words arriving as argv.
//
// #3511 added a DEPTH GUARD to exec_runtime_module, which bounds any recursion that goes
// through the CLI wrapper. This test covers what that guard cannot: the hazard still sits
// in the files, and a cli/*.mjs reached by a shell through some other path re-arms it.
//
// -- WHERE BASH ACTUALLY STOPS (measured 2026-08-18, round-1 P1 from Codex) --
// The first cut of this test guarded only "the header", defined as every line before the
// first line of real code, and asserted as a CONTROL that a backtick below the header is
// NOT a hazard. That control was WRONG, and it codified a false negative. Measured with
// harmless `touch <marker>` substitutions, bash 3.2.57 and 5.3.9:
//
//   header backtick, then code            -> FIRED
//   clean header, template literal in code -> FIRED   <- the control claimed "safe"
//   clean header, import, then literal     -> FIRED
//   block comment whose interior prose has no leading star -> FIRED  (round-1 P2)
//   template literal at line 43 of 43      -> FIRED
//   template literal after `export function main(argv) {` -> did NOT fire
//
// Bash does not stop at the end of a comment header. It executes line by line, running
// every substitution it reaches, and stops only at a SYNTAX ERROR — in practice an
// unquoted "(" from a function declaration, an arrow function, or a call. So the guarded
// region is "everything bash parses before it aborts", and the only non-guessing way to
// find that boundary is to ASK BASH: `bash -n` parses without executing and reports the
// abort line. A regex that emulates bash's parser would be its own false-negative machine,
// which is the defect this paragraph exists to record.
//
// Portability: the boundary must not drift between the dev host (macOS /bin/bash 3.2.57)
// and CI (Linux /bin/bash 5.x). Measured across all 25 cli/*.mjs on 2026-08-18: bash 3.2.57
// and bash 5.3.9 reported the IDENTICAL abort line for 25 of 25 files, 0 disagreements.
//
// -- WHAT THIS TEST IS, AND IS NOT --
// It is NOT a demand to fix 12 files today. It is a RATCHET, in the style of
// event-name-read-guard.test.mjs: the current population is frozen as a snapshot and the
// set must match EXACTLY. So
//   - a NEW file with a shell-reachable backtick fails immediately, and
//   - a FIXED file also fails until its entry is deleted from the snapshot,
// which is what stops the list rotting into a permanent allowlist nobody prunes.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "cli");

// Absolute, never PATH-resolved: a restricted-PATH runner is exactly where a PATH-resolved
// helper degrades into a silent no-op, and this detector must fail loudly instead.
const BASH = "/bin/bash";

/**
 * The lines bash evaluates before it aborts, as reported by bash's OWN parser.
 *
 * Returns the source text of lines 1..N where N is the line bash reports a syntax error
 * on, or the whole file when it parses cleanly. Line N is INCLUDED deliberately: bash
 * aborts at command granularity rather than line granularity, so a substitution earlier
 * on the offending line is not provably unreachable. Over-inclusion costs one snapshot
 * entry; under-inclusion is the false negative this function exists to prevent.
 *
 * Throws rather than degrading: an unusable instrument must be INCONCLUSIVE and loud, not
 * an empty result that reads as "no hazards found".
 */
function shellReachablePrefix(absPath) {
  if (!existsSync(BASH)) {
    throw new Error(`INCONCLUSIVE: ${BASH} is absent — cannot derive the shell-reachable prefix`);
  }
  const res = spawnSync(BASH, ["-n", absPath], { encoding: "utf8" });
  if (res.error) {
    throw new Error(`INCONCLUSIVE: could not run ${BASH} -n: ${res.error.message}`);
  }
  const source = readFileSync(absPath, "utf8");
  const lines = source.split("\n");
  if (res.status === 0) return source; // bash parses the whole file, so it reaches every line

  const m = /:\s*line\s+(\d+):/.exec(res.stderr || "");
  // An unrecognised diagnostic means we do not know where bash stopped. Fail toward MORE
  // coverage (treat the whole file as reachable) so an unparsed message can never narrow
  // the guarded region silently.
  if (!m) return source;
  return lines.slice(0, Number(m[1])).join("\n");
}

function filesWithReachableBackticks() {
  return readdirSync(CLI_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => shellReachablePrefix(join(CLI_DIR, f)).includes("`"))
    .sort();
}

/**
 * FROZEN SNAPSHOT — measured 2026-08-18 with the function above, not estimated. Deleting
 * an entry is how a fix is recorded; adding one requires a deliberate edit here and should
 * be argued for in the PR, because every entry is a file that evaluates its own
 * documentation when a shell runs it.
 */
const KNOWN_REACHABLE_BACKTICKS = Object.freeze([
  "branches.mjs",
  "branches.test.mjs",
  "cluster.mjs",
  "drain.mjs",
  "governance-env.mjs",
  "sessions.mjs",
  "sessions.test.mjs",
  "tidy.mjs",
  "tidy.regression.test.mjs",
  "tidy.test.mjs",
  "worktrees.mjs",
  "worktrees.test.mjs",
]);

/** Writes a synthetic fixture. NEVER used on a real cli/*.mjs — see the execution note below. */
function fixture(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

describe("cli/*.mjs shell-reachable backticks (CTL-1937)", () => {
  test("the population matches the snapshot EXACTLY — fails in both directions", () => {
    // Exact equality, not a subset: a subset check would let the list grow silently, and a
    // superset check would let a fixed file linger in the snapshot forever.
    expect(filesWithReachableBackticks()).toEqual([...KNOWN_REACHABLE_BACKTICKS]);
  });

  test("CONTROL: bash -n is a non-executing instrument", () => {
    // If `bash -n` ever executed what it parsed, every run of this suite would fire every
    // substitution in every cli file. Prove it does not, on THIS host's bash, before
    // trusting it. A harmless `touch` of a marker in a temp dir is the whole payload.
    const dir = mkdtempSync(join(tmpdir(), "ctl1937-"));
    const marker = join(dir, "MUST_NOT_EXIST");
    const p = fixture(dir, "probe.mjs", `// probe — run \`touch ${marker}\`\nexport const x = 1;\n`);
    spawnSync(BASH, ["-n", p], { encoding: "utf8" });
    expect(existsSync(marker)).toBe(false);
  });

  test("CONTROL: bash really does execute a substitution below a clean header", () => {
    // The premise the first cut of this test got wrong, asserted live rather than trusted
    // from a laptop measurement — so a bash whose behaviour differs fails HERE, loudly,
    // instead of silently shrinking the guarded region.
    //
    // Executing a SYNTHETIC fixture is safe because its substitution is `touch`. Never do
    // this to a real cli/*.mjs: their substitution is the wrapper that re-runs the module.
    const dir = mkdtempSync(join(tmpdir(), "ctl1937-"));
    const marker = join(dir, "FIRED");
    const p = fixture(
      dir,
      "below.mjs",
      `// below.mjs — plain prose, no examples\nconst USAGE = \`touch ${marker}\`;\n`
    );
    spawnSync(BASH, [p], { encoding: "utf8" });
    expect(existsSync(marker)).toBe(true);
  });

  test("the detector flags a backtick below a clean header", () => {
    // The direct regression for the round-1 P1: the old header-only rule returned a clean
    // prefix here and called the file safe.
    const dir = mkdtempSync(join(tmpdir(), "ctl1937-"));
    const p = fixture(
      dir,
      "below.mjs",
      "// below.mjs — plain prose, no examples\nconst USAGE = `some-command --flag`;\n"
    );
    expect(shellReachablePrefix(p)).toContain("`");
  });

  test("the detector flags a backtick in a block comment with no leading stars", () => {
    // Round-1 P2: the old line-shape regex stopped at "CLI docs" and never saw the backtick.
    // Asking bash removes the regex, so this shape is covered by construction.
    const dir = mkdtempSync(join(tmpdir(), "ctl1937-"));
    const p = fixture(dir, "block.mjs", "/*\nCLI docs\nrun `some-command`\n*/\nexport const x = 1;\n");
    expect(shellReachablePrefix(p)).toContain("`");
  });

  test("the detector flags a backticked header — the original hazard shape", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl1937-"));
    const p = fixture(dir, "hdr.mjs", "// a.mjs — run `some-command --flag`\nexport const x = 1;\n");
    expect(shellReachablePrefix(p)).toContain("`");
  });

  test("the detector does NOT flag a backtick bash provably cannot reach", () => {
    // The one genuine narrowing, and the reason the snapshot is 12 files rather than all of
    // them: bash aborts at the "(" in a function declaration and never reaches the literal
    // below it. Measured: the same shape with a `touch` substitution did not fire.
    const dir = mkdtempSync(join(tmpdir(), "ctl1937-"));
    const p = fixture(
      dir,
      "unreach.mjs",
      "// unreach.mjs\nexport function main(argv) {\n  const q = `select 1`;\n  return q;\n}\n"
    );
    expect(shellReachablePrefix(p)).not.toContain("`");
  });

  test("the snapshot is neither silently empty nor the whole directory", () => {
    // An empty snapshot would make the exact-equality test pass against a directory the
    // detector failed to read; a snapshot equal to the directory would mean the boundary
    // stopped discriminating and the ratchet had degraded into a file listing.
    const all = readdirSync(CLI_DIR).filter((f) => f.endsWith(".mjs"));
    expect(KNOWN_REACHABLE_BACKTICKS.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(KNOWN_REACHABLE_BACKTICKS.length);
  });
});
