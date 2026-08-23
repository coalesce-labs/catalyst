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
  blocksRelationIdentifiers,
  parseAskOptions,
  resolveTeamLabelIds,
  teamPrefixMismatch,
  verifyAskBody,
} from "../ask.mjs";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASK_MJS = join(dirname(fileURLToPath(import.meta.url)), "..", "ask.mjs");

// The MINIMUM argv a `create` now accepts (CTL-2157): two options, a default, and the
// work the ask blocks. Shared so a change to the contract updates every call site here.
const CREATE_MIN = [
  "create",
  "--team",
  "CTL",
  "--title",
  "t",
  "--why",
  "w",
  "--option",
  "a",
  "--option",
  "b",
  "--default",
  "a",
  "--blocks",
  "CTL-1",
];

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
  // ⛔ THE FIXTURE IS THE POINT. These read-backs are Linear's REAL shape
  // (`relations.nodes[].relatedIssue.identifier`), not a hand-shaped convenience. The
  // previous version of this suite asserted against `{"relations":["CTL-1"]}` — a body
  // Linear never returns — and passed while the production check was inert.
  const readBack = (blocks, { description = "**Why:** w\n\nBlocks: CTL-1, CTL-2" } = {}) =>
    JSON.stringify({
      identifier: "CTL-9000",
      description,
      relations: {
        nodes: blocks.map((b) => ({ type: "blocks", relatedIssue: { identifier: b } })),
      },
      inverseRelations: { nodes: [] },
    });

  test("relations present in the read-back are not reported missing", () => {
    expect(missingBlocksFrom(["CTL-1", "CTL-2"], readBack(["CTL-1", "CTL-2"]))).toEqual([]);
  });

  test("the dropped-all-but-last shape is caught and NAMED", () => {
    // linearis keeps only the LAST --blocks on some versions, so the command would exit 0
    // while CTL-1 remained formally unblocked.
    expect(missingBlocksFrom(["CTL-1", "CTL-2"], readBack(["CTL-2"]))).toEqual(["CTL-1"]);
  });

  test("⛔ THE PRODUCTION SHAPE: the body's `Blocks:` line does NOT count as a relation", () => {
    // Linear stores the description VERBATIM, and buildAskBody always writes a
    // `Blocks: <every requested id>` line. A substring check over the read-back JSON
    // therefore always found the id, `missingBlocks` was always [], and the exit-2
    // gate could never fire. This is that exact read-back: full body, zero relations.
    const body = buildAskBody({
      why: "w",
      options: ["a", "b"],
      defaultIfSilent: "a",
      blocks: ["CTL-1", "CTL-2"],
    });
    expect(body).toContain("Blocks: CTL-1, CTL-2"); // the trap is present in the fixture
    const stored = JSON.stringify({
      identifier: "CTL-9000",
      description: body,
      relations: { nodes: [] },
    });
    expect(missingBlocksFrom(["CTL-1", "CTL-2"], stored)).toEqual(["CTL-1", "CTL-2"]);
  });

  test("an inverse `blocked_by` edge counts — the same fact, recorded from the other side", () => {
    const stored = JSON.stringify({
      relations: { nodes: [] },
      inverseRelations: { nodes: [{ type: "blocked_by", issue: { identifier: "CTL-1" } }] },
    });
    expect(missingBlocksFrom(["CTL-1"], stored)).toEqual([]);
  });

  test("a NON-blocks relation to the same ticket does not satisfy --blocks", () => {
    const stored = JSON.stringify({
      relations: { nodes: [{ type: "related", relatedIssue: { identifier: "CTL-1" } }] },
    });
    expect(missingBlocksFrom(["CTL-1"], stored)).toEqual(["CTL-1"]);
  });

  test("no blocks requested is not a failure", () => {
    expect(missingBlocksFrom([], "{}")).toEqual([]);
  });

  test("⛔ 'could not look' is `null`, distinct from 'nothing missing'", () => {
    // A read-back with NO relation field cannot answer the question. Reporting []
    // (the old bug) is a false all-clear; reporting the ids is a false accusation.
    expect(missingBlocksFrom(["CTL-1"], '{"identifier":"CTL-9000"}')).toBeNull();
    expect(missingBlocksFrom(["CTL-1"], null)).toBeNull();
    expect(missingBlocksFrom(["CTL-1"], "not json")).toBeNull();
    // POSITIVE CONTROL through the same instrument: a present-but-EMPTY relation set
    // is an answer, and it names them all.
    expect(missingBlocksFrom(["CTL-1"], '{"relations":{"nodes":[]}}')).toEqual(["CTL-1"]);
  });

  test("blocksRelationIdentifiers reads edges only, never the description", () => {
    expect(blocksRelationIdentifiers('{"description":"Blocks: CTL-1","relations":{"nodes":[]}}')).
      toEqual(new Set());
    expect(
      blocksRelationIdentifiers(
        '{"relations":{"nodes":[{"type":"blocks","relatedIssue":{"identifier":"CTL-1"}}]}}'
      )
    ).toEqual(new Set(["CTL-1"]));
    expect(blocksRelationIdentifiers('{"description":"Blocks: CTL-1"}')).toBeNull();
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
    // ⛔ HERMETIC BY CONSTRUCTION. `--dry-run` deliberately resolves the team's labels
    // (a dry run that skips the step which fails is not a rehearsal), so this would
    // otherwise need a real `linearis` and a real credential — and it FAILED on the CI
    // runner, which has neither. Stubbing the binary on PATH seals the transport instead
    // of weakening the assertion to "produced some output", which would also pass for a
    // crash. The stub returns the shape `linearis labels list` really returns.
    const dir = mkdtempSync(join(tmpdir(), "ask-e2e-"));
    const link = join(dir, "ask.mjs");
    symlinkSync(ASK_MJS, link);

    const bin = mkdtempSync(join(tmpdir(), "ask-bin-"));
    const stub = join(bin, "linearis");
    writeFileSync(
      stub,
      '#!/bin/sh\necho \'{"nodes":[{"name":"catalyst-ask","id":"L1"},{"name":"ask/decision","id":"L2"}]}\'\n'
    );
    chmodSync(stub, 0o755);

    // CTL-2157: --option x2 / --default / --blocks are now REQUIRED — the create
    // refuses before it ever resolves labels without them.
    const r = spawnSync("node", [link, ...CREATE_MIN, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    // The property that failed before the fix: there was no output AT ALL, and exit 0.
    expect(r.stdout.length).toBeGreaterThan(0);
    const out = JSON.parse(r.stdout);
    expect(out.action).toBe("dry-run");
    // And it really went through the team-scoped resolution rather than a hardcoded list.
    expect(out.labelIds).toEqual(["L1", "L2"]);
  });

  test("⛔ without linearis on PATH, `create` REFUSES loudly — it does not file a label-less ask", () => {
    // The other half of the same property: the credential-free environment that broke
    // this test in CI must produce a NAMED refusal and a non-zero exit, never a silent
    // success. An ask without catalyst-ask is invisible to every view that selects on it.
    const dir = mkdtempSync(join(tmpdir(), "ask-nolin-"));
    const link = join(dir, "ask.mjs");
    symlinkSync(ASK_MJS, link);
    const emptyBin = mkdtempSync(join(tmpdir(), "ask-empty-"));
    // ⛔ process.execPath, not "node": an empty PATH hides the INTERPRETER too, so
    // spawnSync fails with ENOENT and returns status null — the test would then "pass"
    // on a process that never ran. That is the failure mode this whole ticket is about,
    // reproduced inside its own test, so the assertion below pins status to 1.
    const r = spawnSync(process.execPath, [link, ...CREATE_MIN, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, PATH: emptyBin },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("could not resolve the ask labels");
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

// ── CTL-2157 ────────────────────────────────────────────────────────────────────
// An ask that nothing can answer, or that wakes nobody when answered, is the
// `needs-human` pile-up with a nicer name. An audit of this file found that a
// machine could file one with zero options, no default and no blocking relation
// and get EXIT 0 — the guarantee the ask SOP assumed simply did not exist.
//
// Every test here drives the REAL CLI through spawnSync (the argv contract is the
// thing under test), hermetically: a stubbed `linearis` on PATH, so no credential
// and no Linear call.

const linearisStub = (script) => {
  const bin = mkdtempSync(join(tmpdir(), "ask-stub-"));
  const stub = join(bin, "linearis");
  writeFileSync(stub, script);
  chmodSync(stub, 0o755);
  return bin;
};

const LABELS_JSON =
  '{"nodes":[{"name":"catalyst-ask","id":"L1"},{"name":"ask/decision","id":"L2"}]}';

const runCreate = (args, { bin } = {}) =>
  spawnSync(process.execPath, [ASK_MJS, "create", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin ?? linearisStub(`#!/bin/sh\nprintf '%s\\n' '${LABELS_JSON}'\n`)}:${process.env.PATH ?? ""}`,
    },
  });

describe("CTL-2157 — a machine-filed ask must be decidable", () => {
  const base = ["--team", "CTL", "--title", "t", "--why", "w", "--dry-run"];

  test("ZERO options is REFUSED (it was exit 0 before — verifyAskBody calls it ok)", () => {
    const r = runCreate([...base, "--default", "d", "--blocks", "CTL-1"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("at least TWO --option");
  });

  test("ONE option is REFUSED — a single choice is a rubber stamp, not a decision", () => {
    const r = runCreate([...base, "--option", "a", "--default", "d", "--blocks", "CTL-1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("at least TWO --option");
  });

  test("no --default is REFUSED — silence must mean something", () => {
    const r = runCreate([...base, "--option", "a", "--option", "b", "--blocks", "CTL-1"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--default is required");
  });

  test("no --blocks is REFUSED — an answer must have someone to wake", () => {
    const r = runCreate([...base, "--option", "a", "--option", "b", "--default", "a"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--blocks");
    expect(r.stderr).toContain("wakes nobody");
  });

  // ⛔ POSITIVE CONTROL for all four refusals above: the same command WITH the
  // required flags reaches the dry run and exits 0. Without this, every assertion
  // above would also pass on a CLI that refuses everything.
  test("POSITIVE CONTROL: a complete ask reaches the dry run and exits 0", () => {
    const r = runCreate([
      ...base,
      "--option",
      "a",
      "--option",
      "b",
      "--default",
      "a",
      "--blocks",
      "CTL-1",
    ]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.action).toBe("dry-run");
    expect(out.parsedOptions).toEqual(["a", "b"]);
    expect(out.body).toContain("Blocks: CTL-1");
  });
});

describe("CTL-2157 — a dropped --blocks relation FAILS the create, it does not warn", () => {
  // The stub is the whole `linearis` surface cmdCreate touches: the team's labels,
  // the create, and the read-back. `issues read` names only CTL-1, reproducing the
  // linearis behaviour ask.mjs documents — "keeps only the LAST --blocks flag".
  //
  // ⚠️ `printf '%s\n'`, never `echo`: /bin/sh's echo expands the `\n` escapes INSIDE
  // the JSON string, so the payload arrives as unparseable JSON carrying real
  // newlines — the read-back then fails for a reason that has nothing to do with the
  // property under test. `%s` passes its argument through untouched.
  //
  // ⛔ THE READ-BACK IS LINEAR'S REAL SHAPE. Its `description` ALWAYS names every
  // requested id (that is what buildAskBody writes and what Linear stores verbatim),
  // while `relations.nodes` carries only what actually landed. A fixture that let the
  // description stand in for the relation is what made the old check pass while the
  // production gate was unreachable.
  const relNodes = (ids) =>
    ids.map((b) => `{"type":"blocks","relatedIssue":{"identifier":"${b}"}}`).join(",");
  const stubScript = (recordedBlocks, { omitRelations = false } = {}) =>
    `#!/bin/sh
case "$1 $2" in
  "labels list") printf '%s\\n' '${LABELS_JSON}' ;;
  "issues create") printf '%s\\n' '{"identifier":"CTL-9000"}' ;;
  "issues read") printf '%s\\n' '{"identifier":"CTL-9000","description":"**Why:** w\\n\\n**Options:**\\n- a\\n- b\\n\\n**Default if silent:** a\\n\\nBlocks: CTL-1, CTL-2"${omitRelations ? "" : `,"relations":{"nodes":[${relNodes(recordedBlocks)}]}`}}' ;;
esac
`;
  const args = [
    "--team",
    "CTL",
    "--title",
    "t",
    "--why",
    "w",
    "--option",
    "a",
    "--option",
    "b",
    "--default",
    "a",
    "--blocks",
    "CTL-1",
    "--blocks",
    "CTL-2",
  ];

  test("a relation Linear never recorded is exit 2 and NAMED", () => {
    const r = runCreate(args, { bin: linearisStub(stubScript(["CTL-1"])) });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("CTL-2");
    expect(r.stderr).toContain("NOT on it");
    // …and it is attributable to the RELATION, not to an unreadable body: the
    // round trip on the same run reports the ask as decidable.
    const out = JSON.parse(r.stdout);
    expect(out.decidable).toBe(true);
    expect(out.missingBlocks).toEqual(["CTL-2"]);
  });

  test("POSITIVE CONTROL: both relations present ⇒ exit 0", () => {
    const r = runCreate(args, { bin: linearisStub(stubScript(["CTL-1", "CTL-2"])) });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.missingBlocks).toEqual([]);
    expect(out.blocksVerified).toBe(true);
  });

  test("⛔ ZERO relations recorded is exit 2 — the body's Blocks: line proves nothing", () => {
    // The read-back's description names CTL-1 AND CTL-2 (ask.mjs wrote it); only the
    // relation edges are empty. The old substring check exited 0 here.
    const r = runCreate(args, { bin: linearisStub(stubScript([])) });
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out.missingBlocks).toEqual(["CTL-1", "CTL-2"]);
    expect(out.blocksVerified).toBe(true); // it WAS answerable — the answer was "none"
    expect(r.stderr).toContain("NOT on it");
  });

  test("⛔ a read-back with NO relation field FAILS CLOSED, and says which it is", () => {
    const r = runCreate(args, { bin: linearisStub(stubScript([], { omitRelations: true })) });
    expect(r.status).toBe(2);
    const out = JSON.parse(r.stdout);
    expect(out.blocksVerified).toBe(false);
    expect(out.missingBlocks).toEqual([]); // NOT accused — unproven is not absent
    expect(r.stderr).toContain("NO relation field");
  });
});
