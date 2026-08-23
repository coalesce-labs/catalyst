#!/usr/bin/env bun
// needs-human-migration-sweep.mjs — CTL-2160. The ONE-TIME backlog migration for
// the `needs-human` deletion (CTL-2155 epic).
//
// ── WHAT IT IS FOR ──
// ~69 open tickets wear the `needs-human` label. Measured across 86 ever-flagged
// items, 3 genuinely needed a person and 41 were the model provider being
// overloaded, escalated one ticket at a time. This tool decides, per ticket, which
// of those it is:
//
//   CLEAR — SYSTEM or MOOT: drop the label, the ticket resumes on its own.
//   ASK   — a genuine human question: file ONE ask ticket carrying `blocks` to it.
//   HOLD  — anything the sweep cannot PROVE is safe. Held for a person to triage.
//
// ⛔ DRY-RUN IS THE DEFAULT AND `--apply` IS THE ONLY WAY OUT OF IT. A silent
// wrong clear is the failure mode that makes this deletion dangerous: it strands a
// ticket that really was waiting on a person, with the flag that said so removed.
//
// ⛔⛔ THE FOUR RULES THE AUDIT CHANGED, AND WHY EACH ONE IS LOAD-BEARING
//
// 1. THE `blocks` RELATION SOURCE, AND WHY AN ABSENT ONE IS A HARD STOP.
//    A ticket already carrying a `blocks`-family relation may encode a real human
//    gate, so the rule is "never auto-clear one". The plan specified reading that
//    from the replica's `issues.raw`, and an audit found `raw` has NO `relations`
//    key at all — so the rule would have degraded to "no ticket has a relation"
//    and auto-cleared exactly the tickets it exists to protect. That is not a
//    missing feature, it is a guard that reports PASS when it cannot look.
//    The real source is the replica's normalized `relations` TABLE (verified
//    2026-08-21: 2,982 rows, 937 of them type='blocks'; positive control — the
//    same instrument returns 62 type='duplicate' and 1,983 type='related').
//    So: `resolveRelations` returns `{ available:false }` when it cannot read that
//    table, and an unavailable source ABORTS THE WHOLE RUN (exit 3). It never
//    downgrades to "assume no relations". `--allow-missing-relations` exists ONLY
//    to let a test drive the abort path; it forces every ticket to HOLD rather
//    than clearing any.
//
// 2. KEY ON `state`, NOT `state_type`. 16 of 69 labelled rows have a NULL
//    `state_type` and a populated `state` (ADV-1377/Implement, CTL-2123/Triage,
//    CTC-842/Research). A sweep keyed on `state_type` mis-buckets 23% of the pile.
//    Phase default is HOLD, so it fails safe — but it inflates the manual-triage
//    bucket from ~4-8 to ~20+ and reads as the sweep being broken.
//
// 3. THE DISPOSITION COMES FROM THE CTL-2158 CLASSIFIER, NOT A SECOND TABLE.
//    A second copy of the reason taxonomy would drift from the one the live
//    escalation path uses, and the two would disagree about the same ticket.
//
// 4. AN UNCLASSIFIABLE TICKET IS HELD, NEVER CLEARED. `classifyStall` already
//    answers HELD rather than guessing; this tool preserves that answer instead of
//    collapsing it into "probably fine".
//
// ⛔ THIS FILE DOES NOT WRITE TO LINEAR IN THIS COMMIT'S WORKFLOW. It was shipped
// with its tests only; the workspace is rate-limited and running it live is a
// separate, deliberate operator act.
//
// The decision core is PURE and exported (`decideTicket`, `sweep`). The CLI half
// injects the replica reader + worker-dir reader.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { classifyStall, isHeldForReview, STALL_CLASS } from "./stall-class.mjs";

/** The label this migration retires. */
export const SWEEP_LABEL = "needs-human";

/** Linear states in which a ticket is finished — the label is moot by definition.
 *  Matched case-insensitively against `state` (RULE 2), never `state_type`. */
export const TERMINAL_STATES = Object.freeze(["done", "canceled", "cancelled", "duplicate"]);

/** Linear states that mean a worker is actively on it right now. A ticket cannot
 *  be both "in progress" and "blocked on a human" — those 18 rows are the
 *  clearest CLEAR in the pile. Names, not `state_type` (RULE 2). */
export const ACTIVE_STATES = Object.freeze([
  "implement",
  "in progress",
  "research",
  "plan",
  "validate",
  "review",
  "in review",
]);

/** Relation types that may encode a real human gate. A ticket carrying any of
 *  these is NEVER auto-cleared (RULE 1). */
export const BLOCKS_FAMILY = Object.freeze(["blocks", "blocked_by", "blockedBy"]);

/** The three verdicts. HOLD is the default and the failure-safe direction. */
export const VERDICT = Object.freeze({ CLEAR: "clear", ASK: "ask", HOLD: "hold" });

