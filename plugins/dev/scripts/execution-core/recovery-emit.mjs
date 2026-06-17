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
// Two subcommands:
//
//   fixed   --ticket CTL-N --reason "<plain past-tense changelog>" [--details JSON]
//     Emits recovery.fixed (INFO). board-data folds it into autoFixed:true — the
//     recovered lane, NOT a needs-you row. No push. (Use this when the skill
//     resolved the item autonomously: rebased / merged / resolved a conflict /
//     re-dispatched a phase.)
//
//   escalated --ticket CTL-N --escalation <EscalationPayload JSON> [--orch-dir D] [--phase P]
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
import {
  buildRecoveryEnvelope,
  defaultEmitEvent,
  defaultRecordIntent,
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
  process.stdout.write(`recovery.fixed emitted for ${ticket}\n`);
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
  try {
    defaultRecordIntent(
      ticket,
      { type: "recovery-pass", decision: "escalate", escalated: true, escalation },
      { orchDir },
    );
  } catch (err) {
    process.stderr.write(`recovery-emit: intent latch failed: ${err.message}\n`);
  }

  process.stdout.write(
    `recovery.escalated emitted for ${ticket} (type=${escalation.escalation_type})\n`,
  );
  process.exit(0);
}

process.stderr.write(
  "recovery-emit: usage: recovery-emit.mjs <fixed|escalated> --ticket CTL-N ...\n",
);
process.exit(2);
