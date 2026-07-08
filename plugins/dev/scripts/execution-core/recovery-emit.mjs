#!/usr/bin/env node
// recovery-emit.mjs — CTL-1176 rung 3 CLI shim for the recovery-pass SKILL.
//
// The recovery-pass skill runs as a short-lived `claude --bg` worker (or a bare
// operator sweep), so it cannot import the scheduler's in-process emit/intent
// helpers. This shim is the auditable, reusable bridge: it lets the skill record
// a recovery outcome to the SAME two sinks the in-process router writes to, so
// the orch-monitor read-model (board-data.mjs:loadRecoveryOutcomes +
// deriveAttention) surfaces it identically whether the daemon dispatched the
// skill or Ryan invoked it by hand.
//
// Three subcommands (CTL-1439 P0a: every terminal conclusion of a recovery-pass
// session — fixed / leave-alone / escalated — persists a verdict to the intent
// ledger and a ticket-tagged event, so "correctly diagnosed" is never again
// indistinguishable from "nothing happened"):
//
//   fixed   --ticket CTL-N --reason "<plain past-tense changelog>" [--details JSON] [--orch-dir D]
//     Emits recovery.fixed (INFO). board-data folds it into autoFixed:true — the
//     recovered lane, NOT a needs-you row. No push. (Use this when the skill
//     resolved the item autonomously: rebased / merged / resolved a conflict /
//     re-dispatched a phase.) Also records the ledger verdict decision:"fixed"
//     with attempts PINNED (the dispatch-time marker already counted the attempt).
//
//   leave-alone --ticket CTL-N --reason "<why no action is needed>" [--details JSON]
//               [--orch-dir D] [--no-comment]
//     The reviewed-healthy verdict (stale flag / actively human-driven / false
//     positive). Emits recovery.verdict (INFO), records the ledger verdict
//     decision:"leave-alone" with the dispatch attempt REFUNDED (a leave-alone
//     must not burn a fix attempt), and posts a ticket-visible app-actor comment
//     (enforce-only, best-effort). defaultShouldSkipItem then suppresses
//     re-review for RECOVERY_LEAVE_ALONE_TTL_MS.
//
//   escalated --ticket CTL-N --escalation <EscalationPayload JSON> [--orch-dir D] [--phase P] [--no-comment]
//     The ONLY path that pages Ryan. It does THREE things, in order:
//       1. Emits recovery.escalated (WARN, severityNumber 13) carrying the rich
//          EscalationPayload (the composer-ready tagged union — manual /
//          authorization / decision) so notification-composer.ts can derive the
//          push short_text (≤140) + the inbox full_briefing.
//       2. Writes/merges that EscalationPayload as the `explanation` block on the
//          recovery-pass signal file (phase-recovery-pass.json) so the board's
//          deriveExplanation / deriveHumanQuestion / deriveEscalationType lift it
//          onto the BoardTicket and deriveAttention flips attention:"needs-human"
//          → the Needs-You inbox row + nav dot + the push gate (shouldNotify).
//          MERGES into the existing signal (never overwrites — drops bg_job_id).
//       3. Latches the host-local escalated intent so the router's shouldSkipItem
//          treats the escalation as terminal and stops re-acting (hands off to Ryan).
//
// The skill builds the EscalationPayload with escalation-explain.mjs (CTL-1130 —
// the banned-tautology gate) so "needs a human" can never reach the operator.
//
// Best-effort everywhere: a sink failure logs to stderr and continues; the skill
// must never crash on an emit. Exits 0 unless its args are unparseable.

import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildRecoveryEnvelope,
  defaultEmitEvent,
  defaultRecordIntent,
  recordVerdict,
} from "./recovery-reasoning.mjs";

const argv = process.argv.slice(2);
const sub = argv[0];

