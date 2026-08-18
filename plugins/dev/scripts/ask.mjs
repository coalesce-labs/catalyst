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
import { readFileSync } from "node:fs";

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
 * missingBlocksFrom — which requested `--blocks` relations are not on the created ticket.
 *
 * "A `--relates-to` / `--blocks` list keeps only the LAST flag in some linearis versions"
 * (the ask skill's own gotcha). Without this the command exits 0 while every earlier work
 * ticket remains formally unblocked.
 */
export function missingBlocksFrom(blocks, readBackText) {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const text = typeof readBackText === "string" ? readBackText : "";
  return blocks.filter((b) => !text.includes(b));
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
  ask.mjs create --team <TEAM> --title <t> --why <text> [--option <label> ...]
                 [--default <text>] [--blocks <ISSUE>] [--priority <1-4>] [--dry-run]
  ask.mjs accept <ISSUE> --as <AGENT> --body <markdown|-> [--dry-run]

create files a correctly-shaped ask ticket, then READS IT BACK and proves the decision
trigger can parse its options. accept replies in-thread as the app actor and moves the
ticket to Done — refusing if the ticket is not an ask.`);
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
  if (dryRun) {
    console.log(
      JSON.stringify({ action: "dry-run", team, title, body, parsedOptions: pre.parsed }, null, 2)
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
    "catalyst-ask,ask/decision",
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
  const missingBlocks = missingBlocksFrom(blocks, readBack.stdout);

  console.log(
    JSON.stringify({
      action: "created",
      id,
      decidable: post.ok,
      reason: post.reason,
      parsedOptions: post.parsed,
      missingBlocks,
    })
  );
  if (missingBlocks.length > 0) {
    console.error(
      `ask create: ⚠️ ${id} filed, but these --blocks relations are NOT on it: ${missingBlocks.join(", ")} — ` +
        "add them by hand (linearis keeps only the last --blocks on some versions)."
    );
  }
  if (!post.ok) {
    console.error(
      `ask create: ⛔ ${id} exists but is NOT decidable (${post.reason}: ${post.note}) — fix the body before relying on it`
    );
    return 2;
  }
  return 0;
}

function cmdAccept(argv) {
  const id = argv[0];
  const as = argOf(argv, "--as");
  let body = argOf(argv, "--body");
  const dryRun = argv.includes("--dry-run");
  if (!id || !as || !body) {
    console.error("ask accept: <ISSUE> --as <AGENT> --body <markdown|-> are required");
    return 1;
  }
  if (body === "-") body = readFileSync(0, "utf8");

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

const argv = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}`) {
  const verb = argv[0];
  if (verb === "create") process.exit(cmdCreate(argv.slice(1)));
  else if (verb === "accept") process.exit(cmdAccept(argv.slice(1)));
  else {
    usage();
    process.exit(1);
  }
}
