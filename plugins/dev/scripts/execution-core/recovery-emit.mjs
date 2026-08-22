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
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  buildRecoveryEnvelope,
  defaultEmitEvent,
  defaultRecordIntent,
  recordVerdict,
  bumpEscalationDeferrals,
  readEscalationDeferrals,
  clearEscalationDeferrals,
  RECOVERY_MAX_ESCALATION_DEFERRALS,
} from "./recovery-reasoning.mjs";
// CTL-1568: this shim posts the escalation comment but never applied the
// needs-human LABEL, so an agent reply could not bring the row back to the inbox.
import { labelNeedsHumanUnlessBeliefOwner, beliefOwnsNeedsHuman } from "./label-guard.mjs";
// CTL-2158: classify the stall as SYSTEM / ASK / MOOT (or HELD) and stamp the
// verdict onto the signal. OUTPUT re-target only — the escalation logic above is
// untouched.
import {
  classifyStall,
  stallClassSignalFields,
  ESCALATION_PUBLISHED_FIELD,
} from "./stall-class.mjs";

// CTL-1568 (Codex #2861 P0): this file's shebang is `#!/usr/bin/env node` and the
// recovery-pass skill invokes it with `node`. A STATIC `import { applyLabel } from
// "./linear-write.mjs"` reaches linear-query.mjs → gateway-read.mjs → `bun:sqlite`,
// and Node throws ERR_UNSUPPORTED_ESM_URL_SCHEME during module LOADING — before
// subcommand dispatch — so `fixed`, `leave-alone` and `escalated` all died outright,
// not just the labelling path. Load it LAZILY instead: the import is evaluated only
// on the one enforce-mode branch that actually labels, so every other subcommand
// runs under plain Node with the Bun-only graph never touched.
//
// Verified by running `node recovery-emit.mjs` directly — the tests missed this
// because they spawn the CLI through Bun's `process.execPath` (fixed below, so the
// suite exercises the real `node` entrypoint the skill uses).
async function loadApplyLabel() {
  const mod = await import("./linear-write.mjs");
  return mod.applyLabel;
}


// hasEscalateHumanBelief — CTL-1568 (Codex #2861 P1): is there ACTUAL evidence that
// the belief engine queued a needs-human escalation for THIS ticket?
//
// `beliefOwnsNeedsHuman(env)` is literally `env.CATALYST_INTENTS_ENFORCE === "1"` — it
// identifies the configured owner and proves nothing about this ticket. But
// executeEscalations only ever labels tickets that have a current-tick
// `escalate_human` belief row, and R12 derives solely from the wedged-worker chain — a
// recovery-pass escalation produces no such row, and most parked tickets have no
// worker dir at all. So under enforcement the old predicate declared "the belief owner
// has this" for a ticket the belief engine will never touch: the label was skipped,
// the "(See your inbox.)" comment was posted anyway, and the intent latched. The human
// is pointed at an inbox row that does not exist.
//
// Node-safe by necessity: this CLI runs under `node` (see loadApplyLabel), so it cannot
// import the bun:sqlite-backed collector. Shell out to sqlite3 with the SAME query
// getEscalateHumanBelief uses, including the '/' subject boundary so CTL-1241 matches
// but CTL-12410 does not.
//
// Returns true | false | null(unknown — db absent, sqlite3 missing, or query failed).
// The caller treats anything other than `true` as NOT-owned, which is the fail-SAFE
// direction: we page a human rather than silently assume someone else did.
function hasEscalateHumanBelief(ticket) {
  const db = join(process.env.CATALYST_DIR || join(homedir(), "catalyst"), "beliefs.db");
  if (!existsSync(db)) return null;
  const res = spawnSync(
    "sqlite3",
    [
      "-readonly",
      db,
      `SELECT 1 FROM belief WHERE name = 'escalate_human' AND subject LIKE '${String(ticket).replace(/'/g, "''")}/%' ORDER BY tick_id DESC LIMIT 1;`,
    ],
    { encoding: "utf8" },
  );
  if (res.error || res.status !== 0) return null;
  return String(res.stdout || "").trim() === "1";
}

