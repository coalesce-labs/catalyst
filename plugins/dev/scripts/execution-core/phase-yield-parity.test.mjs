// phase-yield-parity.test.mjs — CTL-1854: the JS contract vs its bash mirror.
//
// Run: cd plugins/dev/scripts/execution-core && bun test phase-yield-parity.test.mjs
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// `lib/phase-yield.mjs` owns the yielded-status string. The writer that produces
// it — `phase-agent-emit-complete` — is bash and CANNOT import the module, so it
// carries a hand-written copy of the literal. That is the same one-registry /
// unavoidable-mirror shape as `lib/secret-contract.mjs` and CTL-1789's
// `ASSERTED_BY`, and it gets the same treatment: the copy is held byte-identical
// MECHANICALLY, not by a comment asking the next editor to remember.
//
// The failure this prevents is silent in the worst direction. If the bash writer
// emits "awaiting_work" while the reader expects "awaiting-work", the reader's
// `String(sig.status) !== YIELDED_STATUS` check falls through to "not-yielded",
// the runner writes the abandoned terminal, and the agent's correctly-declared
// yield is discarded — i.e. the drift reintroduces EXACTLY the CTL-1854 defect
// this ticket fixes, while every test that mocks the signal shape stays green.
//
// ⚠️ Each anchor matches on the FLAG/CASE-LABEL, never on the value, and every
// assertion fails CLOSED when its anchor disappears. A rename on one side alone
// must fail here rather than quietly reclassifying a live yield as an abandon.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { YIELDED_STATUS } from "../lib/phase-yield.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMIT = join(HERE, "..", "phase-agent-emit-complete");
const src = readFileSync(EMIT, "utf8");

describe("the bash writer mirrors the JS contract", () => {
  test("the yield case label maps to exactly YIELDED_STATUS", () => {
    // Anchor: the `yield)` case arm in the STATUS -> NEW_STATUS map.
    const m = src.match(/^\s*yield\)\s*NEW_STATUS="([^"]*)"/m);
    expect(m, `no 'yield) NEW_STATUS=' arm found in ${EMIT} — anchor gone, not passing by default`)
      .not.toBeNull();
    expect(m[1]).toBe(YIELDED_STATUS);
  });

  test("the anchor test above can actually fail", () => {
    // Positive control for the regex itself: the same pattern must NOT match a
    // renamed label, so a green result above is evidence and not a vacuous match.
    const renamed = src.replace(/^(\s*)yield\)(\s*NEW_STATUS=)/m, "$1yeild)$2");
    expect(renamed).not.toBe(src); // the substitution really happened
    expect(renamed.match(/^\s*yield\)\s*NEW_STATUS="([^"]*)"/m)).toBeNull();
  });

  test("`yield` is an accepted --status value", () => {
    // A correct mapping is useless if the arg validator rejects the status first.
    const m = src.match(/^case "\$STATUS" in\n([a-z |-]+)\)\s*;;/m);
    expect(m, "no '--status' validation case found — anchor gone").not.toBeNull();
    expect(m[1].split("|").map((s) => s.trim())).toContain("yield");
  });

  test("a yield is NOT terminal — completedAt must stay unset", () => {
    // The whole point is a resumable, non-terminal wait. If `yield` ever falls
    // through to the SET_COMPLETED branch the slot frees and the ticket advances
    // on a phase that never finished.
    const m = src.match(/if \[\[ \$STATUS == "turn-cap-exhausted"(.*?)\]\]; then\n\t*SET_COMPLETED='\.'/s);
    expect(m, "no non-terminal SET_COMPLETED branch found — anchor gone").not.toBeNull();
    expect(m[1]).toContain('$STATUS == "yield"');
  });

  test("the writer stamps both the per-yield and the episode anchor", () => {
    // classifyYield reads `yieldedAt` (rewritten per yield) and `firstYieldedAt`
    // (set once per episode). A writer that emits only the first silently removes
    // the cumulative bound: re-yielding would extend the hold indefinitely.
    expect(src).toContain(".yieldedAt = \\$ts");
    expect(src).toContain(".firstYieldedAt = (.firstYieldedAt // \\$ts)");
  });

  test("a non-yield write clears both anchors", () => {
    // Stale anchors on a done/failed signal are not read by classifyYield (it
    // gates on status first), but leaving them lets a LATER yield inherit a spent
    // episode — expiring a legitimate wait the instant it is declared.
    const m = src.match(/else del\(\.yieldedAt\)(.*?)end\)/);
    expect(m, "no clear-on-non-yield branch found — anchor gone").not.toBeNull();
    expect(m[1]).toContain("del(.firstYieldedAt)");
  });
});
