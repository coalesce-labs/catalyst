#!/usr/bin/env node
// ask.mjs — CTL-1922 increment 2. The `ask create` / `ask accept` verbs.
//
// ── WHY A VERB AND NOT A DOCUMENTED SNIPPET ──
// The `ask` skill already documents the exact body shape the cloud's decision trigger
// parses. Documenting it was not enough: CTC-653 measured that every ask a HUMAN filed on
// 2026-08-17 (CTC-648/649/650/651, CTL-1919, CTL-1923..1927) wrote the options inline
// instead of as a bulleted `**Options:**` block. Those parsed to ZERO options, so no reply
// could ever match and the ask was **structurally undecidable** — while looking, on the
// board and in the "what needs me" view, exactly like a well-formed one.
//
// ⛔ SO THE VERB'S JOB IS NOT TO RENDER THE BODY. It is to render it and then PROVE the
// trigger will see it: `create` reads the created ticket BACK out of Linear and parses the
// stored body with the same rules the trigger uses. A body that renders correctly and
// stores mangled is the failure this exists to catch, and only a round-trip can see it.
//
// ── ⚠️ THE PARITY RISK, STATED ──
// The authoritative parser is `apps/mirror/src/do/ask-decision.ts` in the catalyst-cloud
// repo — a DIFFERENT repo, so the one-registry/two-engines/parity-suite discipline used
// for lib/secret-contract.mjs cannot be applied mechanically here. `parseAskOptions` below
// is a hand port of that function, and it can drift. Two mitigations, neither perfect:
//   1. the port is byte-for-byte on the regexes, and each carries the reason it is written
//      that way (they are load-bearing — see OPTIONS_HEADER's alternation note);
//   2. the tests use the forms that FAILED in production, not invented ones.
// If the cloud parser changes, this validator can pass a body the trigger rejects. That is
// a real gap; it is named here rather than left for someone to discover on a dead ask.
// Ported from catalyst-cloud `apps/mirror/src/do/ask-decision.ts` (read 2026-08-17).

import { spawnSync } from "node:child_process";
// ⛔ Codex #3509 P2: `--body -` used CommonJS `require`, which is undefined in an ESM
// module — the documented form threw a ReferenceError before reading anything.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveCommentBody } from "./lib/comment-body-arg.mjs";

// ⚠️ ONE alternation-free pattern, deliberately: JS alternation prefers the earliest MATCH
// POSITION, so a bare `Options:` branch matches at the preceding newline and consumes
// `\n**Options:`, leaving a stray `**` as the first line — which is not an item, which ends
// the list at zero. Matching the optional bold markers inside ONE pattern removes the
// choice and therefore the bug. `[ \t]` rather than `\s` so the header cannot swallow the
// newline before the list.
const OPTIONS_HEADER = /(?:^|\n)[ \t]*\*{0,2}[ \t]*Options[ \t]*:[ \t]*\*{0,2}/i;
/** `- label`, `* label`, `(A) label`, `A) label`, `A. label`, `A: label`. */
const OPTION_ITEM = /^(?:[-*]\s+|\(([A-Za-z])\)\s*|([A-Za-z])[).:]\s+)(.+)$/;
/** The same forms found INLINE on one line: `OPTIONS: (A) do x (B) do y`. */
const INLINE_OPTION = /\(([A-Za-z])\)\s*([^(]+)/g;

const nonEmpty = (v) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/** Extract option labels in order; `[]` when the body carries no readable options section. */
export function parseAskOptions(body) {
  const s = nonEmpty(body);
  if (s == null) return [];
  const headerMatch = OPTIONS_HEADER.exec(s);
  if (headerMatch == null) return [];
  const afterHeader = s.slice(headerMatch.index + headerMatch[0].length);
  const lines = afterHeader.split("\n");

  // Inline first: `OPTIONS: (A) foo (B) bar` puts every option on the header's own line, so
  // the line-oriented walk below would see one blob. Trusted only at >= 2 — a single `(A)`
  // on the header line is more likely prose than an enumeration.
  const firstLine = lines[0] ?? "";
  const inline = [...firstLine.matchAll(INLINE_OPTION)]
    .map((m) => nonEmpty(m[2]))
    .filter((v) => v != null);
  if (inline.length >= 2) return inline;

  const options = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (options.length > 0) break; // a blank line ends the list
      continue;
    }
    const item = OPTION_ITEM.exec(trimmed);
    if (item == null) break; // a non-item line (e.g. "**Default if silent:**") ends the list
    const label = nonEmpty(item[3]);
    if (label != null) options.push(label);
  }
  return options;
}

