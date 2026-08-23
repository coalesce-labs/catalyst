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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
    // CTL-2204 verify round 3: run() was changed to surface spawnSync's `r.error`, because
    // a spawn that NEVER STARTED leaves status null and stderr UNDEFINED — the operator saw
    // a bare `rc=1` with an empty stderr tail, a failure with no cause. That branch had no
    // test of its own; this is the one environment that fires it positively (an empty PATH
    // hides `linearis`, so spawn returns ENOENT). Deleting the `if (r.error)` block in run()
    // makes this assertion fail.
    expect(r.stderr).toContain("the child never started (ENOENT)");
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

// ── CTL-2204 ────────────────────────────────────────────────────────────────────
// ask.mjs accept forwards the resolved body to linear-reply.mjs's child process. A guard in
// linear-reply.mjs alone still leaves a gap: --dry-run never spawns that child, so before
// this change `ask accept ... --body /tmp/x.md --dry-run` happily printed
// wouldReply:"/tmp/x.md" and exited 0. The same shared resolver (lib/comment-body-arg.mjs)
// is wired directly into cmdAccept so the refusal fires in ask.mjs's OWN process, before the
// replica read.
//
// ⛔ EVERY TEST HERE RUNS AGAINST A FRESH REPLICA. The first cut of this block ran the
// refusal cases with NO replica env, reasoning that "a refused body never reaches that
// code". That is true — and it is exactly why three of them could not fail: ask.mjs exits 1
// at the replica read whether or not the guard exists, so `expect(status).not.toBe(0)`
// passed for a reason unrelated to the property under test. Proven by mutation: with the
// CTL-2204 resolver block removed from cmdAccept, the suite went 52/0 → 49 pass / 3 fail and
// those three stayed GREEN. A test whose subject can be deleted without it failing is not
// evidence. Each case now (a) reaches the guard via buildFreshReplica and (b) asserts the
// EXACT refusal string plus status === 1, so deleting the guard fails it.
//
// Every test drives the REAL CLI through spawnSync, same discipline as the
// CTL-2157 block above.

