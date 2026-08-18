// ask-verbs.test.mjs — CTL-1922 increment 2.
//
// The fixtures below are the shapes that FAILED IN PRODUCTION, not invented ones. CTC-653
// measured that every ask a human filed on 2026-08-17 — CTC-648/649/650/651, CTL-1919,
// CTL-1923..1927 — wrote its options inline as `OPTIONS: (A) … (B) …` instead of a
// bulleted `**Options:**` block. Those parsed to ZERO options, so no reply could ever
// match and the ask was structurally undecidable while looking well-formed on the board.

import { describe, expect, test } from "bun:test";
import {
  buildAskBody,
  missingBlocksFrom,
  parseAskOptions,
  teamPrefixMismatch,
  verifyAskBody,
} from "../ask.mjs";

describe("buildAskBody renders the shape the trigger parses", () => {
  test("a full ask round-trips through the parser", () => {
    const body = buildAskBody({
      why: "the fleet cannot write without it",
      options: ["mint a new key", "reuse the existing org key", "do nothing tonight"],
      defaultIfSilent: "reuse the existing org key at 09:00",
    });
    expect(parseAskOptions(body)).toEqual([
      "mint a new key",
      "reuse the existing org key",
      "do nothing tonight",
    ]);
  });

  test("the Default-if-silent line ends the list rather than joining it", () => {
    const body = buildAskBody({ why: "w", options: ["a", "b"], defaultIfSilent: "b at 09:00" });
    expect(parseAskOptions(body)).toEqual(["a", "b"]);
  });

  test("an option-less ask parses to no options, and that is legitimate", () => {
    const body = buildAskBody({
      why: "just tell me when you have looked",
      defaultIfSilent: "nothing",
    });
    expect(parseAskOptions(body)).toEqual([]);
  });
});

describe("the production failure shapes", () => {
  test("⛔ the inline form humans actually wrote is READ, not silently dropped", () => {
    // This is the CTC-653 body class verbatim in shape.
    const body =
      "**Why:** something\n\nOPTIONS: (A) keep two (B) add a third\n\n**Default if silent:** keep two";
    expect(parseAskOptions(body)).toEqual(["keep two", "add a third"]);
  });

  test("a single `(A)` on the header line is prose, not an enumeration", () => {
    // Trusted only at >= 2 — otherwise a sentence mentioning "(A)" becomes a one-option ask.
    const body = "**Why:** w\n\nOptions: (A) only one thing here\n";
    expect(parseAskOptions(body).length).not.toBe(2);
  });

  test("⛔ the bare `Options:` header does not eat the canonical bold form", () => {
    // The regression the alternation-free pattern exists to prevent: a bare-`Options:`
    // alternative matched at the preceding newline, consumed `\n**Options:`, and left `**`
    // as the first line — not an item — ending the list at ZERO.
    const body = "**Why:** w\n\n**Options:**\n- alpha\n- beta\n\n**Default if silent:** alpha";
    expect(parseAskOptions(body)).toEqual(["alpha", "beta"]);
  });

  test("lettered bullet forms are read", () => {
    for (const form of [
      "A. alpha\nB. beta",
      "A) alpha\nB) beta",
      "A: alpha\nB: beta",
      "* alpha\n* beta",
    ]) {
      expect(parseAskOptions(`**Options:**\n${form}\n`)).toEqual(["alpha", "beta"]);
    }
  });
});

describe("verifyAskBody — the round trip, and why [] is never quietly accepted", () => {
  test("intended options that survive storage verify ok", () => {
    const body = buildAskBody({ why: "w", options: ["a", "b"], defaultIfSilent: "a" });
    expect(verifyAskBody({ intendedOptions: ["a", "b"], storedBody: body }).ok).toBe(true);
  });

  test("⛔ options written but ZERO parsed back is a hard failure, not an option-less ask", () => {
    // The exact CTC-653 outcome: the ticket exists, the board shows it, and no reply can
    // ever be recognised. `[]` is ambiguous — "no options" or "unreadable options" — so a
    // caller that MEANT to write options must treat it as a defect.
    const mangled = "**Why:** w\n\nOptions are: pick a or b\n\n**Default if silent:** a";
    const v = verifyAskBody({ intendedOptions: ["a", "b"], storedBody: mangled });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("options-unreadable");
  });

  test("an ask that never had options is not failed for having none", () => {
    const v = verifyAskBody({ intendedOptions: [], storedBody: "**Why:** w" });
    expect(v.ok).toBe(true);
  });

  test("a truncated option list is caught by count", () => {
    const stored = "**Options:**\n- a\n\n**Default if silent:** a";
    const v = verifyAskBody({ intendedOptions: ["a", "b"], storedBody: stored });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("option-count-mismatch");
  });

  test("silently altered option TEXT is caught", () => {
    const stored = "**Options:**\n- a\n- BETA\n\n**Default if silent:** a";
    const v = verifyAskBody({ intendedOptions: ["a", "b"], storedBody: stored });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe("option-text-mismatch");
  });

  test("⛔ CONTROL: the verifier is not simply refusing everything", () => {
    // Same function, same fixture family, one differing input — otherwise every assertion
    // above would pass against a verifier hard-wired to return false.
    const good = buildAskBody({ why: "w", options: ["a", "b"], defaultIfSilent: "a" });
    expect(verifyAskBody({ intendedOptions: ["a", "b"], storedBody: good }).ok).toBe(true);
    expect(verifyAskBody({ intendedOptions: ["a", "b"], storedBody: good }).reason).toBe(null);
  });
});

describe("⛔ Codex #3509 P1 — the ask must be on the team we asked for", () => {
  test("a matching prefix is not a mismatch", () => {
    expect(teamPrefixMismatch("CTL", "CTL-1940")).toBe(false);
    expect(teamPrefixMismatch("ctl", "CTL-1940")).toBe(false);
  });

  test("a default-team fallback IS caught", () => {
    // `--team CTL` silently filing on ENG is the czottmann/linearis#56 shape: it reports
    // success, and the ask sits on a board nobody watching CTL will ever open.
    expect(teamPrefixMismatch("CTL", "ENG-12")).toBe(true);
  });

  test("⛔ a UUID team is NOT checked — it carries no prefix to compare", () => {
    // Guessing one would reject every correct UUID-scoped create.
    expect(teamPrefixMismatch("f317bf00-653d-48d8-8a8b-1656b3534d7a", "CTL-1")).toBe(false);
  });
});

describe("⛔ Codex #3509 P2 — every requested blocking relation is verified", () => {
  test("relations present in the read-back are not reported missing", () => {
    expect(missingBlocksFrom(["CTL-1", "CTL-2"], '{"relations":["CTL-1","CTL-2"]}')).toEqual([]);
  });

  test("the dropped-all-but-last shape is caught and NAMED", () => {
    // linearis keeps only the LAST --blocks on some versions, so the command would exit 0
    // while CTL-1 remained formally unblocked.
    expect(missingBlocksFrom(["CTL-1", "CTL-2"], '{"relations":["CTL-2"]}')).toEqual(["CTL-1"]);
  });

  test("no blocks requested is not a failure", () => {
    expect(missingBlocksFrom([], "{}")).toEqual([]);
  });

  test("an unreadable read-back reports them all missing rather than none", () => {
    // Fail toward "say something is wrong", not toward a silent all-clear.
    expect(missingBlocksFrom(["CTL-1"], null)).toEqual(["CTL-1"]);
  });
});