function get(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}
function getJson(flag, fallback) {
  const raw = get(flag);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function resolveOrchDir() {
  return get("--orch-dir") ?? process.env.CATALYST_ORCHESTRATOR_DIR ?? null;
}

// ── Ticket-visible comment (CTL-1439 P0a) ────────────────────────────────────
// The audit found 0/7 recovery-pass sessions posted a Linear comment even where
// the skill prompt instructed one — prompt-side discipline is not a guarantee.
// The shim therefore posts the verdict comment ITSELF (belt-and-braces): the
// same app-actor helper the router uses, gated enforce-only (mirrors the skill's
// _rp_comment gate; shadow must never write to Linear), suppressible with
// --no-comment, and best-effort (a comment failure never fails the emit — the
// ledger + event verdicts have already landed by the time this runs).
const RECOVERY_MODE = process.env.CATALYST_RECOVERY_PASS ?? "enforce";
const COMMENT_HELPER =
  process.env.CATALYST_COMMENT_POST_HELPER ??
  fileURLToPath(new URL("../lib/linear-comment-post.sh", import.meta.url));

function postTicketComment(ticket, body) {
  if (argv.includes("--no-comment")) return false;
  if (RECOVERY_MODE !== "enforce") return false;
  try {
    const res = spawnSync(COMMENT_HELPER, [ticket, body], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (res.status === 0) return true;
    // Codex P3: surface the helper's own diagnostic (its last stderr line names
    // the actual cause — token mint / issue resolution / mutation) instead of a
    // bare status code; the silent-failure class is exactly what CTL-1439 fixes.
    const helperErr = (res.stderr || res.error?.message || "")
      .toString()
      .trim()
      .split("\n")
      .pop();
    process.stderr.write(
      `recovery-emit: comment post failed on ${ticket} (status ${res.status ?? "spawn-error"}${helperErr ? `; ${helperErr}` : ""}) — continuing\n`,
    );
  } catch (err) {
    process.stderr.write(
      `recovery-emit: comment post threw on ${ticket}: ${err.message} — continuing\n`,
    );
  }
  return false;
}

// mergeExplanationIntoSignal — write the EscalationPayload as the signal's
// `explanation` block WITHOUT clobbering bg_job_id / status / the rest of the
// envelope (the signal-overwrite-drops-fields hazard). Read-modify-write, atomic.
function mergeExplanationIntoSignal(orchDir, ticket, phase, escalation) {
  if (!orchDir || !ticket) return false;
  const p = join(orchDir, "workers", ticket, `phase-${phase}.json`);
  let sig = {};
  try {
    if (existsSync(p)) sig = JSON.parse(readFileSync(p, "utf8")) ?? {};
  } catch {
    sig = {};
  }
  sig.explanation = escalation;
  sig.status = "needs-human"; // load-bearing for deriveAttention + the push gate
  if (!sig.needsHumanSince) sig.needsHumanSince = new Date().toISOString();
  sig.updatedAt = new Date().toISOString();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(sig, null, 2));
    renameSync(tmp, p);
    return true;
  } catch (err) {
    process.stderr.write(`recovery-emit: signal merge failed: ${err.message}\n`);
    return false;
  }
}

if (sub === "fixed") {
  const ticket = get("--ticket");
  const reason = get("--reason") ?? null;
  const details = getJson("--details", {});
  if (!ticket) {
    process.stderr.write("recovery-emit fixed: --ticket required\n");
    process.exit(2);
  }
  defaultEmitEvent({ type: "recovery.fixed", ticket, reason, details });
  // CTL-1439 (P0a): persist the verdict — without this the ledger keeps the
  // dispatch-time "dispatched" marker forever and the session's conclusion has
  // no durable trace. attempts stays PINNED inside recordVerdict (no double
  // count). Best-effort: a missing orchDir (bare operator sweep) skips the
  // ledger, the event above is still the record.
  try {
    recordVerdict(ticket, { verdict: "fixed", reason }, { orchDir: resolveOrchDir() });
  } catch (err) {
    process.stderr.write(`recovery-emit: verdict ledger write failed: ${err.message}\n`);
  }
  process.stdout.write(`recovery.fixed emitted for ${ticket}\n`);
  process.exit(0);
}