/**
 * buildAskBody — the canonical shape. Exactly one blank line between sections, because a
 * blank line is what ends the option list for the parser above.
 */
export function buildAskBody({ why, options = [], defaultIfSilent, blocks = [] }) {
  const parts = [`**Why:** ${why}`];
  if (options.length > 0) {
    parts.push(["**Options:**", ...options.map((o) => `- ${o}`)].join("\n"));
  }
  if (nonEmpty(defaultIfSilent)) parts.push(`**Default if silent:** ${defaultIfSilent}`);
  if (blocks.length > 0) parts.push(`Blocks: ${blocks.join(", ")}`);
  return parts.join("\n\n");
}

/**
 * verifyAskBody — the round trip. Given what we MEANT to write and what Linear STORED,
 * decide whether the trigger will see the ask as decidable.
 *
 * ⛔ Three-valued, and `[]` is never quietly accepted: `parseAskOptions` returning `[]`
 * means EITHER "this ask has no options" OR "its options are in a shape nothing can read",
 * and those need opposite responses. So an ask that was CREATED with options and reads
 * back with none is a hard failure, not an option-less ask.
 */
export function verifyAskBody({ intendedOptions = [], storedBody }) {
  const parsed = parseAskOptions(storedBody ?? "");
  if (intendedOptions.length === 0) {
    return { ok: true, reason: null, parsed, note: "option-less ask — nothing to verify" };
  }
  if (parsed.length === 0) {
    return {
      ok: false,
      reason: "options-unreadable",
      parsed,
      note: "the stored body parses to ZERO options — this ask is structurally undecidable (CTC-653)",
    };
  }
  if (parsed.length !== intendedOptions.length) {
    return {
      ok: false,
      reason: "option-count-mismatch",
      parsed,
      note: `wrote ${intendedOptions.length}, stored parses to ${parsed.length}`,
    };
  }
  const mismatch = intendedOptions.findIndex((o, i) => o.trim() !== parsed[i]);
  if (mismatch !== -1) {
    return {
      ok: false,
      reason: "option-text-mismatch",
      parsed,
      note: `option ${mismatch + 1} differs`,
    };
  }
  return { ok: true, reason: null, parsed, note: null };
}

/**
 * teamPrefixMismatch — did Linear file this on the team we asked for?
 *
 * `issues create --team CTL` has historically fallen back to the workspace's DEFAULT team
 * when given a key rather than a UUID (czottmann/linearis#56). An ask on the wrong board
 * still reports success while its team-scoped labels and blocking relations serve a team
 * nobody is watching. Only checked when `team` LOOKS like a key — a UUID carries no prefix
 * to compare, and guessing one would reject every correct UUID-scoped create.
 */
export function teamPrefixMismatch(team, identifier) {
  if (typeof team !== "string" || typeof identifier !== "string") return false;
  const looksLikeKey = /^[A-Za-z][A-Za-z0-9]*$/.test(team) && team.length <= 8;
  if (!looksLikeKey) return false;
  return !identifier.toUpperCase().startsWith(`${team.toUpperCase()}-`);
}

