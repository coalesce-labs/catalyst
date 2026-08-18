// cli-header-backtick-guard.test.mjs — CTL-1937.
//
// ⛔ WHY A BACKTICK IN A cli/*.mjs HEADER IS A LOADED WEAPON
//
// These files carry no shebang, and the house style documents each command with a
// backticked example on the first line:
//
//     // cli/drain.mjs — CTL-1095. `catalyst-execution-core drain [--off] [--json]`
//
// Under bash, `//` is NOT a comment and backticks are COMMAND SUBSTITUTION. So executing
// one of these with a shell runs the documented command — which, for a CLI module, is the
// wrapper that runs the module again. Measured 2026-08-17 22:42–23:08 CT: a chain of
// 7,592 `bash` processes, 87% of kern.maxprocperuid, `fork()` failing for every agent on
// the machine for ~25 minutes. The literal `[--off] [--json]` in every `ps` line was the
// doc comment's own words arriving as argv.
//
// #3511 added a DEPTH GUARD to `exec_runtime_module`, which bounds any recursion that goes
// through the CLI wrapper. This test covers what that guard cannot: the hazard still sits
// in the files, and a `cli/*.mjs` reached by a shell through some other path re-arms it.
//
// ── WHAT THIS TEST IS, AND IS NOT ──
// It is NOT a demand to fix 15 files today. It is a RATCHET, in the style of
// `event-name-read-guard.test.mjs`: the current population is frozen as a snapshot and the
// set must match EXACTLY. So
//   • a NEW file with a backticked header fails immediately, and
//   • a FIXED file also fails until its entry is deleted from the snapshot,
// which is what stops the list rotting into a permanent allowlist nobody prunes.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "cli");

/**
 * The header block = every line before the first line of real code. Deliberately not
 * "the first N lines": a header is as long as it is, and a fixed window would both miss a
 * long header's backtick and falsely flag a short header followed by code that legitimately
 * uses template literals.
 */
function headerOf(source) {
  const out = [];
  for (const line of source.split("\n")) {
    if (/^\s*(\/\/|\/\*|\*|$)/.test(line)) {
      out.push(line);
      continue;
    }
    break;
  }
  return out.join("\n");
}

function filesWithBacktickHeaders() {
  return readdirSync(CLI_DIR)
    .filter((f) => f.endsWith(".mjs"))
    .filter((f) => headerOf(readFileSync(join(CLI_DIR, f), "utf8")).includes("`"))
    .sort();
}

/**
 * ⛔ FROZEN SNAPSHOT — measured 2026-08-18, not estimated. Deleting an entry is how a fix
 * is recorded; adding one requires a deliberate edit here and should be argued for in the
 * PR, because every entry is a file that evaluates its own documentation when a shell runs it.
 */
const KNOWN_BACKTICK_HEADERS = Object.freeze([
  "args.mjs",
  "beliefs.test.mjs",
  "branches.mjs",
  "branches.test.mjs",
  "cluster.mjs",
  "drain.mjs",
  "governance-env.mjs",
  "repo.mjs",
  "sessions.mjs",
  "sessions.test.mjs",
  "tidy.mjs",
  "tidy.regression.test.mjs",
  "tidy.test.mjs",
  "worktrees.mjs",
  "worktrees.test.mjs",
]);

describe("cli/*.mjs header backticks (CTL-1937)", () => {
  test("the population matches the snapshot EXACTLY — fails in both directions", () => {
    // Exact equality, not a subset: a subset check would let the list grow silently, and a
    // superset check would let a fixed file linger in the snapshot forever.
    expect(filesWithBacktickHeaders()).toEqual([...KNOWN_BACKTICK_HEADERS]);
  });

  test("⛔ CONTROL: the detector actually detects — a synthetic backtick header is caught", () => {
    // Without this, an empty result would "pass" the ratchet for a detector that never
    // looks at anything. The property under test is the DETECTOR, not the file system.
    const header = headerOf("// a.mjs — run `some-command --flag`\nexport const x = 1;\n");
    expect(header.includes("`")).toBe(true);
  });

  test("⛔ CONTROL: a backtick BELOW the header is not flagged", () => {
    // Template literals in real code are normal and are not the hazard — bash never
    // reaches them, because the header's substitution has already fired.
    const header = headerOf("// a.mjs — plain prose, no examples\nconst q = `select 1`;\n");
    expect(header.includes("`")).toBe(false);
  });

  test("the snapshot is not silently empty", () => {
    // A snapshot that drifted to [] would make the exact-equality test pass against a
    // directory the detector failed to read.
    expect(KNOWN_BACKTICK_HEADERS.length).toBeGreaterThan(0);
    expect(readdirSync(CLI_DIR).filter((f) => f.endsWith(".mjs")).length).toBeGreaterThan(
      KNOWN_BACKTICK_HEADERS.length
    );
  });
});
