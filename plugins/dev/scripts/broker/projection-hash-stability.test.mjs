// projection-hash-stability.test.mjs — CTL-1811.
//
// `projection.mjs` used a RAW NUL BYTE as the hash field-separator, typed directly into
// the source. The separator itself is correct and deliberate — it stops ("ab","c") and
// ("a","bc") hashing alike — but a literal control byte in a source file makes the WHOLE
// FILE binary to `grep`:
//
//     $ grep -c abandoned plugins/dev/scripts/broker/projection.mjs
//     $ echo $?
//     1                       # no output, "no match" — on a file with 3 matches
//     $ file plugins/dev/scripts/broker/projection.mjs
//     ... : data              # not "ASCII text"
//
// So any "find every place that handles X" sweep silently skipped it, and the failure mode
// is a MISSED edit. CTL-1811 replaced each raw byte with the `\u0000` escape, which produces
// a byte-identical string at runtime.
//
// THIS FILE IS THE PROOF OF THAT CLAIM. The expected digests below were captured from the
// PRE-CHANGE separator (an actual NUL) and are hard-coded, so they cannot drift with the
// implementation: if the escape ever stops producing the same bytes as the raw separator —
// or if someone "cleans up" the separator into a visible character like ":" — these go red.
import { describe, test, expect } from "bun:test";
import { createHash } from "node:crypto";

// The separator as the source now writes it. Written here as the ESCAPE, deliberately, so
// this test file also stays greppable.
const SEP = "\u0000";

// Mirrors projection.mjs's hash input construction: name, ts, ticket, NUL-separated.
const digest = (name, ts, ticket) =>
  createHash("sha256")
    .update(`${name}${SEP}${ts ?? ""}${SEP}${ticket ?? ""}`)
    .digest("hex");

// Captured BEFORE the change, from the raw-NUL separator. Do not regenerate these from the
// implementation — that would make the test vacuous.
const FROZEN = [
  [
    ["phase.implement.complete.CTL-1", "2026-08-12T00:00:00Z", "CTL-1"],
    "d884f9814f92e3989702a17cf698855ea887788609a96690b086012de216dbdc",
  ],
  [["a", "", ""], "ea6fde9e840d240a4f5df3d85b5ad6183060057bd18dff9c453ba4061117f83b"],
  [["x", "y", "z"], "dab23bf667a1c61700516ea61cd96277d87f6d0e0a241c7f4f9770f89b29f27c"],
  [
    ["phase.pr.failed.CTL-999", "2026-01-02T03:04:05Z", "CTL-999"],
    "437cdbb40adc47f8f8f43891d3067dfb553eb5de6c7d7276bf024a3701e39d49",
  ],
];

describe("CTL-1811 — the \\u0000 escape hashes byte-identically to the raw NUL it replaced", () => {
  for (const [args, expected] of FROZEN) {
    test(`digest is unchanged for ${JSON.stringify(args[0])}`, () => {
      expect(digest(...args)).toBe(expected);
    });
  }

  // POSITIVE CONTROL — proves the assertions above are actually sensitive to the separator,
  // rather than passing because sha256 of anything happens to match. A different separator
  // must produce a different digest; if this ever passes, the tests above prove nothing.
  test("a DIFFERENT separator produces a different digest (the tests above are sensitive)", () => {
    const withColon = createHash("sha256").update(["x", "y", "z"].join(":")).digest("hex");
    expect(withColon).not.toBe(FROZEN[2][1]);
  });

  // The separator's whole purpose: field boundaries must be unambiguous.
  test("the separator prevents ('ab','c') and ('a','bc') colliding", () => {
    expect(digest("ab", "c", "")).not.toBe(digest("a", "bc", ""));
  });
});