/**
 * blocksRelationIdentifiers — the tickets a read-back says this issue BLOCKS.
 *
 * ⛔ THE BUG THIS REPLACES, and it is the whole reason this function exists. The
 * check used to be `readBackText.includes(id)` over the WHOLE read-back JSON. That
 * JSON contains the `description` `ask.mjs` had just written, and `buildAskBody`
 * ALWAYS emits a `Blocks: <ids>` line naming every requested id — so the id was
 * present in the text whether or not Linear recorded the relation, `missingBlocks`
 * was always `[]`, and the exit-2 gate was UNREACHABLE. Proven by running the real
 * CLI against a `linearis` stub that returned the body verbatim with NO relations at
 * all: `missingBlocks: []`, exit 0. The unit test passed only because its fixture
 * fabricated a read-back Linear would never store.
 *
 * So this reads RELATION EDGES ONLY and never touches the description. Linear's own
 * shape (the same one `lib/dependency-graph.mjs` normalizes):
 *   relations.nodes[]        — edges this issue owns. `blocks` → relatedIssue.
 *   inverseRelations.nodes[] — edges pointing at it. `blocked_by` → issue.
 *
 * ⛔ THREE-VALUED. `null` means "this read-back carries no relation field at all" —
 * I COULD NOT LOOK — which must never be reported as "no relations recorded". A
 * projection that omits a field is not the field being empty (measured on the
 * replica's own narrower read shape, which drops `relations` entirely).
 *
 * @returns {Set<string>|null}
 */
export function blocksRelationIdentifiers(readBack) {
  let doc = readBack;
  if (typeof doc === "string") {
    try {
      doc = JSON.parse(doc);
    } catch {
      return null; // unparseable → could not look
    }
  }
  if (doc === null || typeof doc !== "object") return null;
  const nodesOf = (v) => (Array.isArray(v?.nodes) ? v.nodes : Array.isArray(v) ? v : null);
  const rel = nodesOf(doc.relations);
  const inv = nodesOf(doc.inverseRelations);
  if (rel === null && inv === null) return null; // neither field present → could not look

  const out = new Set();
  const idOf = (n, ...keys) => {
    for (const k of keys) {
      const v = n?.[k];
      if (typeof v === "string" && v !== "") return v;
      if (typeof v?.identifier === "string" && v.identifier !== "") return v.identifier;
    }
    return null;
  };
  for (const n of rel ?? []) {
    if (n?.type !== "blocks") continue;
    const id = idOf(n, "relatedIssue", "issue", "identifier");
    if (id) out.add(id);
  }
  for (const n of inv ?? []) {
    // an inverse `blocked_by` edge means SELF blocks the peer (dependency-graph.mjs)
    if (n?.type !== "blocked_by") continue;
    const id = idOf(n, "issue", "relatedIssue", "identifier");
    if (id) out.add(id);
  }
  return out;
}

/**
 * missingBlocksFrom — which requested `--blocks` relations Linear did NOT record.
 *
 * "A `--relates-to` / `--blocks` list keeps only the LAST flag in some linearis versions"
 * (the ask skill's own gotcha). Without this the command exits 0 while every earlier work
 * ticket remains formally unblocked.
 *
 * THREE-VALUED, inheriting `blocksRelationIdentifiers`: `[]` = every requested relation
 * is on the ticket; `[ids]` = these are absent; `null` = the read-back could not be
 * asked. The caller must not conflate the last two — one is "repair these relations",
 * the other is "I cannot prove anything about them".
 *
 * @returns {string[]|null}
 */
export function missingBlocksFrom(blocks, readBack) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const recorded = blocksRelationIdentifiers(readBack);
  if (recorded === null) return null;
  return blocks.filter((b) => !recorded.has(b));
}

