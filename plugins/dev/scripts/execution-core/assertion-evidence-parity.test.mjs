// assertion-evidence-parity.test.mjs — CTL-1789 round-1 P2 (Codex).
//
// The writer vocabulary in assertion-evidence.mjs (ASSERTED_BY) has two BASH
// consumers that cannot import it: `phase-agent-emit-complete` hard-codes the
// default `phase-agent-emit-complete`, and `orchestrate-revive` hard-codes
// `revive-synthesized` in its `--asserted-by` flag. Before this file, each side
// was asserted independently — the JS tests pinned the constants, the bash test
// pinned the literal — so a rename on ONE side passed every test while silently
// reclassifying valid DECLARED/FABRICATED terminals as `absent`/`unknown-writer`
// and corrupting the advancement audit this ticket exists to produce.
//
// This is the same shape as lib/secret-contract.mjs and its independently
// maintained bash mirror: one registry, an unavoidable hand-written mirror, and
// a cross-stack parity suite that fails if either half moves alone. A bash
// script cannot import an .mjs constant, so parity is verified mechanically here
// rather than shared by construction.
//
// TWO RULES this file exists to enforce:
//   1. bash literal  == the registered constant   (the cross-language mirror)
//   2. JS writers    use ASSERTED_BY.X, never a re-typed literal (one JS source)
//
// FAIL CLOSED: extraction that finds no anchor — or more than one — is a
// FAILURE, not a skip. A refactor that renames the variable or restructures the
// flag must break this test loudly rather than quietly stop checking anything.
// Every anchor below matches on the VARIABLE / FLAG / ASSIGNMENT TARGET, never
// on the expected value: an anchor containing the value would keep matching
// after a one-sided rename and would therefore prove nothing.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSERTED_BY } from "./assertion-evidence.mjs";

const SCRIPTS_DIR = join(import.meta.dir, "..");
const EMIT_COMPLETE = join(SCRIPTS_DIR, "phase-agent-emit-complete");
const ORCHESTRATE_REVIVE = join(SCRIPTS_DIR, "orchestrate-revive");
const JS_WRITERS = ["recovery.mjs", "sdk-run-phase-agent.mjs"];

// readBash — file contents with whole-line `#` comments removed, so prose that
// merely MENTIONS `--asserted-by` is not mistaken for a call site.
function readBash(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
}

function extractAll(src, re) {
  return [...src.matchAll(re)].map((m) => m[1]);
}

// The wrapper's top-level default assignment. The `--asserted-by` case arm
// (`\t\tASSERTED_BY="$2"`) is indented, so `^` excludes it; the `$`-guard is
// belt-and-braces if that indentation ever changes.
const emitCompleteDefaults = () =>
  extractAll(readBash(EMIT_COMPLETE), /^ASSERTED_BY="([^"\n]*)"$/gm).filter(
    (v) => !v.startsWith("$")
  );

// orchestrate-revive's flag usage, anchored on the flag.
const reviveFlagValues = () =>
  extractAll(readBash(ORCHESTRATE_REVIVE), /--asserted-by[ \t]+([A-Za-z0-9._-]+)/g);

describe("CTL-1789 P2: ASSERTED_BY vocabulary parity — JS registry vs its bash consumers", () => {
  test("phase-agent-emit-complete's default == ASSERTED_BY.PHASE_AGENT", () => {
    const found = emitCompleteDefaults();
    expect(found).toHaveLength(1); // fail closed: exactly one literal to compare
    expect(found[0]).toBe(ASSERTED_BY.PHASE_AGENT);
  });

  test("orchestrate-revive's --asserted-by == ASSERTED_BY.REVIVE_SYNTHESIZED", () => {
    const found = reviveFlagValues();
    expect(found).toHaveLength(1); // fail closed
    expect(found[0]).toBe(ASSERTED_BY.REVIVE_SYNTHESIZED);
  });

  test("every writer id embedded in bash is a REGISTERED id (no unknown-writer drift)", () => {
    // Catches what the per-site expectations above could miss: a bash literal
    // renamed to something the registry does not contain AT ALL. Such an id
    // classifies `absent` / `unknown-writer` in classifySignal — precisely the
    // silent corruption this suite exists to prevent.
    const registered = Object.values(ASSERTED_BY);
    const embedded = [...emitCompleteDefaults(), ...reviveFlagValues()];
    expect(embedded.length).toBeGreaterThan(0); // fail closed on a vanished anchor
    for (const id of embedded) expect(registered).toContain(id);
  });

  test("the JS writers consume the registry symbolically, never a re-typed literal", () => {
    // recovery.mjs and sdk-run-phase-agent.mjs CAN import the constant, so they
    // must — a bare literal there would be a third place to rename. Anchored on
    // the ASSIGNMENT TARGET (`assertedBy =`/`asserted_by:` / the `--asserted-by`
    // argv element), so an unrelated string that merely happens to equal a
    // writer id (sdk-run-phase-agent's `attentionReason = "sdk-backstop"`) is
    // not a match. The rule is "no re-typed STRING LITERAL" — a pass-through
    // variable or a `null` default is fine; `"phase-agent-emit-complete"` is not.
    for (const f of JS_WRITERS) {
      const src = readFileSync(join(import.meta.dir, f), "utf8");
      expect(src).toContain('from "./assertion-evidence.mjs"');
      const assigned = [
        ...extractAll(src, /\bassertedBy\s*[:=]\s*([^,;\n]+)/g),
        ...extractAll(src, /\basserted_by\s*:\s*([^,;\n]+)/g),
        ...extractAll(src, /"--asserted-by",\s*([^,\n]+)/g),
      ].map((s) => s.trim());
      expect(assigned.length).toBeGreaterThan(0); // fail closed
      // No RHS may be a re-typed string literal.
      for (const rhs of assigned) expect(/^["'`]/.test(rhs)).toBe(false);
      // …and the import must actually be load-bearing in this file.
      expect(assigned.some((rhs) => rhs.startsWith("ASSERTED_BY."))).toBe(true);
    }
  });

  test("the registry's ids are unique (a collision would merge two writers' verdicts)", () => {
    const values = Object.values(ASSERTED_BY);
    expect(new Set(values).size).toBe(values.length);
  });
});