const runAccept = (args, { env = {} } = {}) =>
  spawnSync(process.execPath, [ASK_MJS, "accept", ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

// Build a hermetic replica the SAME shape lib/linear-read-replica.sh's linear_read_ticket
// reads: issues/labels/issue_labels + a FRESH writer.lock + a sync_meta cursor row, so the
// read is a replica HIT and never falls back to a live `linearis` call.
//
// Hoisted to block scope (CTL-2204 remediation): the refusal cases need it too, or they
// never reach the guard they claim to test.
const buildFreshReplica = (id, { askLabel = true } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ask-replica-"));
  const db = join(dir, "replica.db");
  const labelRows = askLabel
    ? "INSERT INTO labels VALUES ('L1','catalyst-ask');" +
      "INSERT INTO issue_labels VALUES ('issue-1','L1');"
    : "";
  const sql = `
CREATE TABLE issues (id TEXT PRIMARY KEY, identifier TEXT, title TEXT, description TEXT,
  priority INTEGER, estimate INTEGER, url TEXT, branch_name TEXT, state TEXT,
  assignee_id TEXT, assignee TEXT, removed_at INTEGER);
CREATE TABLE labels (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE issue_labels (issue_id TEXT, label_id TEXT);
CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT);
INSERT INTO issues (id, identifier, title, removed_at) VALUES ('issue-1', '${id}', 't', NULL);
${labelRows}
INSERT INTO sync_meta VALUES ('cursor', '1');
`;
  const r = spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`buildFreshReplica: sqlite3 failed: ${r.stderr}`);
  writeFileSync(`${db}.writer.lock`, ""); // fresh mtime = now
  return db;
};

// A `linearis` stub that RECORDS every invocation, so "linearis was never called" can be
// asserted as evidence rather than assumed. Prints the labels JSON so `create` (used below
// purely as the positive control for this recorder) gets past its first call.
const recordingLinearisStub = () => {
  const bin = mkdtempSync(join(tmpdir(), "ask-recstub-"));
  const log = join(bin, "invocations.log");
  const stub = join(bin, "linearis");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\nprintf '%s\\n' '${LABELS_JSON}'\n`);
  chmodSync(stub, 0o755);
  return { bin, log, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim() : "") };
};

describe("ask accept — CTL-2204 body guard", () => {
  // A replica-resolvable id: linear_read_ticket requires TEAM-<digits>.
  const ASK_ID = "CTL-220499";

  test("--body pointing at an existing file is refused before anything is written", () => {
    const db = buildFreshReplica(ASK_ID);
    const dir = mkdtempSync(join(tmpdir(), "ask-body-"));
    const f = join(dir, "real.md");
    writeFileSync(f, "# real body\n");
    const r = runAccept([ASK_ID, "--as", "COORD", "--body", f, "--dry-run"], {
      env: { CATALYST_REPLICA_DB: db },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("A path is never a valid comment body");
    expect(r.stderr).toContain(`--body-file ${f}`);
  });

  test("--dry-run does NOT report a path as the would-be reply", () => {
    // The gap a linear-reply-only guard leaves: dry-run never reaches the child process, so
    // before this change it printed wouldReply:"/tmp/real.md" and exited 0.
    //
    // ⛔ The replica MUST be present here. Without it ask.mjs exits 1 at the replica read and
    // prints no stdout at all, so both assertions below hold with the guard DELETED — the
    // mutation-proven false pass this remediation exists to fix.
    const db = buildFreshReplica(ASK_ID);
    const dir = mkdtempSync(join(tmpdir(), "ask-body-"));
    const f = join(dir, "real.md");
    writeFileSync(f, "# real body\n");
    const r = runAccept([ASK_ID, "--as", "COORD", "--body", f, "--dry-run"], {
      env: { CATALYST_REPLICA_DB: db },
    });
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain(f);
    expect(r.stderr).toContain("A path is never a valid comment body");
  });

  test("positive control: the SAME argv minus the path reaches the dry-run preview", () => {
    // Proves the replica fixture above is live and the run really does get past the read —
    // so "status 1 + no stdout" in the two tests above is the GUARD talking, not the replica.
    const db = buildFreshReplica(ASK_ID);
    const r = runAccept([ASK_ID, "--as", "COORD", "--body", "an ordinary body", "--dry-run"], {
      env: { CATALYST_REPLICA_DB: db },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).action).toBe("dry-run");
  });

  test("--body-file missing → refused, naming the path", () => {
    const db = buildFreshReplica(ASK_ID);
    const r = runAccept([ASK_ID, "--as", "COORD", "--body-file", "/tmp/gone-xyz-ctl2204.md", "--dry-run"], {
      env: { CATALYST_REPLICA_DB: db },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--body-file not found: /tmp/gone-xyz-ctl2204.md");
  });

  test("both --body and --body-file → refused as ambiguous", () => {
    const db = buildFreshReplica(ASK_ID);
    const dir = mkdtempSync(join(tmpdir(), "ask-body-"));
    const f = join(dir, "real.md");
    writeFileSync(f, "x");
    const r = runAccept([ASK_ID, "--as", "COORD", "--body", "hi", "--body-file", f, "--dry-run"], {
      env: { CATALYST_REPLICA_DB: db },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("both --body and --body-file were given");
  });

  test("whitespace-only --body → refused", () => {
    const db = buildFreshReplica(ASK_ID);
    const r = runAccept([ASK_ID, "--as", "COORD", "--body", "   ", "--dry-run"], {
      env: { CATALYST_REPLICA_DB: db },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("comment body is empty");
  });

  test("a ~/ --body-file is expanded, so the refusal's own suggested remedy works", () => {
    // The --body refusal prints `use --body-file <the string you passed>`. If only --body
    // expanded ~/, that suggestion came straight back as "--body-file not found".
    const home = mkdtempSync(join(tmpdir(), "ask-home-"));
    mkdirSync(join(home, ".p"));
    writeFileSync(join(home, ".p", "b.md"), "# tilde body\n");
    const db = buildFreshReplica(ASK_ID);
    const r = runAccept([ASK_ID, "--as", "COORD", "--body-file", "~/.p/b.md", "--dry-run"], {
      env: { CATALYST_REPLICA_DB: db, HOME: home },
    });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).wouldReply).toContain("tilde body");
  });

  test("an ordinary body clears the guard — the refusal is not what stops it", () => {
    // The guard runs BEFORE the replica read, so an ordinary body must advance
    // PAST it. It then legitimately fails at the (nonexistent, isolated) replica
    // — that failure proves the guard was cleared, not tripped: none of the
    // guard's own refusal strings appear.
    const r = runAccept(
      [ASK_ID, "--as", "COORD", "--body", "accepted — has what it needs", "--dry-run"],
      { env: { CATALYST_REPLICA_DB: "/nonexistent/replica-ctl2204.db", CATALYST_DIR: mkdtempSync(join(tmpdir(), "ask-noreplica-")) } }
    );
    expect(r.stderr).not.toContain("--body-file");
    expect(r.stderr).not.toContain("ambiguous");
    expect(r.stderr).not.toContain("comment body is empty");
  });
});

describe("ask accept — CTL-2204 --body-file happy path (fresh local replica)", () => {
  const ASK_ID = "CTL-220499"; // linear_read_ticket requires TEAM-<digits>; no letter suffix

  test("--body-file resolves to the file's contents in the dry-run preview, never the path", () => {
    const db = buildFreshReplica(ASK_ID);
    const bodyDir = mkdtempSync(join(tmpdir(), "ask-body-"));
    const f = join(bodyDir, "real.md");
    writeFileSync(f, "# real body\n");
    const r = runAccept([ASK_ID, "--as", "COORD", "--body-file", f, "--dry-run"], {
      env: { CATALYST_REPLICA_DB: db },
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.wouldReply).toContain("real body");
    expect(out.wouldReply).not.toContain(f);
  });

  test("an ordinary --body reaches the dry-run preview and exits 0 (guard does not regress the happy path)", () => {
    const db = buildFreshReplica(ASK_ID);
    const r = runAccept(
      [ASK_ID, "--as", "COORD", "--body", "accepted — has what it needs", "--dry-run"],
      { env: { CATALYST_REPLICA_DB: db } }
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.action).toBe("dry-run");
    expect(out.wouldReply).toContain("accepted");
  });
});

// ── CTL-2204 remediation: the NON-dry-run tail ──────────────────────────────────
// The ticket's core safety property is an ORDERING one — a path passed to --body must be
// refused BEFORE the ask is closed — and every test above passes --dry-run, which returns
// early. So cmdAccept's tail (spawn linear-reply, then `linearis issues update --status
// Done`) was executed by NO test at all: nothing asserted that a refused body leaves
// `linearis` uninvoked and the ask OPEN. The ordering is correct by construction today
// (the guard is the first statement after arg validation), but an edit that moved the
// guard below the reply/close block would have shipped green.
describe("ask accept — CTL-2204 a refused body never closes the ask (no --dry-run)", () => {
  const ASK_ID = "CTL-220499";

  test("a path as --body → non-zero exit AND linearis is never invoked", () => {
    const { bin, calls } = recordingLinearisStub();
    const db = buildFreshReplica(ASK_ID);
    const dir = mkdtempSync(join(tmpdir(), "ask-body-"));
    const f = join(dir, "real.md");
    writeFileSync(f, "# real body\n");

    const r = spawnSync(process.execPath, [ASK_MJS, "accept", ASK_ID, "--as", "COORD", "--body", f], {
      encoding: "utf8",
      env: { ...process.env, CATALYST_REPLICA_DB: db, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("A path is never a valid comment body");
    // The ask is left OPEN: no Done transition, and no linearis call of ANY kind.
    expect(calls()).toBe("");
  });

  test("positive control: the same stub DOES record when ask.mjs really calls linearis", () => {
    // Without this, `calls() === ""` above is equally consistent with a stub that never
    // ran, was not on PATH, or could not write its log — i.e. with no evidence at all.
    const { bin, calls } = recordingLinearisStub();
    const r = spawnSync(
      process.execPath,
      [ASK_MJS, "create", "--team", "CTL", "--title", "t", "--why", "w",
       "--option", "a", "--option", "b", "--default", "a", "--blocks", "CTL-1"],
      { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } }
    );
    // We do not care whether create SUCCEEDS (the stub returns label JSON for every call, so
    // it will not) — only that the recorder captured a real invocation from ask.mjs.
    expect(calls()).toContain("labels list");
    expect(r.status).not.toBe(null); // the child ran; this is not a spawn failure
  });
});

// ── CTL-2204 verify round 3: the ask.mjs → linear-reply.mjs MARSHALLING boundary ─────────
// The remediation that introduced `run(..., ["--body", "-"], { input: body })` justified
// itself with three measured failures (E2BIG, argv injection via a body of `--top`, and a
// double refusal). None of them had a regression test: reverting that one line to the old
// `["--body", body]` left ALL 137 tests across all four CTL-2204 suites GREEN
// (ask-verbs 56/0, linear-reply-write-path 38/0, comment-body-arg 33/0,
// install-agent-tools 10/0). A fix whose removal is invisible is a fix that will be removed.
//
// The discriminator is exact and needs no stub: with argv marshalling, spawn fails and
// run()'s r.error branch reports "the child never started (E2BIG)"; with stdin marshalling
// the child really starts and fails later, downstream, inside the replica read. So this
// asserts BOTH directions — the spawn-failure marker is absent, and positive evidence that
// the child actually ran is present.
describe("ask accept — CTL-2204 the body reaches the child on STDIN, never through argv", () => {
  const ASK_ID = "CTL-220497";

  // Over MAX_ARG_STRLEN on both platforms: macOS kern.argmax is 1 MiB, and Linux's
  // per-argument limit (32 pages = 128 KiB) is LOWER, so CI trips it sooner than a laptop.
  const OVERSIZED = `# big\n${"x".repeat(2_000_000)}`;

  test("a body past the per-argument limit does NOT fail the spawn (E2BIG regression guard)", () => {
    const db = buildFreshReplica(ASK_ID);
    const dir = mkdtempSync(join(tmpdir(), "ask-big-"));
    const f = join(dir, "big.md");
    writeFileSync(f, OVERSIZED);

    const r = runAccept([ASK_ID, "--as", "COORD", "--body-file", f], {
      env: { CATALYST_REPLICA_DB: db },
    });

    // The reply cannot SUCCEED here (no write proxy in a unit test) and that is fine —
    // the property under test is WHERE it fails. It must not be at the spawn.
    expect(r.stderr).not.toContain("never started");
    expect(r.stderr).not.toContain("E2BIG");
    // Positive control: prove the child was genuinely reached rather than the assertions
    // above passing on an ask.mjs that exited earlier for some unrelated reason.
    expect(r.stderr).toContain("reply FAILED");
    expect(r.status).not.toBe(0);
  });

  test("positive control: the SAME oversized body through argv DOES fail the spawn", () => {
    // Without this, the test above is equally consistent with 2 MB simply being under the
    // limit on this host — i.e. with no evidence about marshalling at all. This reproduces
    // the old code path directly through spawnSync and pins that it really does break.
    const r = spawnSync(process.execPath, [ASK_MJS, "--body", OVERSIZED], { encoding: "utf8" });
    expect(r.error?.code).toBe("E2BIG");
    // A spawn that never ran reports no exit status. node uses null here and bun uses
    // undefined, and this suite runs under both — normalize rather than pin one runtime.
    expect(r.status ?? null).toBe(null);
  });

  test("a SMALL body also reaches the child — the stdin path is not large-body-only", () => {
    const db = buildFreshReplica(ASK_ID);
    const r = runAccept([ASK_ID, "--as", "COORD", "--body", "accepted — go ahead"], {
      env: { CATALYST_REPLICA_DB: db },
    });
    expect(r.stderr).not.toContain("never started");
    expect(r.stderr).toContain("reply FAILED");
  });
});