/**
 * ⛔ THE LABEL SET FOLLOWS THE TARGET TEAM (CTCB-6 trap b).
 *
 * Linear issue labels are TEAM-SCOPED, and both of these names exist on BOTH teams with
 * DIFFERENT ids. Measured 2026-08-18:
 *
 *   catalyst-ask   CTL 54179639-c850-4d3a-91da-f3d9288e68b0   CTC e1b5ef97-4f8b-43fc-8e11-f6286a12a415
 *   ask/decision   CTL b23229ae-1d2b-4fa0-9987-091875e2b2a8   CTC 752b5560-068c-42e5-87af-e8cadbfd4ae3
 *
 * Passing the NAMES let `linearis` resolve them against whichever team it picked — CTL's —
 * so filing a CTC ask failed with "The label 'catalyst-ask' is not associated with the same
 * team as the issue." That one at least failed loudly; the danger is the other direction,
 * where a name happens to resolve to the right team by luck and the tool looks correct
 * until someone files across teams.
 *
 * ⚠️ The local replica CANNOT answer this question: its `labels` table has no team column,
 * so both rows are visible and indistinguishable — exactly the `label-ambiguous` case the
 * write-proxy resolver names. The team scoping lives only in the API, so this is one of the
 * few reads that legitimately goes there.
 */
export const ASK_LABEL_NAMES = Object.freeze(["catalyst-ask", "ask/decision"]);

/**
 * resolveTeamLabelIds — map ASK_LABEL_NAMES to ids ON THIS TEAM.
 *
 * ALL-OR-NOTHING and three-valued. A partial set would file an ask carrying some of its
 * labels and silently dropping the rest, which reads as success at the call site and makes
 * the ask invisible to the very views that select on `catalyst-ask`.
 */
export function resolveTeamLabelIds(team, { runFn = run, names = ASK_LABEL_NAMES } = {}) {
  const r = runFn("linearis", ["labels", "list", "--team", team, "--limit", "250"]);
  if (r.code !== 0) {
    return { ok: false, reason: "label-list-failed", detail: r.stderr.slice(0, 200) };
  }
  let nodes;
  try {
    nodes = JSON.parse(r.stdout)?.nodes;
  } catch (err) {
    return { ok: false, reason: "label-list-unparseable", detail: String(err?.message ?? err).slice(0, 200) };
  }
  if (!Array.isArray(nodes)) return { ok: false, reason: "label-list-unparseable", detail: "no nodes array" };

  const ids = [];
  for (const name of names) {
    // A `LIMIT 2`-style count, for the same reason the write-proxy resolver uses one:
    // ambiguity must be DETECTED, not silently resolved to whichever row came first.
    const hits = nodes.filter((n) => n?.name === name && typeof n?.id === "string");
    if (hits.length === 0) return { ok: false, reason: "label-not-on-team", detail: `${name} @ ${team}` };
    if (hits.length > 1) return { ok: false, reason: "label-ambiguous", detail: `${name} @ ${team}` };
    ids.push(hits[0].id);
  }
  return { ok: true, labelIds: ids };
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────

const RYAN = process.env.ASK_HUMAN_ID || "c2a8cc92-cab6-4536-9500-0f24abdf702b";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * readTicketViaReplica — the house read path (AGENTS.md "Linear reads → local replica").
 *
 * ⛔ Codex #3509 P1: a bare `linearis issues read` bypasses the freshness gate and spends
 * the fleet's shared, rate-limited API quota — and under fleet-wide 429 pressure it is
 * precisely the read that fails. `linear_read_ticket` is the sanctioned helper: it gates on
 * writer-lock recency plus a non-empty sync cursor and falls back LOUDLY.
 *
 * ⚠️ It is bash, so this shells out. That is the seam the house rule names; re-deriving the
 * freshness gate in JS would be a second gate to keep in step with the first.
 */
function readTicketViaReplica(id) {
  const helper = new URL("./lib/linear-read-replica.sh", import.meta.url).pathname;
  const r = run("bash", [
    "-c",
    `. ${JSON.stringify(helper)} >/dev/null 2>&1; linear_read_ticket ${JSON.stringify(id)}`,
  ]);
  if (r.code !== 0 || r.stdout.trim() === "") return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

function usage() {
  console.error(`Usage:
  ask.mjs create --team <TEAM> --title <t> --why <text>
                 --option <label> --option <label> [--option ...]   (at least TWO)
                 --default <text> --blocks <ISSUE> [--blocks <ISSUE> ...]
                 [--priority <1-4>] [--dry-run]
  ask.mjs accept <ISSUE> --as <AGENT> (--body <markdown|-> | --body-file <path>) [--dry-run]

create files a correctly-shaped ask ticket, then READS IT BACK and proves the decision
trigger can parse its options AND that every requested blocking relation landed. accept
replies in-thread as the app actor and moves the ticket to Done — refusing if the ticket
is not an ask.

⛔ --option (>=2), --default and --blocks are REQUIRED (CTL-2157). An ask with nothing to
choose between, no meaning for silence, or no work attached is the pile-up asks exist to
replace: the answer wakes the agents parked on the tickets the ask BLOCKS.
Exit: 0 filed and provably answerable · 1 nothing was filed · 2 filed but DEFECTIVE
(undecidable body, or a --blocks relation Linear did not record).`);
}

function argOf(argv, name, { many = false } = {}) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && i + 1 < argv.length) out.push(argv[i + 1]);
  }
  return many ? out : (out[out.length - 1] ?? null);
}

