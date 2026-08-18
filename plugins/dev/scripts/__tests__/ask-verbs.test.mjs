// ask-verbs.test.mjs — CTL-1922 increment 2.
//
// The fixtures below are the shapes that FAILED IN PRODUCTION, not invented ones. CTC-653
// measured that every ask a human filed on 2026-08-17 — CTC-648/649/650/651, CTL-1919,
// CTL-1923..1927 — wrote its options inline as `OPTIONS: (A) … (B) …` instead of a
// bulleted `**Options:**` block. Those parsed to ZERO options, so no reply could ever
// match and the ask was structurally undecidable while looking well-formed on the board.

import { describe, expect, test } from "bun:test";
import {
  ASK_LABEL_NAMES,
  VERBS,
  buildAskBody,
  isEntryPoint,
  missingBlocksFrom,
  parseAskOptions,
  resolveTeamLabelIds,
  teamPrefixMismatch,
  verifyAskBody,
} from "../ask.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASK_MJS = join(dirname(fileURLToPath(import.meta.url)), "..", "ask.mjs");

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


// ── CTL-1944: the two traps CTC(ux-b) found in this verb (CTCB-6) ──────────────────────

describe("trap (a) — the documented path must not silently no-op", () => {
  // ⛔ The skill says to run `$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs`, which is a SYMLINK.
  // The old guard compared `import.meta.url` (the RESOLVED real path) to `argv[1]` (the
  // symlink path) as raw strings, so it was false and the script EXITED 0 HAVING DONE
  // NOTHING — no ticket, no error, no output. A careless reader takes exit 0 for "filed".

  test("isEntryPoint resolves through a symlink", () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-link-"));
    const link = join(dir, "ask.mjs");
    symlinkSync(ASK_MJS, link);
    expect(isEntryPoint(`file://${ASK_MJS}`, link)).toBe(true);
    // ⛔ MUTATION CONTROL: the OLD comparison on the same inputs. If this ever starts
    // passing, the fixture is no longer a symlink and the test above proves nothing.
    expect(`file://${ASK_MJS}` === `file://${link}`).toBe(false);
  });

  test("isEntryPoint is false for an unrelated file, and never throws", () => {
    expect(isEntryPoint(`file://${ASK_MJS}`, "/definitely/not/here.mjs")).toBe(false);
    expect(isEntryPoint(`file://${ASK_MJS}`, undefined)).toBe(false);
    expect(isEntryPoint(`file://${ASK_MJS}`, "")).toBe(false);
  });

  test("END TO END: `create` through a symlink actually runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "ask-e2e-"));
    const link = join(dir, "ask.mjs");
    symlinkSync(ASK_MJS, link);
    const r = spawnSync("node", [link, "create", "--team", "CTL", "--title", "t", "--why", "w", "--dry-run"], {
      encoding: "utf8",
    });
    // The property that failed: output existed at all. Before the fix this was "".
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(JSON.parse(r.stdout).action).toBe("dry-run");
  });

  test("⛔ a no-op is LOUD: a real verb that does not reach the entry point exits non-zero", () => {
    // The class, not just the symlink instance. Simulated by importing the module in a
    // process whose argv[1] is something else entirely but whose argv[2] is a real verb.
    const r = spawnSync("node", ["-e", `process.argv[2]=${JSON.stringify(VERBS[0])};import(${JSON.stringify(ASK_MJS)})`], {
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("NOTHING WAS FILED");
  });

  test("a genuine import (no verb in argv) stays silent — that is how CTC-694 was filed", () => {
    const r = spawnSync("node", ["-e", `import(${JSON.stringify(ASK_MJS)}).then(m=>console.log(typeof m.buildAskBody))`], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("function");
    expect(r.stderr).not.toContain("NOTHING WAS FILED");
  });
});

describe("trap (b) — the label set follows the TARGET TEAM", () => {
  // Linear issue labels are team-scoped and both names exist on BOTH teams with different
  // ids, so passing NAMES let linearis resolve them against whichever team it picked.
  // Measured 2026-08-18 (linearis labels list --team, one call per team):
  const CTL_IDS = ["54179639-c850-4d3a-91da-f3d9288e68b0", "b23229ae-1d2b-4fa0-9987-091875e2b2a8"];
  const CTC_IDS = ["e1b5ef97-4f8b-43fc-8e11-f6286a12a415", "752b5560-068c-42e5-87af-e8cadbfd4ae3"];
  const fakeList = (byTeam) => (_cmd, args) => {
    const team = args[args.indexOf("--team") + 1];
    const nodes = (byTeam[team] ?? []).map(([name, id]) => ({ name, id }));
    return { code: 0, stdout: JSON.stringify({ nodes }), stderr: "" };
  };
  const BOTH = {
    CTL: [["catalyst-ask", CTL_IDS[0]], ["ask/decision", CTL_IDS[1]], ["website", "x"]],
    CTC: [["catalyst-ask", CTC_IDS[0]], ["ask/decision", CTC_IDS[1]]],
  };

  test("each team resolves to ITS OWN ids — and the two sets are disjoint", () => {
    const ctl = resolveTeamLabelIds("CTL", { runFn: fakeList(BOTH) });
    const ctc = resolveTeamLabelIds("CTC", { runFn: fakeList(BOTH) });
    expect(ctl).toEqual({ ok: true, labelIds: CTL_IDS });
    expect(ctc).toEqual({ ok: true, labelIds: CTC_IDS });
    // ⛔ The control that makes the two assertions above mean something: if the ids were
    // the same, a team-blind implementation would pass both.
    expect(CTL_IDS.some((id) => CTC_IDS.includes(id))).toBe(false);
  });

  test("order follows ASK_LABEL_NAMES regardless of the order the API returns", () => {
    const shuffled = { CTC: [["ask/decision", CTC_IDS[1]], ["catalyst-ask", CTC_IDS[0]]] };
    expect(resolveTeamLabelIds("CTC", { runFn: fakeList(shuffled) })).toEqual({ ok: true, labelIds: CTC_IDS });
    expect(ASK_LABEL_NAMES).toEqual(["catalyst-ask", "ask/decision"]);
  });

  test("ALL-OR-NOTHING: one missing label refuses the whole set by name", () => {
    const partial = { CTC: [["catalyst-ask", CTC_IDS[0]]] };
    const r = resolveTeamLabelIds("CTC", { runFn: fakeList(partial) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("label-not-on-team");
    expect(r.detail).toContain("ask/decision");
  });

  test("a duplicate name is AMBIGUOUS, never silently first-wins", () => {
    const dupe = { CTC: [["catalyst-ask", "a"], ["catalyst-ask", "b"], ["ask/decision", "c"]] };
    expect(resolveTeamLabelIds("CTC", { runFn: fakeList(dupe) }).reason).toBe("label-ambiguous");
  });

  test("a failed or unparseable list is a NAMED refusal, never an empty label set", () => {
    expect(resolveTeamLabelIds("CTC", { runFn: () => ({ code: 1, stdout: "", stderr: "boom" }) }).reason)
      .toBe("label-list-failed");
    expect(resolveTeamLabelIds("CTC", { runFn: () => ({ code: 0, stdout: "not json", stderr: "" }) }).reason)
      .toBe("label-list-unparseable");
    expect(resolveTeamLabelIds("CTC", { runFn: () => ({ code: 0, stdout: "{}", stderr: "" }) }).reason)
      .toBe("label-list-unparseable");
  });
});