// replicaReadLabels — CTL-1568 (Codex #2861 P1): verify the label write-back against
// the local SQL replica instead of a live `linearis issues read`.
//
// applyLabel's read-back previously always went live. On the recovery-pass skill path
// that adds a rate-limited single-ticket API call per escalation to a shared fleet
// quota — exactly what AGENTS.md's read-path rule forbids, and the vector behind the
// prior 429 flaps.
//
// Freshness gate mirrors replica-read.mjs's isReplicaFresh EXACTLY, reimplemented here
// only because that module is bun:sqlite-backed and this CLI runs under node (same
// constraint as loadApplyLabel): prefer the writer's `.writer.lock` heartbeat — which
// advances on writer LIVENESS, not on data changes, so a quiet Linear feed does not
// look stale — and fall back to the db mtime only when the lock is absent. Threshold
// CATALYST_LINEAR_REPLICA_STALE_MS, default 5 min.
//
// Returns an array of label names, or NULL when the replica is stale/absent/unreadable
// — and null makes applyLabel fall through to its live read-back, i.e. the pre-existing
// behavior. So this can only ever REMOVE API calls, never weaken verification.
function replicaReadLabels(ticket) {
  const db = process.env.CATALYST_REPLICA_DB
    || join(process.env.CATALYST_DIR || join(homedir(), "catalyst"), "catalyst-replica.db");
  if (!existsSync(db)) return null;
  const thresholdMs = Number(process.env.CATALYST_LINEAR_REPLICA_STALE_MS) || 300_000;
  let fresh = false;
  try {
    fresh = Date.now() - statSync(db + ".writer.lock").mtimeMs <= thresholdMs;
  } catch {
    try { fresh = Date.now() - statSync(db).mtimeMs <= thresholdMs; } catch { return null; }
  }
  if (!fresh) return null; // stale writer → do NOT serve; caller falls back to live
  const res = spawnSync(
    "sqlite3",
    ["-readonly", db,
     `SELECT l.name FROM issue_labels il JOIN labels l ON l.id = il.label_id JOIN issues i ON i.id = il.issue_id WHERE i.identifier = '${String(ticket).replace(/'/g, "''")}';`],
    { encoding: "utf8" },
  );
  if (res.error || res.status !== 0) return null;
  return String(res.stdout || "").split("\n").map((x) => x.trim()).filter(Boolean);
}

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
import { postLinearCommentAsSpawnResult } from "./linear-comment-write.mjs"; // CTL-1889 inc 2
const COMMENT_HELPER =
  process.env.CATALYST_COMMENT_POST_HELPER ??
  fileURLToPath(new URL("../lib/linear-comment-post.sh", import.meta.url));