function cmdCreate(argv) {
  const team = argOf(argv, "--team");
  const title = argOf(argv, "--title");
  const why = argOf(argv, "--why");
  const options = argOf(argv, "--option", { many: true });
  const dflt = argOf(argv, "--default");
  const blocks = argOf(argv, "--blocks", { many: true });
  const priority = argOf(argv, "--priority") ?? "2";
  const dryRun = argv.includes("--dry-run");

  if (!team || !title || !why) {
    console.error("ask create: --team, --title and --why are required");
    return 1;
  }

  // ⛔ CTL-2157 — AN ASK MUST BE ANSWERABLE, AND MUST WAKE SOMETHING.
  //
  // These three were documented in the skill from day one and enforced NOWHERE: an
  // audit of this file found a machine could file an ask with zero options, no
  // default and no blocking relation and get exit 0. Each hole is a way for an ask
  // to become the content-free bin the `needs-human` label was:
  //
  //   • FEWER THAN TWO OPTIONS — there is nothing to decide. verifyAskBody
  //     explicitly returns ok:true for an option-less ask ("nothing to verify"),
  //     so the round-trip validator cannot catch this; the check has to be here.
  //     One option is worse than none: it reads as a decision and is a rubber stamp.
  //   • NO DEFAULT — silence has no meaning, so the ask can only ever be resolved
  //     by a human doing something, which is precisely the pile-up we are deleting.
  //   • NO --blocks — nothing to wake. The daemon's comment-wake fans an answered
  //     ask out to the work it blocks (execution-core/ask-wake.mjs); an ask that
  //     blocks nothing answers into the void and its agent waits forever
  //     (ADV-1374/1376 sat for DAYS on exactly that).
  //
  // No escape-hatch flag, deliberately: a flag that turns these off is a flag every
  // caller in a hurry will pass. A genuinely open question still enumerates its
  // options — "something else — tell me" is an option.
  if (options.length < 2) {
    console.error(
      `ask create: REFUSING — an ask needs at least TWO --option values (got ${options.length}). ` +
        "An ask with one option or none is not a decision; it is a status update wearing an ask's " +
        "label, and nothing can be answered by tapping."
    );
    return 1;
  }
  if (!nonEmpty(dflt)) {
    console.error(
      "ask create: REFUSING — --default is required. Without a stated default, SILENCE HAS NO " +
        "MEANING and the ask can only ever be cleared by a human acting, which is the pile-up " +
        "asks exist to avoid."
    );
    return 1;
  }
  if (blocks.length === 0) {
    console.error(
      "ask create: REFUSING — --blocks <ISSUE> is required (repeat it for several). The answer " +
        "wakes the agents parked on the tickets this ask BLOCKS; an ask that blocks nothing wakes " +
        "nobody, and the work it was raised for waits forever."
    );
    return 1;
  }
  const body = buildAskBody({ why, options, defaultIfSilent: dflt, blocks });

  // Fail BEFORE writing if what we are about to write cannot be parsed. Filing an
  // undecidable ask and discovering it later is the whole defect.
  const pre = verifyAskBody({ intendedOptions: options, storedBody: body });
  if (!pre.ok) {
    console.error(
      `ask create: REFUSING — the body I built does not parse (${pre.reason}: ${pre.note})`
    );
    return 1;
  }
  // ⛔ Resolve the labels ON THE TARGET TEAM before the dry-run returns, not after. A dry
  // run that skips the step which actually fails is not a rehearsal — it is the shape of
  // check that cannot fail, and it would have passed cleanly for the exact defect CTCB-6
  // hit. See resolveTeamLabelIds.
  const lbl = resolveTeamLabelIds(team);
  if (!lbl.ok) {
    console.error(
      `ask create: REFUSING — could not resolve the ask labels on team ${team} ` +
        `(${lbl.reason}: ${lbl.detail}). Labels are TEAM-SCOPED; filing without them would ` +
        "hide the ask from every view that selects on catalyst-ask."
    );
    return 1;
  }
  const labelIds = lbl.labelIds;

  if (dryRun) {
    console.log(
      JSON.stringify(
        { action: "dry-run", team, title, body, parsedOptions: pre.parsed, labelIds },
        null,
        2
      )
    );
    return 0;
  }

  const args = [
    "issues",
    "create",
    title,
    "--team",
    team,
    "--priority",
    String(priority),
    "--assignee",
    RYAN,
    "--labels",
    labelIds.join(","),
    "--description",
    body,
  ];
  for (const b of blocks) args.push("--blocks", b);
  const created = run("linearis", args);
  if (created.code !== 0) {
    console.error(
      `ask create: linearis failed (rc=${created.code})\n${created.stderr.slice(0, 400)}`
    );
    return 1;
  }
  const id = (created.stdout.match(/"identifier"\s*:\s*"([A-Z]+-\d+)"/) ?? [])[1];
  if (!id) {
    console.error("ask create: created, but could not read the identifier back — verify by hand");
    return 1;
  }

  // ⛔ Codex #3509 P1: `issues create --team CTL` has historically fallen back to the
  // workspace's DEFAULT team when given a key rather than a UUID (czottmann/linearis#56;
  // the linearis skill says to verify scope by the returned identifier's prefix). An ask
  // filed on the wrong board still reports success, while its team-scoped labels and
  // blocking relations serve a team nobody is watching.
  if (teamPrefixMismatch(team, id)) {
    console.error(
      `ask create: ⛔ asked for team ${team} but Linear returned ${id} — the ask is on the WRONG BOARD ` +
        "(key-based --team can fall back to the default team). Move or re-file it before citing it."
    );
    return 2;
  }

  // ── the round trip ──
  // ⚠️ This ONE read goes to the API rather than the replica, deliberately: the ticket was
  // created milliseconds ago, so a replica read cannot yet see it — it would answer
  // "absent" every time and the verifier would report a well-formed ask as unreadable.
  // Every OTHER read in this file uses the replica.
  const readBack = run("linearis", ["issues", "read", id]);
  if (readBack.code !== 0) {
    console.error(
      `ask create: ${id} created, but the read-back FAILED — cannot prove it is decidable`
    );
    return 1;
  }
  let stored = "";
  try {
    stored = JSON.parse(readBack.stdout)?.description ?? "";
  } catch {
    console.error(
      `ask create: ${id} created, but the read-back was unparseable — cannot prove it is decidable`
    );
    return 1;
  }
  const post = verifyAskBody({ intendedOptions: options, storedBody: stored });

  // ⛔ Codex #3509 P2: "a `--relates-to` / `--blocks` list keeps only the LAST flag in some
  // linearis versions" — the ask skill's own gotcha. The round trip validated the body and
  // said nothing about relations, so this could exit 0 while every earlier work ticket
  // remained formally unblocked. Read them back and NAME the missing ones.
  const missingBlocksOrNull = missingBlocksFrom(blocks, readBack.stdout);
  // ⛔ `null` is "the read-back carried no relation field" — NOT "no relations are
  // missing". Reporting it as `[]` is precisely the inert check this replaced, and
  // reporting it as "all missing" would be a lie about what Linear stored. It is its
  // own outcome, and it FAILS CLOSED: an automated caller must not record "filed and
  // wakeable" for an ask whose wake path was never proven.
  const blocksVerified = missingBlocksOrNull !== null;
  const missingBlocks = missingBlocksOrNull ?? [];

  console.log(
    JSON.stringify({
      action: "created",
      id,
      decidable: post.ok,
      reason: post.reason,
      parsedOptions: post.parsed,
      blocksVerified,
      missingBlocks,
    })
  );
  // ⛔ CTL-2157 — THIS IS A FAILURE, NOT A WARNING. It used to print a ⚠️ and then
  // `return 0`, so an automated caller — which reads the exit code, not stderr —
  // recorded "ask filed" for an ask whose relation to the work was never created.
  // That relation is load-bearing twice over: the comment-wake fans an answered ask
  // out along it (execution-core/ask-wake.mjs), and the triage ranking measures an
  // ask's blast radius by the work it blocks. Exit 2 (the ticket EXISTS but is
  // defective) rather than 1 (nothing was filed) — the caller must repair, not refile.
  if (missingBlocks.length > 0) {
    console.error(
      `ask create: ⛔ ${id} filed, but these --blocks relations are NOT on it: ${missingBlocks.join(", ")} — ` +
        "add them by hand (linearis keeps only the last --blocks on some versions). Until you do, " +
        "an answer on this ask will not wake the agents parked on them."
    );
  }
  if (!blocksVerified) {
    console.error(
      `ask create: ⛔ ${id} filed, but the read-back carried NO relation field — cannot prove the ` +
        `--blocks relations (${blocks.join(", ")}) landed. Verify by hand; until then an answer on ` +
        "this ask is not proven to wake anything."
    );
  }
  if (!post.ok) {
    console.error(
      `ask create: ⛔ ${id} exists but is NOT decidable (${post.reason}: ${post.note}) — fix the body before relying on it`
    );
  }
  if (missingBlocks.length > 0 || !blocksVerified || !post.ok) return 2;
  return 0;
}