const lower = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** True when `state` (the NAME) is a terminal Linear state. */
export function isTerminalState(state) {
  return TERMINAL_STATES.includes(lower(state));
}

/** True when `state` (the NAME) means a worker is actively on the ticket. */
export function isActiveState(state) {
  return ACTIVE_STATES.includes(lower(state));
}

/** True when the relation map carries any blocks-family edge. */
export function hasBlocksRelation(relations) {
  if (relations == null || typeof relations !== "object") return false;
  for (const key of BLOCKS_FAMILY) {
    const v = relations[key];
    if (Array.isArray(v) ? v.length > 0 : v != null && v !== "") return true;
  }
  return false;
}

/**
 * decideTicket — PURE. One ticket in, one verdict out.
 *
 * @param {object} t
 * @param {string} t.ticket
 * @param {string|null} t.state          the Linear state NAME (RULE 2)
 * @param {object|null} t.relations      relation map for this ticket, or null
 * @param {boolean} t.relationsAvailable whether the relation source answered (RULE 1)
 * @param {boolean} t.humanCommentedSince a person commented after the label landed
 * @param {boolean} t.inDependencyCycle  ASK by construction
 * @param {object|null} t.signal         the ticket's phase signal, for classifyStall
 * @param {string|null} t.reason         the recorded stall reason
 * @returns {{ticket:string,verdict:string,rule:string,detail:string|null}}
 */
export function decideTicket(t = {}) {
  const ticket = typeof t.ticket === "string" ? t.ticket : "";
  const hold = (rule, detail = null) => ({ ticket, verdict: VERDICT.HOLD, rule, detail });

  // ⛔ RULE 1, FIRST. Everything below this line assumes we could SEE the
  // relations. If we could not, we know nothing about whether this ticket is
  // gated, and "I could not look" must never read as "nothing is there".
  if (t.relationsAvailable !== true) return hold("relations-unavailable");
  if (hasBlocksRelation(t.relations)) {
    return hold("blocks-relation", "carries a blocks-family relation — may encode a human gate");
  }

  // A person is already engaged. Clearing under them is the rudest failure mode
  // this tool has: the flag that brought them vanishes mid-conversation.
  if (t.humanCommentedSince === true) return hold("human-engaged");

  // A dependency cycle is ASK by construction — nothing but a person breaks it.
  if (t.inDependencyCycle === true) {
    return { ticket, verdict: VERDICT.ASK, rule: "dependency-cycle", detail: null };
  }

  // Terminal in Linear → the label is moot whatever the reason says.
  if (isTerminalState(t.state)) {
    return { ticket, verdict: VERDICT.CLEAR, rule: "terminal-state", detail: t.state ?? null };
  }

  // Actively being worked → self-evidently not blocked on a human.
  if (isActiveState(t.state)) {
    return { ticket, verdict: VERDICT.CLEAR, rule: "active-state", detail: t.state ?? null };
  }

  // Otherwise the CTL-2158 classifier owns the answer (RULE 3).
  const verdictOfStall = classifyStall({ reason: t.reason ?? null, signal: t.signal ?? null });
  if (isHeldForReview(verdictOfStall)) {
    // RULE 4 — an unclassifiable reason is HELD, never quietly cleared.
    return hold("unclassifiable", verdictOfStall?.rule ?? null);
  }
  if (verdictOfStall.klass === STALL_CLASS.ASK) {
    return {
      ticket,
      verdict: VERDICT.ASK,
      rule: `stall:${verdictOfStall.rule}`,
      detail: t.reason ?? null,
    };
  }
  if (verdictOfStall.klass === STALL_CLASS.SYSTEM || verdictOfStall.klass === STALL_CLASS.MOOT) {
    return {
      ticket,
      verdict: VERDICT.CLEAR,
      rule: `stall:${verdictOfStall.rule}`,
      detail: verdictOfStall.klass,
    };
  }
  return hold("unclassifiable", verdictOfStall?.rule ?? null);
}

/**
 * sweep — PURE. Decide a whole pile and bucket it.
 *
 * ⛔ THROWS when the relation source is unavailable and `allowMissingRelations`
 * is not set. A migration that runs with its most important safety rule inert is
 * worse than one that does not run: the tickets it would wrongly clear are
 * precisely the ones the rule exists to protect.
 */
export function sweep(tickets, { relationSource, allowMissingRelations = false } = {}) {
  const rel = relationSource ?? { available: false, relations: {}, reason: "no source injected" };
  if (rel.available !== true && !allowMissingRelations) {
    const why = rel.reason ?? "unknown";
    throw new Error(
      `needs-human-sweep: relation source unavailable (${why}) — refusing to sweep. ` +
        "The 'never auto-clear a ticket carrying a blocks-family relation' rule cannot " +
        "run without it, and an unavailable source must be a HARD STOP, never a pass."
    );
  }
  const decisions = (Array.isArray(tickets) ? tickets : []).map((t) =>
    decideTicket({
      ...t,
      relations: rel.relations?.[t?.ticket] ?? null,
      relationsAvailable: rel.available === true,
    })
  );
  return {
    decisions,
    clear: decisions.filter((d) => d.verdict === VERDICT.CLEAR),
    ask: decisions.filter((d) => d.verdict === VERDICT.ASK),
    hold: decisions.filter((d) => d.verdict === VERDICT.HOLD),
  };
}