function postTicketComment(ticket, body) {
  if (argv.includes("--no-comment")) return false;
  if (RECOVERY_MODE !== "enforce") return false;
  try {
    // CTL-1889 inc 2: routed through the cloud write proxy under enforce. Under `off`
    // (the default) and `shadow` this still runs COMMENT_HELPER, byte-identical.
    const res = postLinearCommentAsSpawnResult(ticket, body, {
      caller: "recovery-emit",
      runHelper: (t, b) => spawnSync(COMMENT_HELPER, [t, b], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }),
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
  // CTL-1552: normalize the duplicate signal status. Escalation writes the terminal
  // "stalled" + a stalledReason (was the bespoke "needs-human"), so isTicketInFlight
  // frees the slot and there is ONE stalled representation. The needs-human SEMANTICS
  // ride on needsHumanSince + the explanation block + the Linear label/marker, which
  // deriveAttention + the push gate key off (not the raw status value). board-health's
  // NEEDS_HUMAN_STATUSES and recovery-pass-context's STUCK_SIGNAL_STATUSES already
  // include "stalled", so the ticket stays visible as stuck / needs-you.
  sig.status = "stalled";
  sig.stalledReason = "needs_human";
  // CTL-2158 — OUTPUT RE-TARGET. `needs_human` records THAT an escalation
  // happened and says nothing about why, so it can never tell an outage from a
  // judgment call. The class does. Additive: `status` and `stalledReason` are
  // unchanged, so every existing consumer of those reads exactly what it read
  // before; what is new is a durable, on-disk S/A/M/HELD verdict plus the
  // explicit "an escalation was already published" stamp that unstuck-sweep's
  // quiet-gate now keys on instead of the token (which CTL-2159 deletes).
  const verdict = classifyStall({
    reason: sig.failureReason ?? escalation?.observed?.reason ?? null,
    signal: sig,
    explanation: escalation,
    site: "recovery-emit-escalated",
  });
  Object.assign(sig, stallClassSignalFields(verdict));
  sig[ESCALATION_PUBLISHED_FIELD] = true;
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

  // (4) CTL-1568: apply the needs-human LABEL. This shim never did, which is why
  //     an agent reply could not bring the row back to the inbox and the CTL-1569
  //     ≥3-turn loop could never close. The signal write in (2) flips
  //     deriveAttention for a ticket that HAS a worker dir — but 10 of 12 parked
  //     tickets have none on either host (daemon.mjs:431-434), and for those the
  //     board synthesizes the inbox row from the LABEL alone. The signal is not a
  //     substitute for it.
  //
  //     Deliberately UNFENCED. fenceGuard needs the scheduler's multiHost/gateway/
  //     self, which a short-lived CLI has no cheap way to build; and every other
  //     write in this file (signal, ledger, comment) is already unfenced, so
  //     fencing only the label would recreate the exact CTL-1568 split it is meant
  //     to close — label suppressed, comment posted. fenceGuard's own fail-closed
  //     behaviour is untouched (AC #6).
  //
  //     Enforce-gated exactly like the comment: shadow mode must never write Linear.
  let labelled = false;
  if (RECOVERY_MODE === "enforce" && orchDir) {
    try {
      // CTL-1568 (Codex #2861 P0): resolve applyLabel HERE, not at module scope —
      // this is the only branch that needs linear-write.mjs, and importing it
      // eagerly killed the whole CLI under Node (see loadApplyLabel above). Top-level
      // `await` is available: this is an ESM `sub === "escalated"` block, not a
      // function body. Shadow mode never reaches this line, so it never pays the
      // import cost either.
      const applyLabel = await loadApplyLabel();
      labelled =
        labelNeedsHumanUnlessBeliefOwner(
          orchDir,
          ticket,
          // Replica-backed read-back (Codex #2861 P1) — falls back to the live
          // read only when the replica is stale/absent.
          { applyLabel: (a) => applyLabel({ ...a, readLabels: replicaReadLabels }) },
          // treatAlreadyAppliedAsLanded: this gate asks "is the label PRESENT?",
          // not "did I apply it on this call" (Codex #2861 P1).
          { site: "recovery-emit-escalated", treatAlreadyAppliedAsLanded: true },
        ) === true;
    } catch (err) {
      process.stderr.write(`recovery-emit: needs-human label write threw on ${ticket}: ${err.message}\n`);
    }
  }
  // A false return has two causes; only one is a broken escalation. When the belief
  // engine owns needs-human it applies the label out-of-band — ownership transferred,
  // so the comment stays truthful.
  // CTL-1568 (Codex #2861 P1): ownership requires BOTH the configured owner AND real
  // evidence the belief engine queued this ticket. Anything else (no row, no db, no
  // sqlite3) is treated as NOT-owned — fail-safe: page a human rather than assume.
  const ownedByBelief =
    !labelled &&
    beliefOwnsNeedsHuman(process.env) === true &&
    hasEscalateHumanBelief(ticket) === true;

  // (4b) Latch the escalated intent — ONLY once the label actually landed.
  //
  // CTL-1568 (Codex #2861 P1): this latch used to run BEFORE the label was even
  // attempted. `escalated: true` is TERMINAL — defaultSkipReason treats such an
  // intent as done for RECOVERY_TERMINAL_INTENT_TTL_MS (7 days) — so a transient
  // applyLabel failure (its own `{applied:false, reason:"transient"|"rate-limited"|
  // "verify-failed"}` path) left the ticket latched-but-unlabelled, with the comment
  // withheld and NOTHING retrying for a week. The sibling escalateExhaustedIntents
  // already documents and implements the correct order ("The attempt MUST precede
  // the ledger latch"); this site did the opposite.
  //
  // Now: attempt the label first, and only latch when it landed (or when the belief
  // engine owns it, i.e. ownership genuinely transferred). Otherwise leave the intent
  // UNLATCHED so the next recovery pass re-enters and retries, and bound that retry
  // with the same deferral counter escalateExhaustedIntents uses so a permanently
  // failing label degrades to a loud give-up instead of an infinite loop.
  if (labelled || ownedByBelief) {
    // Escalation completed cleanly — drop any deferral counter so a later,
    // unrelated failure starts from a clean slate.
    clearEscalationDeferrals(orchDir, ticket);
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
  } else {
    // bumpEscalationDeferrals returns NULL when the counter cannot be persisted.
    // Its contract (recovery-reasoning.mjs) is explicit: with no counter there is no
    // retry bound, so the caller must stay SILENT and retry quietly rather than emit
    // a WARN every tick of a full/read-only disk. Honor that — no latch, no output.
    const deferrals = bumpEscalationDeferrals(orchDir, ticket, new Date().toISOString());
    if (deferrals === null) {
      // unbounded → quiet retry, exactly as the counter's contract requires
    } else if (deferrals >= RECOVERY_MAX_ESCALATION_DEFERRALS) {
      // Retry budget exhausted — latch anyway so we stop re-entering forever, but
      // say so loudly: the ticket is escalated in the ledger WITHOUT the label.
      process.stderr.write(
        `recovery-emit: needs-human label failed ${deferrals}x for ${ticket}; latching escalation WITHOUT the label (retry budget exhausted)\n`,
      );
      try {
        defaultRecordIntent(
          ticket,
          { type: "recovery-pass", decision: "escalate", escalated: true, escalation, verdict: "escalate", verdictReason: reason },
          { orchDir },
        );
      } catch (err) {
        process.stderr.write(`recovery-emit: intent latch failed: ${err.message}\n`);
      }
    } else {
      process.stderr.write(
        `recovery-emit: needs-human label did not land for ${ticket} (attempt ${deferrals}/${RECOVERY_MAX_ESCALATION_DEFERRALS}); NOT latching so a later pass retries\n`,
      );
    }
  }

  // (5) CTL-1439 (P0a): ticket-visible escalation comment — the audit found the
  //     skill-side comment discipline failed in practice (0/7 posted), so the
  //     shim posts it itself. One line; the full briefing lives in the inbox.
  //     CTL-1568: gated on the label, so it never claims an inbox row that is not
  //     there. In shadow mode both are suppressed together, which is consistent.
  if (labelled || ownedByBelief || RECOVERY_MODE !== "enforce") {
    postTicketComment(
      ticket,
      `🔼 **recovery-pass** escalated this to the operator — ${escalation.call_to_action ?? reason}. (See your inbox.)`,
    );
  } else {
    // AC #5 — the split is a should-never-happen state; raise it loudly rather than
    // leaving a WARN line. Exit stays 0 (see below).
    defaultEmitEvent({
      type: "recovery.escalation.split",
      ticket,
      reason,
      site: "recovery-emit-escalated",
      // Codex #2861 P1: carry the retry count so the alarm distinguishes a one-off
      // transient from a ticket wedged against a permanently failing label.
      deferrals: readEscalationDeferrals(orchDir, ticket),
    });
    process.stderr.write(
      `recovery-emit: needs-human label did NOT land on ${ticket} — escalation comment withheld ` +
        `(the inbox row would not exist); raised recovery.escalation.split\n`,
    );
  }

  process.stdout.write(
    `recovery.escalated emitted for ${ticket} (type=${escalation.escalation_type}` +
      `, needs-human=${labelled ? "applied" : ownedByBelief ? "belief-owner" : "NOT-APPLIED"})\n`,
  );
  // CTL-1568 (O1): exit 0 even when the label did not land. The recovery-pass skill
  // invokes this shim as a bare bash call with no exit-code contract (SKILL.md:964),
  // so a non-zero exit would be interpreted ad-hoc by an LLM worker and could retry
  // the whole pass. recovery.escalation.split is the loud channel instead, and the
  // durable surfaces (event, signal, ledger) have already landed.
  process.exit(0);
}

process.stderr.write(
  "recovery-emit: usage: recovery-emit.mjs <fixed|leave-alone|escalated> --ticket CTL-N ...\n",
);
process.exit(2);