if (sub === "leave-alone") {
  const ticket = get("--ticket");
  const reason = get("--reason");
  const details = getJson("--details", {});
  if (!ticket || !reason) {
    process.stderr.write("recovery-emit leave-alone: --ticket and --reason required\n");
    process.exit(2);
  }

  // (1) Ticket-tagged verdict event — the durable log record (audit RC2 (c)).
  //     Caller details first: the verdict field is RESERVED (Codex P3 — a
  //     details.verdict must never contradict the ledger/comment).
  defaultEmitEvent({
    type: "recovery.verdict",
    ticket,
    reason,
    details: { ...details, verdict: "leave-alone" },
  });

  // (2) The ACTUAL verdict into the ledger, refunding the dispatch attempt
  //     (audit RC2 (b) + (d)). defaultShouldSkipItem now suppresses re-review
  //     for RECOVERY_LEAVE_ALONE_TTL_MS instead of burning toward the 2-strike latch.
  try {
    recordVerdict(ticket, { verdict: "leave-alone", reason }, { orchDir: resolveOrchDir() });
  } catch (err) {
    process.stderr.write(`recovery-emit: verdict ledger write failed: ${err.message}\n`);
  }

  // (3) Ticket-visible comment (audit RC2 (a)) — enforce-only, best-effort.
  postTicketComment(
    ticket,
    `🔍 **recovery-pass** reviewed this — ${reason}. No action needed; leaving as-is (re-checks automatically if still flagged after the leave-alone window).`,
  );

  process.stdout.write(`recovery.verdict (leave-alone) emitted for ${ticket}\n`);
  process.exit(0);
}

if (sub === "escalated") {
  const ticket = get("--ticket");
  const phase = get("--phase") ?? "recovery-pass";
  const orchDir = resolveOrchDir();
  const escalation = getJson("--escalation", null);
  if (!ticket || !escalation || !escalation.escalation_type) {
    process.stderr.write(
      "recovery-emit escalated: --ticket and a valid --escalation EscalationPayload required\n",
    );
    process.exit(2);
  }
  const reason =
    escalation.problem ?? escalation.call_to_action ?? "recovery-pass escalation";

  // (1) Emit recovery.escalated (WARN) with the rich, composer-ready payload.
  defaultEmitEvent({ type: "recovery.escalated", ticket, reason, escalation });

  // (2) Merge the explanation onto the signal → inbox row + push gate.
  mergeExplanationIntoSignal(orchDir, ticket, phase, escalation);

  // (3) Latch the escalated intent (terminal — router stops re-acting).
  //     CTL-1439 (P0a): carries the verdict fields so the ledger records the
  //     session's actual conclusion, not just the latch.
  try {
    defaultRecordIntent(
      ticket,
      {
        type: "recovery-pass",
        decision: "escalate",
        escalated: true,
        escalation,
        verdict: "escalate",
        verdictReason: reason,
      },
      { orchDir },
    );
  } catch (err) {
    process.stderr.write(`recovery-emit: intent latch failed: ${err.message}\n`);
  }

  // (4) CTL-1439 (P0a): ticket-visible escalation comment — the audit found the
  //     skill-side comment discipline failed in practice (0/7 posted), so the
  //     shim posts it itself. One line; the full briefing lives in the inbox.
  postTicketComment(
    ticket,
    `🔼 **recovery-pass** escalated this to the operator — ${escalation.call_to_action ?? reason}. (See your inbox.)`,
  );

  process.stdout.write(
    `recovery.escalated emitted for ${ticket} (type=${escalation.escalation_type})\n`,
  );
  process.exit(0);
}

process.stderr.write(
  "recovery-emit: usage: recovery-emit.mjs <fixed|leave-alone|escalated> --ticket CTL-N ...\n",
);
process.exit(2);