function cmdAccept(argv) {
  const id = argv[0];
  const as = argOf(argv, "--as");
  const dryRun = argv.includes("--dry-run");
  if (!id || !as) {
    console.error("ask accept: <ISSUE> --as <AGENT> (--body <markdown|-> | --body-file <path>) are required");
    return 1;
  }
  // CTL-2204: same rule as linear-reply.mjs, from the same leaf. Decided HERE so it also
  // covers --dry-run, which never reaches the linear-reply child process.
  const resolved = resolveCommentBody({
    body: argOf(argv, "--body"),
    bodyFile: argOf(argv, "--body-file"),
  });
  if (!resolved.ok) {
    console.error(`ask accept: ${resolved.message}`);
    return 1;
  }
  let body = resolved.stdin ? readFileSync(0, "utf8") : resolved.body;
  if (!body.trim()) {
    console.error("ask accept: comment body is empty (stdin produced nothing)");
    return 1;
  }

  // Refuse on a non-ask: `accept` moves a ticket to Done, and doing that to a work ticket
  // because someone mistyped an id is not recoverable by the person who typed it.
  // House read path (Codex #3509 P1): the replica behind its freshness gate, not the
  // rate-limited API. Unlike create's round trip, this ticket is not brand new, so the
  // replica can legitimately answer.
  const issue = readTicketViaReplica(id);
  if (issue == null) {
    console.error(
      `ask accept: could not read ${id} from the replica (absent, stale, or unparseable) — ` +
        "refusing rather than closing a ticket I cannot identify"
    );
    return 1;
  }
  const labels = (issue?.labels?.nodes ?? []).map((l) => l?.name).filter(Boolean);
  if (!labels.includes("catalyst-ask")) {
    console.error(
      `ask accept: ${id} is not an ask (no catalyst-ask label; has: ${labels.join(",") || "none"}) — refusing`
    );
    return 1;
  }
  if (dryRun) {
    console.log(
      JSON.stringify({
        action: "dry-run",
        id,
        as,
        wouldReply: body.slice(0, 120),
        wouldClose: true,
      })
    );
    return 0;
  }

  const replyScript = new URL("./linear-reply.mjs", import.meta.url).pathname;
  const reply = run("node", [replyScript, id, "--as", as, "--body", body]);
  if (reply.code !== 0) {
    // ⛔ Do NOT close on a failed reply: a Done ask with no recorded answer is worse than
    // an open one — it leaves the human's view clean and the decision unrecorded.
    console.error(
      `ask accept: reply FAILED (rc=${reply.code}) — ${id} left OPEN on purpose\n${reply.stderr.slice(0, 300)}`
    );
    return 1;
  }
  const done = run("linearis", ["issues", "update", id, "--status", "Done"]);
  if (done.code !== 0) {
    console.error(
      `ask accept: replied, but the Done transition failed (rc=${done.code}) — close ${id} by hand`
    );
    return 1;
  }
  console.log(JSON.stringify({ action: "accepted", id, as, closed: true }));
  return 0;
}