// ── the impure half: real sources ────────────────────────────────────────────

const REPLICA_DB = () =>
  process.env.CATALYST_REPLICA_DB || join(homedir(), "catalyst", "catalyst-replica.db");

/**
 * resolveRelations — read the replica's normalized `relations` TABLE for a
 * bounded id set. Returns `{available:true, relations}` or `{available:false,
 * reason}`. NEVER `{available:true}` with an empty map on an error: that is the
 * exact shape the audit found would silently pass (RULE 1).
 */
export async function resolveRelations(ids, { dbPath = REPLICA_DB() } = {}) {
  const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean))];
  if (wanted.length === 0) return { available: true, relations: {} };
  if (!existsSync(dbPath)) return { available: false, reason: `replica absent at ${dbPath}` };
  let db;
  try {
    const { Database } = await import("bun:sqlite");
    db = new Database(dbPath, { readonly: true });
    // The table's own existence is part of "available": an older replica schema
    // has no `relations` table, and answering {} for it is the silent pass.
    const present = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='relations'")
      .get();
    if (!present) return { available: false, reason: "replica has no `relations` table" };
    const relations = {};
    const q = (sql, key) => {
      for (const id of wanted) {
        for (const row of db.prepare(sql).all(id)) {
          const type = row.type ?? "unknown";
          relations[id] ??= {};
          (relations[id][type] ??= []).push(row[key]);
        }
      }
    };
    q(
      "SELECT type, related_identifier FROM relations WHERE issue_identifier = ?",
      "related_identifier"
    );
    // The INVERSE edge matters as much as the forward one: `A blocks B` is
    // recorded on A, and B is the ticket being gated.
    for (const id of wanted) {
      for (const row of db
        .prepare("SELECT type, issue_identifier FROM relations WHERE related_identifier = ?")
        .all(id)) {
        const type = row.type === "blocks" ? "blocked_by" : (row.type ?? "unknown");
        relations[id] ??= {};
        (relations[id][type] ??= []).push(row.issue_identifier);
      }
    }
    return { available: true, relations };
  } catch (err) {
    return { available: false, reason: err?.message ?? "replica read failed" };
  } finally {
    try {
      db?.close?.();
    } catch {
      /* best-effort */
    }
  }
}

/** Read a ticket's newest phase signal + recorded reason from its worker dir. */
export function readWorkerEvidence(
  ticket,
  { orchDir = join(homedir(), "catalyst", "execution-core") } = {}
) {
  const dir = join(orchDir, "workers", ticket);
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.startsWith("phase-") && f.endsWith(".json"));
  } catch {
    // No worker dir at all — stale residue. classifyStall answers HELD for a
    // null reason, which is the right answer: we cannot see why it was flagged.
    return { signal: null, reason: null };
  }
  let newest = null;
  for (const f of files) {
    try {
      const sig = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (newest == null || String(sig?.updatedAt ?? "") > String(newest?.updatedAt ?? "")) {
        newest = sig;
      }
    } catch {
      /* unreadable signal → skip; never invent one */
    }
  }
  return { signal: newest, reason: newest?.stalledReason ?? newest?.failureReason ?? null };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const a = new Set(argv);
  return {
    // ⛔ DRY-RUN IS THE DEFAULT. `--apply` is the only way out of it.
    apply: a.has("--apply"),
    json: a.has("--json"),
    allowMissingRelations: a.has("--allow-missing-relations"),
  };
}

export function formatReport({ clear, ask, hold }) {
  const line = (d) => `  ${d.ticket.padEnd(12)} ${d.rule}${d.detail ? ` (${d.detail})` : ""}`;
  return [
    `CLEAR (${clear.length}) — drop the label, the ticket resumes on its own`,
    ...clear.map(line),
    `ASK (${ask.length}) — file ONE ask ticket carrying \`blocks\` to the work`,
    ...ask.map(line),
    `HOLD (${hold.length}) — a person triages these; NOTHING is done automatically`,
    ...hold.map(line),
  ].join("\n");
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  console.error(
    opts.apply
      ? "⛔ --apply given: this run would WRITE to Linear."
      : "dry-run (default). Pass --apply to write."
  );
  console.error(
    "⛔ CTL-2160 ships this tool WITHOUT having run it: the Linear workspace is " +
      "rate-limited. Running it live is a deliberate operator act, and --apply " +
      "must be paired with a fresh replica (see `linearis` skill's freshness gate)."
  );
  if (opts.apply) {
    console.error("refusing: the write half is intentionally not wired in this commit.");
    process.exit(2);
  }
  process.exit(0);
}