export const VERBS = Object.freeze(["create", "accept"]);

/**
 * isEntryPoint — was this module RUN, or imported?
 *
 * ⛔ CTCB-6 trap (a). The old test was `import.meta.url === "file://" + process.argv[1]`,
 * a raw string compare. The skill documents invoking this through
 * `$CLAUDE_PLUGIN_ROOT/scripts/ask.mjs`, which is a SYMLINK — so `import.meta.url` (the
 * resolved real path) never equalled `argv[1]` (the symlink path), the guard was false,
 * and the script EXITED 0 HAVING DONE NOTHING. No ticket, no error, no output. A careless
 * reader takes exit 0 for "filed", which is the worst possible failure for a tool whose
 * entire job is to prove an ask exists.
 *
 * Both sides are now resolved through `realpathSync`, so any path that reaches the same
 * file — symlink, relative, or `..`-laden — is recognised.
 */
export function isEntryPoint(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1 === "") return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    // Cannot resolve one of them — say NO here, and let the loud guard below decide.
    return false;
  }
}

const argv = process.argv.slice(2);
if (isEntryPoint()) {
  const verb = argv[0];
  if (verb === "create") process.exit(cmdCreate(argv.slice(1)));
  else if (verb === "accept") process.exit(cmdAccept(argv.slice(1)));
  else {
    usage();
    process.exit(1);
  }
} else if (VERBS.includes(argv[0])) {
  // ⛔ A NO-OP MUST BE LOUD. `realpathSync` fixes the symlink case specifically; this
  // catches the CLASS. If anything else ever makes the entry-point test false while the
  // user is plainly driving the CLI — a future bundler, a copied file, an exotic loader —
  // it exits NON-ZERO with the reason instead of exiting 0 having filed nothing.
  //
  // Gated on a real verb so a legitimate `import` of buildAskBody/verifyAskBody (which is
  // how CTC-694 was actually filed) stays silent: an importing process has its own argv.
  console.error(
    `ask.mjs: ⛔ invoked with the verb "${argv[0]}" but this module is not the entry point ` +
      `(argv[1]=${process.argv[1] ?? "<none>"}, module=${fileURLToPath(import.meta.url)}). ` +
      "NOTHING WAS FILED. Run the real path: ~/catalyst/plugin-source/plugins/dev/scripts/ask.mjs"
  );
  process.exit(3);
}
