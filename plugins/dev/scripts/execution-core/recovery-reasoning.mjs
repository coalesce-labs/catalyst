// recovery-reasoning.mjs — CTL-1176: LLM reasoning recovery sweep.
//
// Rung 3 (LLM tier) of the self-healing recovery ladder. Per stuck/failed/
// needs-human ticket, runs DIAGNOSE → PROPOSE → GUARDED-FIX:
//
//   DIAGNOSE (read-only):  reuse diagnostician.captureEvidence (CTL-937)
//   PROPOSE (side-effects): classify against CTL-828 decision boundary
//   GUARDED-FIX (act):     invoke seam OR one capped remediate run, record intent
//
// Rollout: OFF (default) → SHADOW (emit .would-* events, post evidence, invoke
// no seams) → ENFORCE. Operator gates enabled via config + env kill-switch.
//
// ── Autonomy boundary ───────────────────────────────────────────────────────
//
// Fix autonomously: typed/mechanical + bounded-LLM.
// Escalate when: LLM can't fix, needs human judgment, delivering X undelivers Y,
// trade-off/approval, or untyped/ambiguous. Boundary is config-tunable.
//
// ── Guardrails (ADR-022: derive/act bright line; ADR-023: shadow/off) ─────────
//
// • No open-ended loops: single read pass per item per invocation
// • One seam call OR one capped remediate run (never both)
// • Fenced like phase worker: claim/turn-cap/reclaim-eligible
// • Cooldown + intent ledger: reuse diagnostician dual-layer cooldown
// • R11 action_ineffective + max_attempts=2 → R12 forces escalate
// • Decide/act bright line: Datalog derives; this pass + seams act and emit back

import {
  mkdirSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  log as defaultLog,
  getEventLogPath,
} from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";
import { captureEvidence } from "./diagnostician.mjs";

// Wrap defaultLog to ensure it's a function (config.mjs may export an object)
const defaultLogFn = typeof defaultLog === "function" ? defaultLog : (msg) => {
  if (typeof defaultLog?.debug === "function") {
    defaultLog.debug(msg);
  } else if (typeof console?.log === "function") {
    console.log(msg);
  }
};

// linear-comment-post.sh — the app-actor OAuth comment helper (CTL-1182 path).
const LINEAR_COMMENT_POST_BIN = fileURLToPath(
  new URL("../lib/linear-comment-post.sh", import.meta.url),
);

// phase-agent-emit-complete — the canonical wake/synthetic-complete emitter, used
// by the CTL-1186 phase-pr re-dispatch to nudge the scheduler after re-arming.
const EMIT_COMPLETE_BIN = fileURLToPath(
  new URL("../phase-agent-emit-complete", import.meta.url),
);

// ─── Main entry point ──────────────────────────────────────────────────────

export function reasoningRecoveryPass(items, opts = {}) {
  const {
    mode = "off", // "off" | "shadow" | "enforce"
    classifyTicket = defaultClassifyTicket,
    invokeSeam = defaultInvokeSeam,
    invokeRemediateCapped = defaultInvokeRemediateCapped,
    // CTL-1176 rung 3 (recovery-pass): the goal-driven senior-engineer dispatcher
    // for the bounded-LLM path. Replaces the phase-remediate detour — instead of
    // disguising a pipeline-recovery brief as a fake verify finding and squeezing
    // it through a single-ticket verify⇄remediate worker, it writes a first-class
    // recovery-pass.json brief (diagnostician evidence + which deterministic seams
    // already failed) and dispatches the `recovery-pass` skill, which resolves
    // conflicts / rebases / merges / re-dispatches autonomously and authors the
    // inbox+push messages on escalation. The scheduler binds this to the tick's
    // orchDir. Injectable for tests; falls back to invokeRemediateCapped when a
    // caller (or a legacy test) only wired the remediate path (see below).
    invokeRecoveryPass: injectedInvokeRecoveryPass,
    recordIntent = defaultRecordIntent,
    postComment = defaultPostComment,
    emitEvent = defaultEmitEvent,
    shouldSkipItem = defaultShouldSkipItem,
    // CTL-1157 Workstream B: read prior intent attempts so a DEFER marker can pin
    // `attempts` (no auto-increment → does not burn the bounded-LLM budget).
    // Bound to the tick's orchDir at the scheduler call site (like recordIntent).
    readIntentAttempts = defaultReadIntentAttempts,
    // CTL-1157 Workstream C: write the curated 6-field explanation signal on every
    // enforce escalate so the Needs-You inbox + detail pane render it. Bound to the
    // tick's orchDir at the scheduler call site; default resolves orchDir from env
    // (a no-op when unset, e.g. unit tests).
    writeEscalationSignal = defaultWriteEscalationSignal,
    // CTL-1176: DIAGNOSE evidence-collector. Read-only — populates an item's
    // {logsOutput, jobState} from `claude logs` + the bg job state when the
    // caller didn't already attach them. Injectable for tests.
    captureEvidenceFn = captureEvidence,
    log = defaultLogFn,
    // CTL-1176: per-tick fix cap. Once this many FIX-actions have been ACTED on
    // in this single enforce invocation, the rest fall through to a lightweight
    // "deferred" outcome — no action, no cooldown burn — so the next tick picks
    // them up. Prevents a 19-item storm in one sweep. Default 3, env-overridable.
    maxFixesPerTick = Number(process.env.CATALYST_RECOVERY_MAX_FIXES_PER_TICK) || 3,
  } = opts;

  // CTL-1176 rung 3: resolve the effective bounded-LLM dispatcher. Precedence:
  //   1. an explicitly-injected invokeRecoveryPass (new wiring / new tests);
  //   2. an explicitly-injected invokeRemediateCapped WITHOUT a recovery-pass
  //      override (legacy tests that stub the remediate dispatch directly — keep
  //      them green; the brief/evidence shape is forward-compatible);
  //   3. the new default (defaultInvokeRecoveryPass) — production dispatches the
  //      recovery-pass skill, replacing the phase-remediate detour. All of this
  //      stays behind the existing CATALYST_RECOVERY_PASS flag: at mode=off
  //      NOTHING here runs (the early return above), so there is no live behavior
  //      change until an operator opts into shadow/enforce.
  const callerOverrodeRemediate = Object.prototype.hasOwnProperty.call(
    opts,
    "invokeRemediateCapped",
  );
  const effectiveInvokeRecoveryPass =
    injectedInvokeRecoveryPass ??
    (callerOverrodeRemediate ? invokeRemediateCapped : defaultInvokeRecoveryPass);

  if (mode === "off") {
    log("recovery-reasoning: mode=off, skipping");
    return { processed: 0, results: [], mode };
  }

  const results = [];
  // CTL-1176: count of FIX-actions actually taken this invocation (enforce only).
  let fixesThisTick = 0;

  // CTL-1287: per-tick decision visibility. The recovery pass historically emitted
  // ONLY on action (recovery.fixed / recovery.escalated); every skip was a bare
  // log() to stdout, invisible to Loki — so a board where every flagged item is
  // latched-escalated looked identical to a board the delegate never examined.
  // These counters + skip rosters feed one recovery.tick rollup per invocation
  // (the "did the delegate fire, and why/why-not" headline); recovery.decision is
  // emitted per classified item. ledgerSkipped is coarse (cooldown OR escalated-
  // latch) — splitting it needs the per-tick orchDir ledger read, which only
  // reaches this pure function via a scheduler.mjs injection (fenced; fast-follow).
  const tickStats = {
    queueSize: items.length,
    processed: 0,
    decisions: { fix_seam: 0, fix_bounded_llm: 0, escalate: 0, defer: 0 },
    actions: { fixed: 0, fixFailed: 0, escalated: 0, deferred: 0, errors: 0 },
    ledgerSkipped: [],
    terminalSkipped: [],
  };

  for (const item of items) {
    // Check cooldown / already-escalated
    if (shouldSkipItem(item.ticket)) {
      log(`recovery-reasoning: ${item.ticket} skipped (cooldown/escalated)`);
      tickStats.ledgerSkipped.push(item.ticket);
      continue;
    }

    // CTL-1243: never post the give-up comment on tickets that are already terminal.
    // Mirrors classifyStalledTicket's linearTerminal skip (unstuck-sweep.mjs:95-97).
    if (item.evidence?.linearTerminal) {
      log(`recovery-reasoning: ${item.ticket} skipped (linear-terminal)`);
      tickStats.terminalSkipped.push(item.ticket);
      continue;
    }

    // DIAGNOSE: reuse diagnostician evidence. If the caller didn't attach
    // logsOutput, capture it read-only now (claude logs + bg job state). This is
    // a pure collector — no env gate, no side effects (CTL-937 captureEvidence).
    let evidence = item.evidence || {};
    if (!evidence.logsOutput && item.bgJobId) {
      try {
        const captured = captureEvidenceFn(`${item.ticket}/${item.phase ?? ""}`, item.bgJobId, {});
        evidence = {
          ...evidence,
          logsOutput: captured.logsOutput ?? evidence.logsOutput ?? null,
          jobState: captured.jobState ?? evidence.jobState ?? null,
        };
      } catch (err) {
        log(`recovery-reasoning: ${item.ticket} evidence capture failed: ${err.message}`);
      }
    }

    // PROPOSE: classify per CTL-828
    let classification;
    try {
      classification = classifyTicket(evidence, { log });
    } catch (err) {
      log(`recovery-reasoning: ${item.ticket} classification error: ${err.message}`);
      tickStats.actions.errors += 1;
      results.push({
        ticket: item.ticket,
        decision: "error",
        reason: err.message,
      });
      continue;
    }

    const { decision, fix_class, details } = classification;

    // CTL-1287: this item reached the classifier — emit its per-item decision
    // (rule 1=seam, 2=bounded-llm, 3=escalate) and tally for the recovery.tick
    // rollup. Emitted in BOTH shadow and enforce: it records the classifier's
    // verdict, independent of whether the mode then acts on it.
    tickStats.processed += 1;
    const rule = decision === "escalate" || decision === "defer" ? 3 : fix_class === "bounded-llm" ? 2 : 1;
    if (decision === "escalate") tickStats.decisions.escalate += 1;
    else if (decision === "defer") tickStats.decisions.defer += 1;
    else if (fix_class === "bounded-llm") tickStats.decisions.fix_bounded_llm += 1;
    else tickStats.decisions.fix_seam += 1;
    emitEvent({
      type: "recovery.decision",
      ticket: item.ticket,
      fix_class,
      reason: details?.reason ?? null,
      details: { rule, decision, mode },
    });

    // GUARDED-FIX: act based on decision, record outcome
    let outcome = null;
    let actionLog = [];

    if (decision === "defer") {
      // CTL-1157 Workstream B: an untyped stuck item DEFERS rather than latching
      // at escalate. In ENFORCE, write a cooldown-ONLY marker — NO escalated latch,
      // and pin `attempts` to the prior value so it does NOT auto-increment. After
      // the 30-min window both the per-item path AND board-health's holistic pass
      // can reconsider it.
      //
      // CTL-1157 F #4 (Codex round-4): SHADOW must NOT write the marker. A
      // `decision:"defer"` marker is honored by defaultShouldSkipItem in ENFORCE too,
      // so a shadow-written defer marker would suppress the ticket for up to the whole
      // cooldown window after an operator flips shadow→enforce — shadow silently
      // mutating enforce scheduler state, violating the shadow-first contract (shadow =
      // telemetry only, zero mutation). Skipping the marker is safe here: the defer
      // path posts NO comment and defaultClassifyTicket is a pure deterministic
      // classifier, so re-processing a deferred item on the next tick costs only a
      // cheap re-classify + one recovery.would-defer emit — NOT the comment/fork storm
      // the CTL-1176 rate-limit marker on the fix/escalate shadow path guards against.
      if (mode !== "shadow") {
        const priorAttempts = (() => {
          try {
            return readIntentAttempts(item.ticket) ?? 0;
          } catch {
            return 0;
          }
        })();
        try {
          recordIntent(item.ticket, {
            type: "recovery-pass",
            decision: "defer",
            fix_class: fix_class ?? "board-health",
            attempts: priorAttempts, // pin → no auto-increment, no latch
          });
          actionLog.push("recorded defer marker (cooldown-only, no latch)");
        } catch (err) {
          log(`recovery-reasoning: ${item.ticket} defer marker write failed: ${err.message}`);
        }
      } else {
        actionLog.push("would-defer (shadow: no cooldown marker written)");
      }
      emitEvent({
        type: mode === "shadow" ? "recovery.would-defer" : "recovery.deferred",
        ticket: item.ticket,
        reason: details.reason,
        details: { mode },
      });
      tickStats.actions.deferred += 1;
      outcome = { ticket: item.ticket, decision: "defer", reason: details.reason, actionLog, mode };
    } else if (mode === "shadow") {
      // Shadow mode: emit .would-* events, post diagnoses, invoke nothing
      actionLog.push(`would-classify: ${decision} (${fix_class})`);
      const reasonStr = details.reason || "no reason";
      actionLog.push(`reason: ${reasonStr}`);

      // Post diagnosis comment
      const diagComment = formatDiagnosisComment(item.ticket, classification);
      try {
        postComment(item.ticket, diagComment, { mode: "shadow" });
        actionLog.push("posted diagnosis comment (shadow)");
      } catch (err) {
        log(`recovery-reasoning: ${item.ticket} comment post failed: ${err.message}`);
      }

      // Emit .would-* event
      if (decision === "fix") {
        emitEvent({
          type: "recovery.would-fix",
          ticket: item.ticket,
          fix_class,
          details,
        });
        actionLog.push("emitted recovery.would-fix");
      } else if (decision === "escalate") {
        emitEvent({
          type: "recovery.would-escalate",
          ticket: item.ticket,
          reason: details.reason,
        });
        actionLog.push("emitted recovery.would-escalate");
      }

      // CTL-1176: shadow STILL burns the cooldown ledger. Without a marker write,
      // shadow re-posts a diagnosis comment + re-emits a .would-* event for EVERY
      // qualifying item on EVERY tick (~14s) forever — 19 items × every tick is a
      // Linear/OAuth/fork storm. Recording a "shadow" intent makes the next tick's
      // shouldSkipItem honor the cooldown window exactly like enforce, so shadow is
      // a rate-limited dry-run, not an unconditional spammer. Latches escalated for
      // a would-escalate so a shadow escalation is terminal (mirrors enforce).
      try {
        recordIntent(item.ticket, {
          type: "recovery-pass",
          decision: decision === "escalate" ? "escalate" : "shadow",
          fix_class: decision === "fix" ? fix_class : null,
          escalated: decision === "escalate",
        });
        actionLog.push("recorded shadow intent (cooldown marker)");
      } catch (err) {
        log(`recovery-reasoning: ${item.ticket} shadow intent record failed: ${err.message}`);
      }

      outcome = { decision, fix_class, actionLog, mode: "shadow" };
    } else if (mode === "enforce") {
      // Enforce mode: actually invoke seams / remediate, record intent
      if (decision === "fix") {
        // CTL-1176: per-tick fix cap. Once maxFixesPerTick FIX-actions have been
        // taken this invocation, defer the rest — no action, no cooldown burn —
        // so the next scheduler tick processes them. Bounds a one-sweep storm.
        if (fixesThisTick >= maxFixesPerTick) {
          actionLog.push(`deferred: per-tick fix cap (${maxFixesPerTick}) reached`);
          tickStats.actions.deferred += 1;
          log(
            `recovery-reasoning: ${item.ticket} deferred — per-tick fix cap ${maxFixesPerTick} reached`,
          );
          results.push({
            ticket: item.ticket,
            decision: "deferred",
            fix_class,
            reason: `per-tick fix cap (${maxFixesPerTick}) reached`,
            actionLog,
            mode: "enforce",
          });
          continue;
        }
        fixesThisTick += 1;

        const fixOutcome = attemptFix(item, classification, {
          invokeSeam,
          invokeRecoveryPass: effectiveInvokeRecoveryPass,
          // CTL-1176 rung 3: thread the DIAGNOSE evidence into the fix so the
          // recovery-pass brief carries it (the bounded-LLM dispatcher consumes
          // the eyes' output rather than re-diagnosing from scratch).
          evidence,
          log,
        });
        actionLog = fixOutcome.actionLog;
        outcome = { ...fixOutcome, decision, fix_class };

        // Record intent
        try {
          recordIntent(item.ticket, {
            type: "recovery-pass",
            decision: "fix",
            fix_class,
            outcome: fixOutcome.success,
            details: fixOutcome.details,
          });
          actionLog.push("recorded recovery-pass intent");
        } catch (err) {
          log(`recovery-reasoning: ${item.ticket} intent record failed: ${err.message}`);
        }

        // Post audit comment
        const fixComment = formatFixComment(item.ticket, fixOutcome, classification);
        try {
          postComment(item.ticket, fixComment, { mode: "enforce" });
          actionLog.push("posted fix audit comment");
        } catch (err) {
          log(`recovery-reasoning: ${item.ticket} comment post failed: ${err.message}`);
        }

        // Emit result event
        emitEvent({
          type: fixOutcome.success ? "recovery.fixed" : "recovery.fix-failed",
          ticket: item.ticket,
          fix_class,
          reason: fixOutcome.reason,
          details: fixOutcome.details,
        });

        if (fixOutcome.success) {
          actionLog.push("emitted recovery.fixed");
          tickStats.actions.fixed += 1;
        } else {
          actionLog.push("emitted recovery.fix-failed");
          tickStats.actions.fixFailed += 1;
        }
      } else if (decision === "escalate") {
        const escalationPayload = buildEscalationPayload(item, classification);

        // CTL-1157 Workstream C: write the curated 6-field explanation signal so
        // the orch-monitor Needs-You inbox + detail pane render a real brief for a
        // router-originated escalation (previously they found no `explanation` and
        // rendered nothing). Best-effort in its OWN try/catch so a write failure
        // never skips the recordIntent latch below.
        try {
          writeEscalationSignal(item.ticket, escalationPayload, { log });
          actionLog.push("wrote curated escalation signal (phase-recovery-pass.json)");
        } catch (err) {
          log(`recovery-reasoning: ${item.ticket} escalation signal write failed: ${err.message}`);
        }

        try {
          recordIntent(item.ticket, {
            type: "recovery-pass",
            decision: "escalate",
            reason: classification.details.reason,
            escalation: escalationPayload,
            // CTL-1439: a genuine escalation IS the verdict — stamp it so the
            // ledger's verdict fields always agree with the decision.
            verdict: "escalate",
            verdictReason: classification.details.reason ?? null,
          });
          actionLog.push("recorded escalation intent");
        } catch (err) {
          log(`recovery-reasoning: ${item.ticket} escalation intent failed: ${err.message}`);
        }

        // Post escalation comment
        const escalComment = formatEscalationComment(item.ticket, classification);
        try {
          postComment(item.ticket, escalComment, { mode: "enforce" });
          actionLog.push("posted escalation comment");
        } catch (err) {
          log(`recovery-reasoning: ${item.ticket} comment post failed: ${err.message}`);
        }

        emitEvent({
          type: "recovery.escalated",
          ticket: item.ticket,
          reason: classification.details.reason,
          escalation: escalationPayload,
        });
        actionLog.push("emitted recovery.escalated");
        tickStats.actions.escalated += 1;

        outcome = { decision, reason: classification.details.reason, actionLog, mode: "enforce" };
      }
    }

    results.push(outcome || { ticket: item.ticket, decision, error: "no outcome" });
  }

  // CTL-1287: one rollup per invocation — the "did the delegate fire, and
  // why/why-not" headline. The scheduler only invokes this pass with a non-empty
  // queue (scheduler.mjs gates on rItems.length > 0), so this never spams Loki on
  // a quiet board: a recovery.tick line means there WAS flagged work this tick.
  // A LogQL filter on `recovery.tick` reconstructs every tick's reasoning across
  // the fleet — e.g. "queueSize:12 processed:0 ledgerSkipped:[12 tickets]" reads
  // as "the delegate looked, and everything is latched to a human".
  emitEvent({
    type: "recovery.tick",
    reason: `recovery pass (${mode}): ${tickStats.processed} processed, ${
      tickStats.ledgerSkipped.length + tickStats.terminalSkipped.length
    } skipped`,
    details: { mode, ...tickStats },
  });

  return {
    processed: results.length,
    results,
    mode,
  };
}

// ─── Classification logic (pure, injectable) ────────────────────────────────

export function defaultClassifyTicket(evidence, opts = {}) {
  const { log = defaultLogFn } = opts;

  // Extract evidence fields
  const { logsOutput, jobState, signal, beliefState, failureReason } = evidence;

  // Rule 1: Check for deterministic errors in logs
  const deterministic = checkDeterministicErrors(logsOutput, failureReason);
  if (deterministic) {
    return {
      decision: "fix",
      fix_class: deterministic.fix_class,
      details: {
        reason: deterministic.reason,
        seam_id: deterministic.seam_id,
      },
    };
  }

  // Rule 2: Check for bounded-LLM fixes
  const boundedLlm = checkBoundedLlmFixes(logsOutput, jobState, signal);
  if (boundedLlm) {
    return {
      decision: "fix",
      fix_class: "bounded-llm",
      details: {
        reason: boundedLlm.reason,
        brief: boundedLlm.brief,
      },
    };
  }

  // Rule 3: human escalation — but ONLY latch (escalate) when there is concrete
  // evidence a human is genuinely needed. CTL-1157 Workstream B: an UNTYPED stuck
  // item (no R12 belief, the generic "unclassified" reason) no longer dead-ends at
  // the permanent escalate latch; it DEFERS (cooldown-only, no latch) so the
  // holistic board-health delegate can triage it after the window.
  const reason = determineEscalationReason(logsOutput, jobState, signal, beliefState);
  const hasConcreteEvidence =
    Boolean(beliefState?.escalate_human) || reason !== UNCLASSIFIED_ESCALATION_REASON;
  if (hasConcreteEvidence) {
    return {
      decision: "escalate",
      fix_class: "human",
      details: { reason },
    };
  }
  return {
    decision: "defer",
    fix_class: "board-health",
    details: {
      reason: "No typed failure signature; holistic board-health delegate will triage",
    },
  };
}

// Check for deterministic errors that have registered seams
export function checkDeterministicErrors(logsOutput, failureReason) {
  // Check failureReason shortcuts first (no log scan needed)
  if (failureReason === "orphan-sweep-stale") {
    return {
      fix_class: "orphan_stale",
      seam_id: "orphan-reconcile",
      reason: "Orphan PR reconciliation needed",
    };
  }
  // CTL-1186: phase-pr push rejected because the GitHub token lacked workflow
  // scope. The token now has the scope, so the deterministic FIX is to re-arm
  // phase-pr (reset its failed signal → pending + wake the scheduler) and let it
  // re-run. This shortcut classifies CTL-1186 as FIX (re-dispatch), not escalate,
  // even when no `claude logs` buffer is available — the signal failureReason is
  // enough. Routed to the workflow-token-redispatch seam (defaultInvokeSeam).
  if (failureReason === "push_rejected_no_workflow_scope") {
    return {
      fix_class: "push_rejected_no_workflow_scope",
      seam_id: "workflow-token-redispatch",
      reason: "Push rejected (no workflow scope); re-arm phase-pr to re-run with the scoped token",
    };
  }
  // Merge-conflict and rebase-failed via failureReason → bounded-LLM, not a seam stub.
  // These are handled by checkBoundedLlmFixes; signal here so the caller can short-circuit
  // without a log scan when the signal file already contains the structured reason.
  if (failureReason === "merge-conflict" || failureReason === "rebase-failed") {
    return null; // fall through to bounded-LLM
  }

  if (!logsOutput) {
    return null;
  }

  const logs = String(logsOutput).toLowerCase();

  // Known deterministic patterns (stub; real implementation would check seam registry CTL-1219).
  // NOTE: merge_conflict is intentionally absent here. Real git conflicts ("CONFLICT (content):",
  // "rebase conflict", "could not apply") are resolvable by an agent reading both sides —
  // they belong in checkBoundedLlmFixes, not in a seam stub that always returns success:false.
  const patterns = [
    {
      pattern: "push.*rejected.*no.*workflow.*scope",
      fix_class: "push_rejected_no_workflow_scope",
      seam_id: "workflow-token-fallback",
      reason: "Push rejected: GitHub workflow scope missing",
    },
    {
      pattern: "unknown.*command",
      fix_class: "unknown_command",
      seam_id: "unknown-command-handler",
      reason: "Unknown command in shell output",
    },
  ];

  for (const p of patterns) {
    if (new RegExp(p.pattern).test(logs)) {
      return {
        fix_class: p.fix_class,
        seam_id: p.seam_id,
        reason: p.reason,
      };
    }
  }

  return null;
}

// Check for bounded-LLM fixes (small, verifiable)
export function checkBoundedLlmFixes(logsOutput, jobState, signal) {
  if (!logsOutput && !jobState && !signal) return null;

  const logs = String(logsOutput || "").toLowerCase();
  const details = jobState?.detail || "";
  const signalFailure = signal?.failureReason || "";

  // CTL-1243: stalled tickets carry stalledReason, not failureReason. The unstuck-sweep
  // (STALL_CATEGORY_MAP) routes source_conflict_ctl708_unavailable to force-push-if-clean;
  // the reasoning pass must classify it as a bounded-LLM FIX so it does NOT fall through
  // to Rule 3 and post the legacy give-up comment on the same tick.
  if (signal?.stalledReason === "source_conflict_ctl708_unavailable") {
    return {
      reason: "Source conflict (CTL-708 unavailable); agent should rebase and force-push-if-clean",
      brief: generateRemediateBrief("merge-conflict"),
    };
  }

  // Bounded-LLM patterns: small fixes that are verifiable via one phase-remediate run.
  //
  // Escalation bar is HIGH. An agent with full tool access can resolve most merge conflicts
  // if it reads both sides carefully. Only escalate when the conflict is a genuine design
  // incompatibility (two features that cannot coexist as shipped), requires approval (deleting
  // a merged feature), or the agent explicitly cannot determine which approach is correct after
  // trying. NOT reasons to escalate: conflict in a file, CI failure after rebase, stale branch.
  const patterns = [
    // ── Merge / rebase conflicts ──────────────────────────────────────────────────────────
    // Real git conflict output: "CONFLICT (content):", "merge conflict in", "could not apply",
    // "rebase conflict", "conflict merge tree". All are BOUNDED-LLM: read both sides, pick the
    // change consistent with this ticket's goal, only escalate if fix would delete another
    // ticket's already-merged feature or if the conflict spans a load-bearing API boundary.
    {
      pattern: "conflict.*merge.*tree|merge conflict in|conflict \\(content\\)|could not apply|rebase.*conflict",
      reason: "Merge/rebase conflict detected; agent should read both sides and resolve",
      brief: generateRemediateBrief("merge-conflict"),
      failureReasons: ["merge-conflict", "rebase-failed"],
    },
    // ── Stale branch / stale PR ───────────────────────────────────────────────────────────
    {
      pattern: "stale.*main|branch.*diverged|your branch is behind",
      reason: "Working tree diverged from origin/main; rebase needed",
      brief: generateRemediateBrief("stale-branch"),
      failureReasons: ["stale-pr"],
    },
    // ── CI failure after rebase ───────────────────────────────────────────────────────────
    {
      pattern: "ci.*fail|check.*fail|test.*fail|lint.*fail",
      reason: "CI failure detected after rebase or push; agent should read logs and fix",
      brief: generateRemediateBrief("ci-failure"),
      failureReasons: ["ci-failure-after-rebase"],
    },
    // ── Package dependency issues ─────────────────────────────────────────────────────────
    {
      pattern: "bun.*install|cannot find package",
      reason: "Package dependencies out of sync",
      brief: generateRemediateBrief("bun-install"),
    },
    // ── TypeScript errors ─────────────────────────────────────────────────────────────────
    {
      pattern: "typescript.*error|ts.*error",
      reason: "TypeScript errors detected",
      brief: generateRemediateBrief("typescript-error"),
    },
  ];

  for (const p of patterns) {
    const logMatch = new RegExp(p.pattern, "i").test(logs) || new RegExp(p.pattern, "i").test(details);
    const signalMatch = p.failureReasons?.includes(signalFailure);
    if (logMatch || signalMatch) {
      return {
        reason: p.reason,
        brief: p.brief,
      };
    }
  }

  return null;
}

// Generate a structured brief for phase-remediate that includes explicit instruction
// on escalation bar: only return HUMAN if the fix would delete another ticket's merged feature.
export function generateRemediateBrief(category) {
  const briefs = {
    "merge-conflict": [
      "Read both sides of every conflicting hunk (git diff HEAD...MERGE_HEAD or git log --merge).",
      "Keep the changes consistent with this ticket's stated goal.",
      "If the conflict is purely additive (both sides add different things), keep both.",
      "Only return HUMAN if: (a) resolving would delete another ticket's already-merged feature,",
      "  (b) the conflict spans a load-bearing API boundary where the right choice is a design decision,",
      "  or (c) you have tried and genuinely cannot determine which approach is correct.",
      "After resolving: git add, git rebase --continue, push, re-trigger the failed phase.",
    ].join(" "),
    "stale-branch": [
      "Rebase against origin/main: git fetch origin && git rebase --autostash origin/main.",
      "If rebase produces conflicts, treat as merge-conflict brief.",
      "Force-push the rebased branch and re-trigger the CI check.",
    ].join(" "),
    "ci-failure": [
      "Read the CI failure logs (gh run view --log-failed).",
      "Fix the root cause (type error, lint, test failure).",
      "Commit the fix and push to re-trigger CI.",
      "Only escalate if the failure requires a design decision that is out of scope for this ticket.",
    ].join(" "),
    "bun-install": "Run bun install in affected packages and retry the phase.",
    "typescript-error": "Review and fix type errors reported by the compiler, then retry the phase.",
  };
  return briefs[category] ?? `Resolve the ${category} issue and retry the phase.`;
}

// CTL-1157: the sentinel "no concrete evidence" escalation reason. Shared between
// determineEscalationReason (its default) and defaultClassifyTicket's Rule-3
// escalate-vs-defer split (Workstream B): when the reason IS this sentinel and no
// R12 belief fired, there is no typed failure signature, so the item DEFERS to the
// holistic board-health delegate instead of dead-ending at a permanent escalate
// latch. Keep the exact string stable — it is the discriminator.
export const UNCLASSIFIED_ESCALATION_REASON = "Unclassified stuck state requires human review";

// Determine escalation reason (human decision)
export function determineEscalationReason(logsOutput, jobState, signal, beliefState) {
  const reasons = [];

  if (beliefState?.escalate_human) {
    reasons.push("Rule belief R12 escalate_human fired");
  }

  if (jobState?.detail) {
    reasons.push(`Job detail: ${jobState.detail}`);
  }

  if (jobState?.needs) {
    reasons.push(`Job needs: ${jobState.needs}`);
  }

  if (signal?.failureReason) {
    reasons.push(`Failure reason: ${signal.failureReason}`);
  }

  return reasons.length > 0 ? reasons.join("; ") : UNCLASSIFIED_ESCALATION_REASON;
}

// ─── Act phase (guarded fix: seam or remediate cap) ────────────────────────

function attemptFix(item, classification, { invokeSeam, invokeRecoveryPass, evidence, log }) {
  const { ticket } = item;
  const { fix_class, details } = classification;
  const actionLog = [];

  if (fix_class === "bounded-llm") {
    // CTL-1176 rung 3: dispatch the recovery-pass skill (goal-driven senior
    // engineer) instead of squeezing a pipeline-recovery brief through a
    // single-ticket phase-remediate worker. The brief carries the diagnostician
    // evidence + the failure reason + the guidance; the dispatcher additionally
    // reads which deterministic seams already ran/failed off disk so the skill
    // does NOT redo the narrow hands-work.
    try {
      const recoveryResult = invokeRecoveryPass(ticket, {
        brief: details.brief,
        reason: details.reason,
        evidence,
        phase: item.phase ?? null,
        bgJobId: item.bgJobId ?? null,
        failureReason:
          evidence?.failureReason ??
          evidence?.signal?.failureReason ??
          item.evidence?.failureReason ??
          null,
      });

      const recoveryStatus = recoveryResult.success ? "success" : "failed";
      actionLog.push(`recovery-pass dispatched: ${recoveryStatus}`);

      return {
        success: recoveryResult.success,
        reason: recoveryResult.reason,
        attempts: recoveryResult.attempts || 1,
        actionLog,
        details: recoveryResult.details || {},
      };
    } catch (err) {
      log(`recovery-reasoning: ${ticket} recovery-pass dispatch failed: ${err.message}`);
      actionLog.push(`recovery-pass error: ${err.message}`);
      return {
        success: false,
        reason: err.message,
        actionLog,
        details: { error: err.message },
      };
    }
  } else {
    // Invoke seam (for deterministic cases)
    try {
      const seamResult = invokeSeam(ticket, details.seam_id, {
        reason: details.reason,
        fix_class,
      });

      const seamStatus = seamResult.success ? "success" : "failed";
      actionLog.push(`seam ${details.seam_id} invoked: ${seamStatus}`);

      return {
        success: seamResult.success,
        reason: seamResult.reason,
        actionLog,
        details: seamResult.details || {},
      };
    } catch (err) {
      log(`recovery-reasoning: ${ticket} seam failed: ${err.message}`);
      actionLog.push(`seam error: ${err.message}`);
      return {
        success: false,
        reason: err.message,
        actionLog,
        details: { error: err.message },
      };
    }
  }
}

// ─── Comment & event formatting ─────────────────────────────────────────────

function formatDiagnosisComment(ticket, classification) {
  const { decision, fix_class, details } = classification;
  const reasonStr = details.reason || "no reason";
  return `## CTL-1176 Diagnosis
Recovery reasoning pass classified this ticket.

**Decision:** ${decision}
**Class:** ${fix_class}
**Reason:** ${reasonStr}

(shadow mode — no action taken)`;
}

function formatFixComment(ticket, fixOutcome, classification) {
  const { fix_class, details } = classification;
  const status = fixOutcome.success ? "FIXED" : "FIX FAILED";
  const actionLogStr = (fixOutcome.actionLog || []).join("\n");

  return `## CTL-1176 Recovery Fix ${status}

**Class:** ${fix_class}
**Reason:** ${details.reason || "no reason"}

**Action Log:**
\`\`\`
${actionLogStr}
\`\`\`

**Details:**
\`\`\`json
${JSON.stringify(fixOutcome.details || {}, null, 2)}
\`\`\``;
}

function formatEscalationComment(ticket, classification) {
  const { details } = classification;

  return `## CTL-1176 Recovery Escalation

Reasoning pass determined this requires human judgment.

**Reason:** ${details.reason || "unclassified"}

This ticket is now marked for human review.`;
}

// synthesizeEscalationExplanation — PURE. Build the 6-field curated brief
// (the keys match orch-monitor board-data.mjs EXPLANATION_RENDER_FIELDS exactly:
// call_to_action / outcome / problem / why_you / why_not_auto / what_to_do)
// (+escalation_type for deriveEscalationType) from a buildEscalationPayload-shaped
// object. The fields that pass through verbatim (call_to_action/problem/
// why_not_auto) come from the payload; outcome/why_you/what_to_do are synthesized
// when the payload doesn't already carry a richer authored value. Never
// tautological ("requires human judgment").
export function synthesizeEscalationExplanation(escalationPayload = {}) {
  const p = escalationPayload || {};
  const reason = p.observed?.diagnosis ?? p.problem ?? "an unclassified stuck state";
  const instructions = Array.isArray(p.instructions) ? p.instructions.filter(Boolean) : [];
  const what_to_do = instructions.length
    ? `${instructions.map((s) => String(s).replace(/[.\s]+$/, "")).join(". ")}. Once resolved, the next scheduler tick picks it up.`
    : (p.remediation_then_retry
      ?? "Resolve the stuck state by hand; the next scheduler tick re-evaluates the ticket and re-dispatches if appropriate.");
  const outcome = p.remediation_then_retry
    ?? "Once the stuck state is resolved by hand, the next scheduler tick re-evaluates the ticket and re-dispatches if appropriate.";
  const why_you = p.why_you
    ?? `No autonomous fix path matched this failure: ${reason}. A human must read the raw evidence and decide: re-dispatch the phase, fix the branch by hand, or close the ticket.`;
  const why_not_auto = p.why_not_auto
    ?? p.blocked_capability
    ?? "neither a deterministic act-seam nor a bounded-LLM fix matched this failure signature, so the pass has no safe action to take";
  return {
    escalation_type: typeof p.escalation_type === "string" ? p.escalation_type : "manual",
    call_to_action: p.call_to_action ?? `Look at this ticket's worker log and decide whether to re-dispatch the phase, fix the branch by hand, or close it`,
    problem: p.problem ?? `This ticket is stuck and the recovery pass could not classify it for an autonomous fix: ${reason}`,
    why_you,
    why_not_auto,
    what_to_do,
    outcome,
  };
}

// writeEscalationSignal — CTL-1157 Workstream C. Write workers/<ticket>/
// phase-recovery-pass.json carrying the curated `.explanation` so the UI renders a
// real Needs-You brief for a router-originated escalation. Read-modify-write
// (preserve a prior needsHumanSince) + atomic tmp+rename (mkdir -p the worker
// dir). Best-effort: catches all, logs via opts.log, NEVER throws.
function writeEscalationSignal(orchDir, ticket, escalationPayload, opts = {}) {
  const log = opts.log ?? defaultLogFn;
  if (!orchDir || !ticket) return;
  try {
    const p = join(orchDir, "workers", ticket, "phase-recovery-pass.json");
    const explanation = synthesizeEscalationExplanation(escalationPayload);
    let prior = {};
    try {
      prior = JSON.parse(readFileSync(p, "utf8")) ?? {};
    } catch {
      prior = {};
    }
    const nowIso = new Date().toISOString();
    const signal = {
      ...prior,
      // CTL-1157 F #6 (Codex round-4): persist the ticket on the signal. signal-reader
      // parseSignal keys off raw.ticket, and status:"needs-human" is NON-terminal, so
      // this fresh recovery-pass signal wins over the failed phase signal — WITHOUT a
      // ticket, readWorkerSignals() would then report ticket:null and scheduler-recovery
      // / board-health consumers would lose the escalated ticket after the first pass.
      ticket,
      status: "needs-human",
      needsHumanSince:
        typeof prior.needsHumanSince === "string" && prior.needsHumanSince !== ""
          ? prior.needsHumanSince
          : nowIso,
      updatedAt: nowIso,
      phase: RECOVERY_PASS_PHASE,
      explanation,
    };
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(signal, null, 2));
    renameSync(tmp, p); // atomic
  } catch (err) {
    try {
      log(`recovery-reasoning: ${ticket} escalation signal write failed: ${err.message}`);
    } catch {
      /* logging must never break the escalate path */
    }
  }
}

// defaultWriteEscalationSignal — the injectable default the scheduler binds to the
// tick's orchDir. Resolves orchDir from opts/env (a no-op when unset).
export function defaultWriteEscalationSignal(ticket, escalationPayload, opts = {}) {
  const orchDir = opts.orchDir ?? resolveOrchDir();
  if (!orchDir) return;
  writeEscalationSignal(orchDir, ticket, escalationPayload, opts);
}

// buildEscalationPayload — the composer-ready EscalationPayload for the router's
// OWN escalations (Rule-3 "human" classification, which never reaches the skill).
// CTL-1221's notification-composer.ts and board-data.mjs's deriveEscalationType /
// deriveHumanQuestion read this tagged union ({escalation_type, problem,
// call_to_action, ...}) to render the push short_text + the inbox briefing — so a
// thin {diagnosis, flags} blob renders nothing. This emits a valid `manual`-type
// payload with CONCRETE, non-tautological fields (NEVER "needs a human"):
// the recovery pass tried its registered seams + bounded-LLM fix and could not
// classify the stuck state, so a human must look. The skill's OWN escalations
// (richer — decision options, authorization risk) override this whenever the
// recovery-pass skill authors them and threads them back via the intent/event.
// The audit fields (observed/attempts) are preserved as passthrough.
function buildEscalationPayload(item, classification) {
  const evidence = item.evidence || {};
  const ticket = item.ticket;
  const reason = classification?.details?.reason || "unclassified stuck state";
  // If the skill already authored a rich escalation (CTL-1176 rung 3) and threaded
  // it onto the item/classification, prefer it verbatim — it carries the
  // executive-voiced summary/ask/options the operator should see.
  const authored =
    classification?.details?.escalation || item.authoredEscalation || null;
  if (authored && authored.escalation_type) {
    return {
      ...authored,
      observed: {
        ...(authored.observed ?? {}),
        diagnosis: reason,
        logs_available: !!evidence.logsOutput,
        job_state_available: !!evidence.jobState,
        belief_state: evidence.beliefState ?? null,
      },
    };
  }
  return {
    escalation_type: "manual",
    problem: `${ticket} is stuck and the recovery pass could not classify it for an autonomous fix: ${reason}`,
    call_to_action: `Look at ${ticket}'s worker log and decide whether it should be re-dispatched, abandoned, or fixed by hand`,
    blocked_capability:
      "automatic classification of this stuck state into a registered seam or bounded-LLM fix",
    instructions: [
      `Read the worker evidence for ${ticket} (claude logs + the failed phase signal)`,
      "Decide the correct next move (re-dispatch the phase, fix the branch by hand, or close the ticket)",
    ],
    remediation_then_retry:
      "Once the stuck state is resolved by hand, the next scheduler tick re-evaluates the ticket",
    why_not_auto:
      "neither a deterministic act-seam nor a bounded-LLM fix matched this failure signature, so the pass has no safe action to take",
    observed: {
      diagnosis: reason,
      logs_available: !!evidence.logsOutput,
      job_state_available: !!evidence.jobState,
      belief_state: evidence.beliefState ?? null,
    },
    timestamp: new Date().toISOString(),
  };
}

// ─── Default injectable implementations ─────────────────────────────────────

// Resolve the orchestrator runtime dir for host-local markers/seams. Mirrors
// the scheduler's CATALYST_ORCHESTRATOR_DIR convention (execution-core: one dir).
function resolveOrchDir() {
  return process.env.CATALYST_ORCHESTRATOR_DIR ?? null;
}

// ── (1) defaultEmitEvent — append a real OTel envelope to the unified log ─────
//
// Mirrors the *-event.mjs pattern (ratelimit-event.mjs / drain-event.mjs):
// build a pure OTel envelope, then one best-effort appendFileSync. NEVER throws —
// recovery correctness never branches on the emit succeeding.
//
// The flat event.type becomes attributes["event.name"] VERBATIM and the CTL key
// becomes attributes["event.label"] (mirrored in body.payload.ticket) — exactly
// what board-data.mjs:loadRecoveryOutcomes matches on. This is the load-bearing
// half of the emit↔read contract.

// promoteNumericAttrs — CTL-1291. Promote bounded numerics + bounded enums from
// a recovery event's details{} block into OTel attributes so a dashboard can
// CHART them. The forwarder ships ONLY attributes (+ event.name) to Loki —
// body.payload is dropped from the log LINE — so any number left only in
// details is unqueryable ("the event fired" but not "what it carried"). PURE.
// Cardinality guard: arrays promote as LENGTH (never the roster); only finite
// numbers and strings ≤64 chars pass; free-text/high-card stays in body.payload.
// (CTL-1290 appends a "recovery.board-scan" branch here.)
function promoteNumericAttrs(type, details) {
  if (!details || typeof details !== "object") return {};
  const a = {};
  const num = (k, v) => {
    if (typeof v === "number" && Number.isFinite(v)) a[k] = v;
  };
  const str = (k, v) => {
    if (typeof v === "string" && v.length > 0 && v.length <= 64) a[k] = v;
  };
  if (type === "recovery.tick") {
    num("recovery.queue_size", details.queueSize);
    num("recovery.processed", details.processed);
    num("recovery.decisions.fix_seam", details.decisions?.fix_seam);
    num("recovery.decisions.fix_bounded_llm", details.decisions?.fix_bounded_llm);
    num("recovery.decisions.escalate", details.decisions?.escalate);
    num("recovery.decisions.defer", details.decisions?.defer);
    num("recovery.actions.fixed", details.actions?.fixed);
    num("recovery.actions.fix_failed", details.actions?.fixFailed);
    num("recovery.actions.escalated", details.actions?.escalated);
    num("recovery.actions.deferred", details.actions?.deferred);
    num("recovery.actions.errors", details.actions?.errors);
    num("recovery.ledger_skipped", details.ledgerSkipped?.length);
    num("recovery.terminal_skipped", details.terminalSkipped?.length);
    str("recovery.mode", details.mode);
  } else if (type === "recovery.decision") {
    num("recovery.rule", details.rule);
    str("recovery.decision", details.decision);
    str("recovery.mode", details.mode);
  } else if (type === "recovery.board-scan") {
    // CTL-1290: whole-board health scan. Bounded scalars + enums chart; the
    // per-invariant failed-count rides as recovery.inv.<name>.failed. Rosters and
    // move-proposal arrays stay in body.payload (cardinality) — only their COUNTS
    // (invariants_failed, proposed.tier1/2/3) promote.
    num("recovery.invariants_failed", details.invariantsFailed);
    num("recovery.proposed.tier1", details.proposedTier1);
    num("recovery.proposed.tier2", details.proposedTier2);
    num("recovery.proposed.tier3", details.proposedTier3);
    // CTL-1435 (C1, Codex P2): promote the 0/1 dispatch flag so proposal-vs-dispatch
    // dashboards/alerts get a chartable dispatch-rate signal (the act object rides in
    // body.payload, which the OTel/Loki path does not make queryable).
    num("recovery.act_dispatched", details.actDispatched);
    str("recovery.gate_decision", details.gateDecision);
    str("recovery.gate_reason", details.gateReason);
    str("recovery.mode", details.mode);
    for (const [name, r] of Object.entries(details.invariants ?? {})) {
      num(`recovery.inv.${name}.failed`, r?.failed);
    }
    // CTL-1157 SLICE 3 (OTEL turn-56): promote the three stuck-cohort failed-counts
    // under the AGREED underscored top-level names so the Done-safety dashboards bind
    // to a stable contract (not the camelCase recovery.inv.<key>.failed mirror above).
    // These are the cohorts board-health was blind to before CTL-1157.
    num("cohort_phantom_merged_pr", details.invariants?.phantomMergedPr?.failed);
    num("cohort_orphaned_pr", details.invariants?.orphanedOpenPr?.failed);
    num("cohort_frozen_needs_human", details.invariants?.frozenNeedsHuman?.failed);
  }
  return a;
}

// buildRecoveryEnvelope — pure. Assembles the canonical envelope for a
// recovery.* event. Exported so tests can assert the contract shape directly.
export function buildRecoveryEnvelope(event, { now } = {}) {
  const ts = now ? now() : new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const {
    type,
    ticket = null,
    fix_class = null,
    reason = null,
    details = null,
    escalation = null,
  } = event;
  // Escalations carry WARN severity; fixes/triage carry INFO.
  const escalated = type === "recovery.would-escalate" || type === "recovery.escalated";
  return {
    ts,
    id: randomBytes(8).toString("hex"),
    observedTs: ts,
    severityText: escalated ? "WARN" : "INFO",
    severityNumber: escalated ? 13 : 9,
    traceId: null,
    spanId: null,
    resource: buildCatalystResource({ serviceName: "catalyst.execution-core" }),
    attributes: {
      // ← THE canonical name. The board reader matches attributes["event.name"].
      "event.name": type,
      "event.entity": "ticket",
      "event.action": String(type).replace(/^recovery\./, ""),
      // ← the CTL key — what loadRecoveryOutcomes keys its outcome map on.
      "event.label": ticket,
      ...(fix_class != null ? { "recovery.fix_class": fix_class } : {}),
      // CTL-1291: bounded numerics/enums promoted so the numbers are chartable.
      ...promoteNumericAttrs(type, details),
    },
    // human-readable mirror; also the reader's fallback ticket-key source.
    body: { payload: { ticket, type, fix_class, reason, details, escalation } },
  };
}

export function defaultEmitEvent(event, { logPath = getEventLogPath(), now } = {}) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, JSON.stringify(buildRecoveryEnvelope(event, { now })) + "\n");
    return true;
  } catch {
    return false; // best-effort, matches all *-event.mjs appenders
  }
}

// ── (2) defaultPostComment — app-actor Linear comment, fail-open ──────────────
//
// Invokes lib/linear-comment-post.sh with the markdown as a single argv element
// (never via stdin — multi-line is preserved because shell:false). The helper
// fails CLOSED (exit 1) on any error; we catch that here and never throw past a
// logged warning so a comment-post failure never wedges the recovery tick.
function defaultPostComment(ticket, markdown, opts = {}) {
  const log = opts.log ?? defaultLogFn;
  try {
    const res = spawnSync(LINEAR_COMMENT_POST_BIN, [ticket, markdown], {
      cwd: opts.cwd ?? process.cwd(), // must resolve projectKey from cwd ancestry
      env: { ...process.env, ...(opts.env ?? {}) },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (res.status === 0) {
      return { ok: true, via: "app-actor" };
    }
    log(
      `recovery-reasoning: ${ticket} comment post failed (status ${res.status}): ` +
        `${(res.stderr || res.error?.message || "unknown").toString().trim().split("\n").pop()}`,
    );
    return { ok: false, via: "app-actor", status: res.status };
  } catch (err) {
    log(`recovery-reasoning: ${ticket} comment post threw: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── (3) defaultInvokeSeam — invoke the CTL-1219 act-seam registry ─────────────
//
// Builds buildUnstuckActSeams(deps) and invokes the named seam by category. The
// recovery seam_id vocabulary maps to the frozen registry's category keys. The
// seam contract is throw=fail / return=success; we translate that into
// {success, reason, details}. The recovery pass owns all emit/post/intent.
//
// CTL-1186: "workflow-token-redispatch" / "workflow-token-fallback" have NO
// registry seam — they re-arm phase-pr by deleting its failed signal so the
// scheduler re-dispatches, then wake the loop via phase-agent-emit-complete.
//
// scheduler.mjs imports recovery-reasoning.mjs, so importing scheduler statically
// would be a CYCLE. defaultClearStall + buildUnstuckActSeams are therefore
// loaded lazily here (only at act-time, in enforce mode) via dynamic import.
const SEAM_ID_TO_CATEGORY = {
  "orphan-reconcile": "orphan-stale",
};

export function defaultInvokeSeam(ticket, seamId, brief = {}, deps = {}) {
  // CTL-1186 / CTL-1219: the two workflow-token classifications re-arm phase-pr
  // (reset its failed signal → pending) then wake the scheduler. Fully
  // synchronous — the file ops + emit are synchronous spawnSync underneath.
  if (seamId === "workflow-token-redispatch" || seamId === "workflow-token-fallback") {
    const orchDir = deps.orchDir ?? resolveOrchDir();
    if (!orchDir) {
      return { success: false, reason: "no orchDir for phase-pr re-dispatch", details: {} };
    }
    const phase = deps.phase ?? "pr";
    const signalPath = join(orchDir, "workers", ticket, `phase-${phase}.json`);
    try {
      if (existsSync(signalPath)) {
        let sig = {};
        try {
          sig = JSON.parse(readFileSync(signalPath, "utf8"));
        } catch {
          sig = {};
        }
        sig.status = "pending";
        delete sig.failureReason;
        const tmp = `${signalPath}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(sig, null, 2));
        renameSync(tmp, signalPath);
      }
      const res = spawnSync(
        EMIT_COMPLETE_BIN,
        [
          "--phase", "review",
          "--ticket", ticket,
          "--status", "complete",
          "--no-signal-update",
          "--orch-dir", orchDir,
          "--orch-id", ticket,
        ],
        { encoding: "utf8" },
      );
      return {
        success: res.status === 0 || res.status == null,
        reason: "re-armed phase-pr (reset failed→pending) and woke the scheduler",
        details: { phase, signalPath, wakeStatus: res.status ?? null, seam_id: seamId },
      };
    } catch (err) {
      return { success: false, reason: err.message, details: { error: err.message } };
    }
  }

  // Map recovery seam_id → frozen-registry category.
  const category = SEAM_ID_TO_CATEGORY[seamId];
  if (!category) {
    return { success: false, reason: `no registry seam for ${seamId}`, details: {} };
  }

  // Build the CTL-1219 frozen registry. unstuck-act-seams.mjs has NO transitive
  // import of scheduler/recovery-reasoning (verified), so a static import is safe
  // — no cycle. Production deps (clearStall, resolvePrState, jobLifecycle) fall
  // back to the module's real defaults; the scheduler can inject richer deps via
  // deps.actByCategory (a pre-built registry) when it already has them in scope.
  let registry = deps.actByCategory;
  if (!registry) {
    try {
      const { buildUnstuckActSeams } = requireSync("./unstuck-act-seams.mjs");
      registry = buildUnstuckActSeams({ orchDir: deps.orchDir ?? resolveOrchDir() });
    } catch (err) {
      return {
        success: false,
        reason: `registry build failed: ${err.message}`,
        details: { error: err.message },
      };
    }
  }
  if (typeof registry[category] !== "function") {
    return {
      success: false,
      reason: `registry seam '${category}' unavailable`,
      details: {},
    };
  }

  const seam = registry[category];
  const candidate = { ticket, ...(deps.candidate ?? {}) };
  const decision = deps.decision ?? { category, ...(brief ?? {}) };
  try {
    seam(candidate, decision); // return ignored; throws on hard failure
    return { success: true, reason: brief?.reason ?? `${category} seam applied`, details: {} };
  } catch (err) {
    return { success: false, reason: err.message, details: { error: err.message } };
  }
}

// ── (4) defaultInvokeRemediateCapped — ONE capped phase-remediate --bg ────────
//
// Dispatches a single phase-remediate worker, fire-and-forget. The structured
// brief reaches the worker ONLY through verify.json.findings[] (the SKILL reads
// that file), so we inject the brief as a synthetic high-severity finding before
// dispatching. The CTL-653 cap (3) is event-counted — we refuse a dispatch when
// the count is already at the cap. On a successful launch we return
// {success:true, dispatched:true, attempts:1} — "dispatched", NOT "fixed". The
// fix verdict only exists later in the re-run verify.json; the dispatch cooldown +
// event-counted cap prevent re-dispatch before it lands.
function injectBriefIntoVerify(orchDir, ticket, { brief, reason }) {
  const p = join(orchDir, "workers", ticket, "verify.json");
  let verify;
  try {
    verify = existsSync(p)
      ? JSON.parse(readFileSync(p, "utf8"))
      : { regression_risk: 5, findings: [], tests_attempted: 0 };
  } catch {
    verify = { regression_risk: 5, findings: [], tests_attempted: 0 };
  }
  verify.findings = Array.isArray(verify.findings) ? verify.findings : [];
  verify.findings.push({
    severity: "high", // high → remediate is REQUIRED to address it
    kind: "review",
    file: null,
    line: null,
    message: reason ?? "recovery-injected remediation brief",
    recommendation: brief ?? "Resolve the issue and retry the phase.",
  });
  mkdirSync(dirname(p), { recursive: true }); // worker dir exists in prod; be safe
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(verify, null, 2));
  renameSync(tmp, p); // atomic
}

export function defaultInvokeRemediateCapped(ticket, { brief, reason } = {}, deps = {}) {
  const orchDir = deps.orchDir ?? resolveOrchDir();
  if (!orchDir) {
    return { success: false, dispatched: false, attempts: 0, reason: "no orchDir", details: {} };
  }

  // Lazy imports — dispatch.mjs / event-scan.mjs / phase-fsm.mjs do NOT import
  // recovery-reasoning, so these are safe, but we keep them here to avoid loading
  // the dispatch graph for the off/shadow paths.
  let dispatchTicket, countRemediateCycles, REMEDIATE_PHASE, REMEDIATE_CYCLE_CAP;
  try {
    ({ dispatchTicket } = deps.dispatchMod ?? requireSync("./dispatch.mjs"));
    ({ countRemediateCycles } = deps.eventScanMod ?? requireSync("./event-scan.mjs"));
    ({ REMEDIATE_PHASE, REMEDIATE_CYCLE_CAP } = deps.fsmMod ?? requireSync("../lib/phase-fsm.mjs"));
  } catch (err) {
    return {
      success: false,
      dispatched: false,
      attempts: 0,
      reason: `remediate module load failed: ${err.message}`,
      details: { error: err.message },
    };
  }

  const countCycles = deps.countCycles ?? countRemediateCycles;
  const dispatch = deps.dispatchTicket ?? dispatchTicket;

  // (1) Enforce the CTL-653 hard cap HERE — phase-agent-dispatch does not.
  const attempts = countCycles({ ticket });
  if (attempts >= REMEDIATE_CYCLE_CAP) {
    return {
      success: false,
      dispatched: false,
      attempts,
      reason: "remediate-cycle-cap-exhausted",
      details: { cap: REMEDIATE_CYCLE_CAP },
    };
  }

  // (2) Write the brief into the channel the worker reads.
  try {
    injectBriefIntoVerify(orchDir, ticket, { brief, reason });
  } catch (err) {
    return {
      success: false,
      dispatched: false,
      attempts,
      reason: `verify.json brief injection failed: ${err.message}`,
      details: { error: err.message },
    };
  }

  // (3) Dispatch through the JS seam (worktree provisioning, claim, OTEL).
  let r;
  try {
    r = dispatch(orchDir, ticket, REMEDIATE_PHASE);
  } catch (err) {
    return {
      success: false,
      dispatched: false,
      attempts,
      reason: `dispatch threw: ${err.message}`,
      details: { error: err.message },
    };
  }

  if (r && r.code === 0) {
    // Fire-and-forget: dispatched, not fixed. Cooldown prevents re-dispatch.
    return {
      success: true,
      dispatched: true,
      attempts: 1,
      reason: "phase-remediate dispatched",
      details: {
        phase: REMEDIATE_PHASE,
        bg_job_id: r.signal?.bg_job_id ?? null,
        worktreePath: r.worktreePath ?? null,
      },
    };
  }
  return {
    success: false,
    dispatched: false,
    attempts,
    reason: r?.stderr ? `dispatch failed: ${String(r.stderr).trim()}` : "dispatch failed",
    details: { code: r?.code ?? null },
  };
}

// ── (4b) defaultInvokeRecoveryPass — ONE capped recovery-pass --bg (CTL-1176) ──
//
// The replacement for the bounded-LLM phase-remediate detour. Where remediate
// disguises a pipeline-recovery brief as a synthetic high-severity verify finding
// (injectBriefIntoVerify) and re-enters the single-ticket verify⇄remediate cycle,
// recovery-pass writes a FIRST-CLASS brief file (recovery-pass.json) carrying the
// diagnostician evidence + the failure reason + the deterministic seams that
// already ran/failed, then dispatches the `recovery-pass` skill — a goal-driven
// senior engineer that may rebase / resolve conflicts / merge / re-dispatch
// across the pipeline and authors the operator inbox+push on a legitimate
// escalation. Fire-and-forget (dispatched, not fixed); the host-local cooldown +
// the event-counted cap prevent a re-dispatch before the sweep lands.
//
// The recovery-pass cap (event-counted phase.recovery-pass.complete.<ticket>) is
// enforced HERE, mirroring the remediate cap — phase-agent-dispatch does not.
export const RECOVERY_PASS_PHASE = "recovery-pass";
export const RECOVERY_PASS_CYCLE_CAP =
  Number(process.env.CATALYST_RECOVERY_PASS_CYCLE_CAP) || 3;

// readUnstuckSeamsTried — read the deterministic act-seam idempotency markers the
// hands (unstuck-act-seams.mjs) leave under workers/<ticket>/ so the brief can
// tell the skill "these narrow seams already ran — do NOT redo them". A present
// marker means the seam fired this lifetime; the ticket is STILL in the recovery
// backlog, so it fired and did not unstick the item. Best-effort, pure-read.
function readUnstuckSeamsTried(orchDir, ticket, phase) {
  if (!orchDir || !ticket) return [];
  const ph = phase ?? "pr";
  const dir = join(orchDir, "workers", ticket);
  // (markerName → human category). Mirrors unstuck-act-seams.mjs markerPath():
  //   .unstuck-cleared-<phase>.applied      (dirty-tree seam)
  //   .unstuck-force-pushed-<phase>.applied (source-conflict seam)
  //   .unstuck-orphan-merge-<phase>.applied (orphan-stale seam)
  const seams = [
    { marker: `.unstuck-cleared-${ph}.applied`, category: "dirty-tree" },
    { marker: `.unstuck-force-pushed-${ph}.applied`, category: "source-conflict" },
    { marker: `.unstuck-orphan-merge-${ph}.applied`, category: "orphan-stale" },
  ];
  const tried = [];
  for (const s of seams) {
    try {
      if (existsSync(join(dir, s.marker))) {
        tried.push({ category: s.category, marker: s.marker, outcome: "ran-did-not-clear" });
      }
    } catch {
      /* best-effort — a stat error just omits the seam */
    }
  }
  return tried;
}

// writeRecoveryBrief — atomic tmp+rename of recovery-pass.json, the prior-phase
// artifact the skill reads (resolved from its --orch-dir + ticket, exactly like
// every other phase agent resolves its upstream artifact). NOT verify.json, NOT
// env — a brief file keyed in the worker dir is the auditable, reusable channel
// (env leaks the wrong ticket/phase to phase skills — operator memory).
function writeRecoveryBrief(orchDir, ticket, brief) {
  const p = join(orchDir, "workers", ticket, "recovery-pass.json");
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(brief, null, 2));
  renameSync(tmp, p); // atomic
}

export function defaultInvokeRecoveryPass(ticket, briefObj = {}, deps = {}) {
  const orchDir = deps.orchDir ?? resolveOrchDir();
  if (!orchDir) {
    return { success: false, dispatched: false, attempts: 0, reason: "no orchDir", details: {} };
  }

  const { brief, reason, evidence, phase, bgJobId, failureReason, boardContext } = briefObj;

  // Lazy imports — same rationale as defaultInvokeRemediateCapped (avoid loading
  // the dispatch graph on the off/shadow paths; no import cycle).
  let dispatchTicket, countRecoveryPassCycles, settleDispatchSync, isThenable, backstopOnRejection, sdkSignalRunnable;
  try {
    // CTL-1157 F2: also pull the async-settlement seam so an sdk dispatch Promise
    // is turned into the synchronous {code,async:true} the rest of this fn expects.
    // CTL-1157 F #4: sdkSignalRunnable is the SDK-aware verifySync — it confirms the
    // synchronously-written prelaunch signal is actually runnable, so a resolved
    // {code:1} (auth/prelaunch failure) is NOT reported as a successful dispatch.
    ({ dispatchTicket, settleDispatchSync, isThenable, backstopOnRejection, sdkSignalRunnable } =
      deps.dispatchMod ?? requireSync("./dispatch.mjs"));
    ({ countRecoveryPassCycles } = deps.eventScanMod ?? requireSync("./event-scan.mjs"));
  } catch (err) {
    return {
      success: false,
      dispatched: false,
      attempts: 0,
      reason: `recovery-pass module load failed: ${err.message}`,
      details: { error: err.message },
    };
  }

  const countCycles = deps.countCycles ?? countRecoveryPassCycles;
  const dispatch = deps.dispatchTicket ?? dispatchTicket;
  const cap = deps.cap ?? RECOVERY_PASS_CYCLE_CAP;

  // (1) Enforce the recovery-pass dispatch cap.
  const attempts = countCycles({ ticket });
  if (attempts >= cap) {
    return {
      success: false,
      dispatched: false,
      attempts,
      reason: "recovery-pass-cycle-cap-exhausted",
      details: { cap },
    };
  }

  // (2) Assemble + write the first-class brief the skill consumes. It carries the
  //     eyes' output (diagnostician evidence) and the hands' history (which
  //     deterministic seams already ran), so the skill picks up where the narrow
  //     passes failed instead of redoing them.
  const seamsTried = readUnstuckSeamsTried(orchDir, ticket, phase);
  const recoveryBrief = {
    schema: "recovery-pass-brief/v2", // v2 (CTL-1290): adds the whole-board boardContext block
    ticket,
    phase: phase ?? null,
    bgJobId: bgJobId ?? null,
    failureReason: failureReason ?? null,
    // CTL-1290: the holistic, read-only board snapshot (slots/queue/stuck-workers/
    // invariants) produced by board-health.buildBoardContext. Until now the
    // dispatched delegate got a per-item brief with ZERO board context; this is
    // how the daemon-side board scan reaches the LLM session. Null when the caller
    // (e.g. the per-item recovery pass) has no board scan to attach.
    boardContext: boardContext ?? null,
    // The DIAGNOSE output (read-only): claude logs buffer + bg job state + signal
    // + belief state. The skill reads this instead of re-diagnosing from scratch.
    diagnosis: {
      reason: reason ?? null,
      logsOutput: evidence?.logsOutput ?? null,
      jobState: evidence?.jobState ?? null,
      signal: evidence?.signal ?? null,
      beliefState: evidence?.beliefState ?? null,
    },
    // The hands' history: deterministic seams that already ran and did NOT clear
    // it. The skill must NOT redo these — it does the harder cross-pipeline moves.
    deterministicSeamsTried: seamsTried,
    // The remediation guidance (generateRemediateBrief output) + the autonomy
    // boundary. The skill body owns the full senior-engineer decision checklist;
    // this is the per-item hint, not the policy.
    guidance: brief ?? null,
    attempt: attempts + 1,
    maxAttempts: cap,
    writtenAt: new Date().toISOString(),
  };
  try {
    writeRecoveryBrief(orchDir, ticket, recoveryBrief);
  } catch (err) {
    return {
      success: false,
      dispatched: false,
      attempts,
      reason: `recovery-pass.json brief write failed: ${err.message}`,
      details: { error: err.message },
    };
  }

  // (3) Dispatch the recovery-pass skill through the JS seam (worktree
  //     provisioning, claim, OTEL, signal envelope). The dispatcher resolves the
  //     phase `recovery-pass` to /catalyst-dev:recovery-pass (skill_for_phase).
  let r;
  try {
    const rawR = dispatch(orchDir, ticket, RECOVERY_PASS_PHASE);
    // CTL-1157 F2: on an sdk fleet `dispatch` returns a Promise; settle it
    // synchronously into {code:0,async:true} so the success check below works
    // exactly as it does for a synchronous bg dispatch. On a bg fleet rawR is a
    // plain object → isThenable false → r = rawR (byte-identical no-op). On a
    // REJECTED async launch, onSettled composes the FAILED terminal backstop
    // (so the ticket doesn't strand at "dispatched") with a cooldown clear
    // (preserving attempts) so a reliably-failing launch retries sooner, bounded
    // by the attempts cap of 2.
    if (isThenable && isThenable(rawR)) {
      const onSettled = (_res, err) => {
        // CTL-1157 F #4: fail on BOTH a rejection AND a resolved non-zero code. A
        // resolved {code:1} (e.g. sdkRunPhaseAgent reporting an auth/prelaunch failure
        // WITHOUT throwing) previously slipped through — onSettled only checked `err`,
        // so the recovery-pass was recorded as dispatched while no worker was runnable.
        const failed = err || (_res && Number.isFinite(_res.code) && _res.code !== 0);
        if (!failed) return; // clean resolution → the worker owns its terminal event
        try {
          backstopOnRejection?.({ orchDir, ticket, phase: RECOVERY_PASS_PHASE, log: defaultLogFn })(_res, err ?? new Error(`sdk recovery-pass resolved code=${_res?.code}`));
        } catch {
          /* best-effort */
        }
        try {
          defaultClearIntentCooldown(ticket, { orchDir });
        } catch {
          /* best-effort */
        }
      };
      // verifySync (sdkSignalRunnable) makes the SYNCHRONOUS provisional code reflect
      // whether the prelaunch actually wrote a runnable signal — mirrors the canonical
      // monitor/scheduler/recovery entry-point wiring, so an sdk dispatch whose
      // prelaunch failed is reported as a dispatch FAILURE (r.code:1) instead of a
      // blind success.
      r = settleDispatchSync(rawR, {
        verifySync: () => (sdkSignalRunnable ? sdkSignalRunnable(orchDir, ticket, RECOVERY_PASS_PHASE) : true),
        onSettled,
      });
    } else {
      r = rawR;
    }
  } catch (err) {
    return {
      success: false,
      dispatched: false,
      attempts,
      reason: `dispatch threw: ${err.message}`,
      details: { error: err.message },
    };
  }

  if (r && r.code === 0) {
    // Fire-and-forget: dispatched, not fixed. Cooldown prevents re-dispatch.
    return {
      success: true,
      dispatched: true,
      attempts: 1,
      reason: "recovery-pass dispatched",
      details: {
        phase: RECOVERY_PASS_PHASE,
        bg_job_id: r.signal?.bg_job_id ?? null,
        worktreePath: r.worktreePath ?? null,
        seamsTriedCount: seamsTried.length,
        // CTL-1157 F P1: under executor=sdk the query() runs IN-PROCESS and settles
        // asynchronously; `r.pending` is the (never-rejecting) settled chain. The
        // disposable delegate-runner child MUST await this before process.exit, or it
        // kills the in-process worker it just launched. bg dispatch is synchronous →
        // r.pending is undefined → no-op.
        pendingSdk: r.async ? r.pending ?? null : null,
      },
    };
  }
  return {
    success: false,
    dispatched: false,
    attempts,
    reason: r?.stderr ? `dispatch failed: ${String(r.stderr).trim()}` : "dispatch failed",
    details: { code: r?.code ?? null },
  };
}

// requireSync — synchronous module access for the dispatch graph. The recovery
// pass calls invokeRemediateCapped synchronously; createRequire gives us a sync
// loader for these ESM siblings (Bun resolves .mjs through require). Throws on
// failure so the caller's try/catch surfaces a load error rather than a silent stub.
const _require = createRequire(import.meta.url);
function requireSync(spec) {
  return _require(spec);
}

// ── (5) Host-local cooldown + intent ledger (CTL-638 / CTL-1078 pattern) ──────
//
// HOST-LOCAL: this ledger lives at ~/catalyst/execution-core/.recovery-intents/
// (one file per ticket). ~/catalyst is per-host, so a second host running its
// own daemon keeps a SEPARATE ledger — the cooldown/max-attempts/escalated-latch
// guarantees are scoped to ONE machine. Cross-host claim (a durable lease on the
// ticket itself, e.g. a Linear field/label so every daemon sees it) is a SEPARATE
// follow-up for the dormant multi-host layer, out of scope here. Correct and
// complete for the single-host (mini) topology in production today.

// Cooldown window: 30-min default, env-overridable. NaN*x and 0*x are both falsy
// → fall through to the default (matches label-guard's Number(env) || default).
export const RECOVERY_COOLDOWN_MS =
  Number(process.env.CATALYST_RECOVERY_COOLDOWN_MIN) * 60 * 1000 || 30 * 60 * 1000;

// max_attempts: recovery passes before we stop self-healing. Env-overridable, default 2.
export const RECOVERY_MAX_ATTEMPTS =
  Number(process.env.CATALYST_RECOVERY_MAX_ATTEMPTS) || 2;

// CTL-1431: TTL on a terminal (escalated) recovery-intent. An escalated latch is
// no longer permanent — after this window the intent goes stale and the ticket
// re-enters the recovery triage funnel, so a months-old escalate cannot pin a
// ticket forever once the underlying blocker has cleared. Env-only, matching its
// siblings (NaN*x and 0*x are both falsy → fall through to the 7-day default).
export const RECOVERY_TERMINAL_INTENT_TTL_MS =
  Number(process.env.CATALYST_RECOVERY_TERMINAL_TTL_DAYS) * 864e5 || 7 * 864e5;

// CTL-1439 (P0a): TTL on a leave-alone verdict. A recovery-pass that reviewed the
// ticket and concluded "no action needed" (stale flag / actively human-driven /
// false positive) suppresses re-review for this window, then the ticket re-enters
// (conditions change). Deliberately much longer than the 30-min action cooldown —
// re-reviewing a verified-healthy ticket every half hour is the RC2 waste loop.
// Env-only, matching its siblings (NaN*x and 0*x are falsy → 24h default).
export const RECOVERY_LEAVE_ALONE_TTL_MS =
  Number(process.env.CATALYST_RECOVERY_LEAVE_ALONE_TTL_HOURS) * 3600e3 || 24 * 3600e3;

function recoveryIntentPath(orchDir, ticket) {
  return join(orchDir, ".recovery-intents", `${ticket}.json`);
}

// readDeferredBoardHealthIntents — CTL-1432 (B2). Enumerate the tickets whose
// recovery-intent is a DEFERRAL to the holistic board-health delegate
// (decision:"defer" + fix_class:"board-health" — the classifier's "no typed
// failure signature; the holistic board-health delegate will triage" path). Until
// now nothing consumed these, so a deferred ticket rotted (the delegate-mini
// session it implicitly routed to has been dormant since Jun 19). board-health's
// selectAnchorCandidates now folds these in as first-class self-owned anchors so
// the holistic pass actually dispatches a recovery-pass for them. Pure read,
// fail-open: absent dir / malformed entries → [].
export function readDeferredBoardHealthIntents(orchDir, { now = () => Date.now(), cooldownMs = RECOVERY_COOLDOWN_MS } = {}) {
  if (!orchDir) return [];
  const dir = join(orchDir, ".recovery-intents");
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (data?.decision === "defer" && data?.fix_class === "board-health") {
        // CTL-1440 (P0b): age off the FROZEN anchor `deferredSince` (set on the
        // first board-health defer, preserved across re-defers) — lastTs now
        // refreshes on every write, so keying it here would starve the consumer
        // (the pre-CTL-1432 bug). Legacy entries without the field fall back to
        // lastTs ?? ts (their lastTs was frozen, so it IS the anchor).
        const anchor =
          typeof data?.deferredSince === "number"
            ? data.deferredSince
            : typeof data?.lastTs === "number"
              ? data.lastTs
              : data?.ts;
        if (typeof anchor === "number" && now() - anchor < cooldownMs) continue;
        out.push(f.replace(/\.json$/, ""));
      }
    } catch {
      /* malformed → skip */
    }
  }
  return out;
}

// defaultRecordIntent — append/upgrade a recovery-intent ledger entry.
// Read-modify-write: preserve first-action ts, accrue attempts, latch escalated.
export function defaultRecordIntent(ticket, intent, opts = {}) {
  const orchDir = opts.orchDir ?? resolveOrchDir();
  if (!orchDir) return null;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? defaultLogFn;
  const dir = join(orchDir, ".recovery-intents");
  const p = recoveryIntentPath(orchDir, ticket);
  const ts = now();

  let prior = {};
  try {
    prior = JSON.parse(readFileSync(p, "utf8")) ?? {};
  } catch {
    prior = {}; // absent / malformed → start fresh
  }

  // CTL-1431 Codex F2: a prior escalated latch is preserved UNLESS it has aged past
  // the terminal TTL. Once expired, the ticket has re-entered triage (see
  // defaultShouldSkipItem) — recording a follow-up fix must NOT silently re-latch it
  // for another 7 days with a refreshed lastTs, or the re-entry accomplishes nothing.
  // A timestamp-less latch has no age and stays latched (matches F3 / the read path).
  // Re-escalating explicitly (intent.escalated / decision "escalate") still latches
  // afresh — a genuine new escalation with a new timestamp, so it TTLs again in 7d.
  const priorLast = typeof prior.lastTs === "number" ? prior.lastTs : prior.ts;
  const priorEscalationExpired =
    Boolean(prior.escalated) &&
    typeof priorLast === "number" &&
    ts - priorLast >= RECOVERY_TERMINAL_INTENT_TTL_MS;
  const escalated =
    (Boolean(prior.escalated) && !priorEscalationExpired) ||
    Boolean(intent.escalated) ||
    intent.decision === "escalate"; // an escalate-pass latches escalated

  // CTL-1440 (P0b, replaces the CTL-1432 lastTs FREEZE): the freeze shared one
  // field between two consumers wanting OPPOSITE semantics — the board-health
  // consumer needs the defer to AGE (a frozen anchor), while the per-item pass's
  // cooldown gate needs the LAST touch (refreshing) — and that collision drove
  // the RC3 defer storm (a frozen lastTs is permanently past-cooldown, so the
  // per-item pass re-processed + re-emitted every ~2-3s fs.watch tick for 71 min
  // on OTL-13). Decoupled: `deferredSince` is the frozen aging anchor (set on
  // the FIRST board-health defer, preserved across re-defers, consumed by
  // readDeferredBoardHealthIntents); `lastTs` now ALWAYS refreshes (drives the
  // cooldown gates), so a re-defer is throttled to once per cooldown window and
  // the consumer is still never starved. Legacy frozen entries fall back to
  // prior.lastTs as their anchor.
  const isBoardHealthDefer =
    intent.decision === "defer" && (intent.fix_class ?? prior.fix_class) === "board-health";
  const deferredSince = isBoardHealthDefer
    ? typeof prior.deferredSince === "number"
      ? prior.deferredSince
      : prior.decision === "defer" && typeof prior.lastTs === "number"
        ? prior.lastTs // legacy frozen entry — its lastTs WAS the anchor
        : ts
    : null;
  // CTL-1439 (P0a): the session's ACTUAL verdict rides in the ledger. A write that
  // carries a verdict stamps all three fields afresh. A verdict-less MARKER write
  // (the "dispatched" dispatch marker / a "defer" hand-off) PRESERVES the prior
  // verdict trail for observability — but a verdict-less TERMINAL/classifier write
  // (fix / escalate / shadow) CLEARS it (Codex P2 on #2586: preserving there let
  // a decision:"escalate" entry carry verdict:"leave-alone", corrupting the audit
  // surface — the verdict fields must never contradict the decision).
  const hasVerdict = typeof intent.verdict === "string";
  const isMarkerWrite = intent.decision === "dispatched" || intent.decision === "defer";
  const entry = {
    ticket,
    ts: typeof prior.ts === "number" ? prior.ts : ts, // first-action timestamp
    lastTs: ts, // most-recent action ts (drives cooldown; CTL-1440 always refreshes)
    ...(deferredSince != null ? { deferredSince } : {}),
    decision: intent.decision,
    fix_class: intent.fix_class ?? prior.fix_class ?? null,
    attempts:
      typeof intent.attempts === "number"
        ? intent.attempts
        : (typeof prior.attempts === "number" ? prior.attempts : 0) + 1,
    escalated,
    ...(hasVerdict
      ? { verdict: intent.verdict, verdictReason: intent.verdictReason ?? null, verdictTs: ts }
      : isMarkerWrite && typeof prior.verdict === "string"
        ? {
            verdict: prior.verdict,
            verdictReason: prior.verdictReason ?? null,
            verdictTs: prior.verdictTs ?? null,
          }
        : {}),
  };

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify(entry));
  } catch (err) {
    // Never let a marker write crash the tick — worst case the next tick re-acts.
    log(`recovery-reasoning: ${ticket} intent ledger write failed: ${err.message}`);
  }
  return entry;
}

// recordVerdict — CTL-1439 (P0a). Persist a recovery-pass session's ACTUAL
// conclusion into the intent ledger (the dispatch-time write is only a
// "dispatched" marker — see holisticBoardHealthAct). Three verdicts:
//   fixed       → decision:"fixed", attempts PINNED (the dispatch already counted
//                 this attempt; a verdict write must not double-count it).
//   leave-alone → decision:"leave-alone", attempts REFUNDED by one (a reviewed-
//                 healthy pass must not burn a fix attempt — audit RC1/RC2 (d));
//                 defaultShouldSkipItem then suppresses re-review for
//                 RECOVERY_LEAVE_ALONE_TTL_MS.
//   escalate    → decision:"escalate" (latches escalated:true — existing terminal
//                 semantics; the escalated TTL governs from here).
// Returns the written entry, or null on an unknown verdict / no orchDir.
export function recordVerdict(ticket, { verdict, reason = null } = {}, opts = {}) {
  if (verdict === "leave-alone") {
    const priorAttempts = defaultReadIntentAttempts(ticket, opts);
    return defaultRecordIntent(
      ticket,
      {
        type: "recovery-pass",
        decision: "leave-alone",
        attempts: Math.max(priorAttempts - 1, 0),
        verdict,
        verdictReason: reason,
      },
      opts,
    );
  }
  if (verdict === "fixed") {
    const priorAttempts = defaultReadIntentAttempts(ticket, opts);
    return defaultRecordIntent(
      ticket,
      {
        type: "recovery-pass",
        decision: "fixed",
        attempts: priorAttempts,
        verdict,
        verdictReason: reason,
      },
      opts,
    );
  }
  if (verdict === "escalate") {
    return defaultRecordIntent(
      ticket,
      {
        type: "recovery-pass",
        decision: "escalate",
        escalated: true,
        verdict,
        verdictReason: reason,
      },
      opts,
    );
  }
  return null;
}

// defaultSkipReason — CTL-1440 (P0b): the reason-bearing form of the skip gate.
// null → recovery may act; otherwise WHY it must not, one of:
//   "defer-cooldown" | "escalated" | "leave-alone" | "attempts-exhausted" | "cooldown".
// Lets the holistic act distinguish a RETRYABLE cooldown skip from a TERMINAL
// attempts-exhausted one (the "all-candidates-cooldown" misnomer, audit RC1) so
// C1's skippedReason and C2's wedge predicate tell the truth. Fail-OPEN on
// absent/malformed ledger. Evaluation order: defer (cooldown-only) → escalated
// (terminal, TTL) → leave-alone (verdict, TTL) → attempts (terminal) → cooldown.
export function defaultSkipReason(ticket, opts = {}) {
  const orchDir = opts.orchDir ?? resolveOrchDir();
  if (!orchDir) return null;
  const now = opts.now ?? (() => Date.now());
  const p = recoveryIntentPath(orchDir, ticket);

  let data;
  try {
    data = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // no ledger / malformed → never acted → don't skip
  }

  // CTL-1157 Workstream B: a DEFER marker is cooldown-ONLY — never attempts-
  // latched, never escalated. Gate purely on the 30-min window so after it elapses
  // BOTH the per-item path AND board-health's holistic pass can reconsider the
  // untyped stuck item (it never dead-ends at a permanent latch).
  if (data?.decision === "defer") {
    const last = typeof data?.lastTs === "number" ? data.lastTs : data?.ts;
    return typeof last === "number" && now() - last < RECOVERY_COOLDOWN_MS
      ? "defer-cooldown"
      : null;
  }

  // (c) already escalated → terminal latch, but TTL-bounded (CTL-1431). Within the
  // TTL it still skips (the ticket is handed off to a human); once the intent ages
  // past RECOVERY_TERMINAL_INTENT_TTL_MS it goes stale and the ticket RE-ENTERS the
  // recovery triage funnel. Return null DIRECTLY on expiry — do NOT fall through to
  // the attempts-exhausted branch below: an escalated intent already has attempts ≥
  // 2, so a fall-through would instantly re-latch there (that branch has no age
  // gate). Derived purely from timestamps, so NO file mutation on expiry (mirrors
  // the non-mutating defer precedent above).
  if (data?.escalated === true) {
    const last = typeof data?.lastTs === "number" ? data.lastTs : data?.ts;
    // A timestamp-less escalation (defaultClearIntentCooldown deletes both ts fields
    // while KEEPING escalated as a deliberately-terminal latch) cannot be aged out —
    // it stays terminal. (CTL-1431 Codex F3.)
    if (typeof last !== "number") return "escalated";
    return now() - last < RECOVERY_TERMINAL_INTENT_TTL_MS ? "escalated" : null;
  }

  // (CTL-1439 P0a) a LEAVE-ALONE verdict — the pass reviewed this ticket and
  // concluded no action is needed (stale flag / actively human-driven / false
  // positive). Skip re-review for the leave-alone TTL, then RE-ENTER with a
  // direct null (mirrors the escalated short-circuit above — never fall through
  // to the attempts latch: a reviewed-healthy ticket must not dead-end there).
  if (data?.decision === "leave-alone") {
    const last = typeof data?.lastTs === "number" ? data.lastTs : data?.ts;
    if (typeof last !== "number") return null; // timestamp-less verdict → fail-open, re-enter
    return now() - last < RECOVERY_LEAVE_ALONE_TTL_MS ? "leave-alone" : null;
  }

  // (b) attempts exhausted → stop self-healing (escalateExhaustedIntents turns
  // this into a LOUD escalation on the next sweep — CTL-1440).
  if (typeof data?.attempts === "number" && data.attempts >= RECOVERY_MAX_ATTEMPTS) {
    return "attempts-exhausted";
  }

  // (a) acted within the cooldown window → too soon, skip this pass.
  const last = typeof data?.lastTs === "number" ? data.lastTs : data?.ts;
  if (typeof last === "number" && now() - last < RECOVERY_COOLDOWN_MS) return "cooldown";

  return null;
}

// defaultShouldSkipItem — true when recovery should NOT act this pass. The
// boolean view over defaultSkipReason (same branches, same order — see above).
export function defaultShouldSkipItem(ticket, opts = {}) {
  return defaultSkipReason(ticket, opts) !== null;
}

// escalateExhaustedIntents — CTL-1440 (P0b): the terminal-state policy sweep.
// An intent whose fix attempts are exhausted (attempts >= max) WITHOUT a verdict
// must escalate LOUDLY — ledger escalated:true (B1's 7-day TTL then ages it out
// for re-entry), needs-human label (via the injected label-guard path), a
// curated brief on the recovery-pass signal (→ the monitor Needs-You inbox), an
// app-actor ticket comment, and a ticket-tagged recovery.escalated event —
// never a silent permanent latch (audit RC1: NOTHING un-latched an
// attempts-exhausted open ticket; they rotted for weeks). Idempotent: the
// escalated:true it writes excludes the entry from every later scan. Only the
// no-verdict decisions ("dispatched" dispatch markers and "fix" classifier
// writes) are swept — leave-alone / escalate / defer / fixed carry their own
// terminal policies. Never throws; returns the tickets it escalated.
export function escalateExhaustedIntents(orchDir, opts = {}) {
  const {
    now = () => Date.now(),
    maxAttempts = RECOVERY_MAX_ATTEMPTS,
    recordIntent = (t, i) => defaultRecordIntent(t, i, { orchDir, now }),
    postComment = defaultPostComment,
    emitEvent = defaultEmitEvent,
    labelNeedsHuman = null, // (orchDir, ticket) => void — scheduler wires label-guard
    writeSignal = (t, payload) => defaultWriteEscalationSignal(t, payload, { orchDir }),
    log = defaultLogFn,
  } = opts;
  if (!orchDir) return [];
  let files;
  try {
    files = readdirSync(join(orchDir, ".recovery-intents"));
  } catch {
    return [];
  }
  const escalatedTickets = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let data;
    try {
      data = JSON.parse(readFileSync(join(orchDir, ".recovery-intents", f), "utf8"));
    } catch {
      continue; // malformed → skip (fail-open)
    }
    const sweepable = data?.decision === "dispatched" || data?.decision === "fix";
    if (!sweepable || data?.escalated === true) continue;
    if (!(typeof data?.attempts === "number" && data.attempts >= maxAttempts)) continue;
    const ticket = f.replace(/\.json$/, "");
    const reason = `self-heal attempts exhausted (${data.attempts} dispatches without a recorded verdict)`;
    const escalation = {
      escalation_type: "authorization",
      problem: `${ticket} consumed ${data.attempts} recovery attempts (last decision "${data.decision}") without any recorded verdict — the self-heal loop is not resolving it.`,
      call_to_action: `look at ${ticket}: authorize another recovery cycle (clear its ledger latch), or take it over?`,
      recommendation: `inspect the last recovery-pass session for ${ticket}; repeated verdict-less deaths usually mean the ticket needs a human decision`,
      risk: `left latched it rots silently — the audit RC1 failure this sweep exists to prevent`,
      why_asking: reason,
      observed: {
        attempts: data.attempts,
        decision: data.decision ?? null,
        fix_class: data.fix_class ?? null,
      },
      attempts: [],
    };
    try {
      recordIntent(ticket, {
        type: "recovery-pass",
        decision: "escalate",
        escalated: true,
        attempts: data.attempts, // pin — exhaustion is the finding, not a new attempt
        verdict: "escalate",
        verdictReason: reason,
      });
    } catch (err) {
      log(`recovery-reasoning: ${ticket} exhausted-escalate ledger write failed: ${err.message}`);
      continue; // without the latch the sweep would re-fire every tick — try again next tick
    }
    try {
      writeSignal(ticket, escalation);
    } catch (err) {
      log(`recovery-reasoning: ${ticket} exhausted-escalate signal write failed: ${err.message}`);
    }
    try {
      labelNeedsHuman?.(orchDir, ticket);
    } catch (err) {
      log(`recovery-reasoning: ${ticket} exhausted-escalate label failed: ${err.message}`);
    }
    emitEvent({ type: "recovery.escalated", ticket, reason, escalation });
    try {
      postComment(
        ticket,
        `🔼 **recovery-pass** self-heal attempts exhausted on this ticket — escalated to the operator. ${reason}. (See your inbox.)`,
      );
    } catch {
      /* comment is best-effort; the signal + event are the durable surfaces */
    }
    escalatedTickets.push(ticket);
    log(`recovery-reasoning: ${ticket} attempts-exhausted → escalated loudly (CTL-1440)`);
  }
  return escalatedTickets;
}

// defaultForgetIntent — delete a ticket's recovery-intent ledger entry. The
// inverse of defaultRecordIntent. CTL-1242 (corrected scope): when the execution-
// core terminal sweep observes a ticket reach a terminal/merged state, it forgets
// the host-local escalated/cooldown latch so the ledger does not accumulate stale
// `.recovery-intents/<ticket>.json` files for finished tickets (which inflate the
// lifetime-escalation count and keep a closed ticket in the host-local ledger).
// The recovery router already drops terminal tickets via its backlog filter, so
// this is hygiene — not a functional gate. Idempotent: a missing file is a no-op.
// Returns true when a file was removed, false otherwise. Never throws.
export function defaultForgetIntent(ticket, opts = {}) {
  const orchDir = opts.orchDir ?? resolveOrchDir();
  if (!orchDir || !ticket) return false;
  const p = recoveryIntentPath(orchDir, ticket);
  try {
    unlinkSync(p);
    return true;
  } catch {
    return false; // absent (ENOENT) or unremovable → nothing to forget
  }
}

// defaultReadIntentAttempts — CTL-1157 Workstream B: the prior `attempts` count
// from a ticket's recovery-intent ledger entry (0 when absent/malformed). Lets a
// DEFER marker pin attempts so recordIntent does NOT auto-increment (a deferred
// item must not burn the bounded-LLM budget). Never throws.
export function defaultReadIntentAttempts(ticket, opts = {}) {
  const orchDir = opts.orchDir ?? resolveOrchDir();
  if (!orchDir || !ticket) return 0;
  const p = recoveryIntentPath(orchDir, ticket);
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return typeof data?.attempts === "number" ? data.attempts : 0;
  } catch {
    return 0;
  }
}

// defaultClearIntentCooldown — CTL-1157 Workstream F2 (MUST-FIX 5 / H2). Reset a
// ticket's cooldown window so a reliably-FAILING async (sdk) recovery launch
// retries sooner instead of being silenced for the full 30-min window. Deletes
// BOTH `lastTs` AND `ts` — defaultShouldSkipItem's cooldown branch falls back to
// `ts` when `lastTs` is absent, so clearing only `lastTs` would STILL silence via
// `ts`. PRESERVES `attempts` (the affirmed-sound storm bound: the attempts cap of
// 2 still latches a persistently-failing launch after two retries, so the faster
// retry is BOUNDED, not an immediate-retry storm) and `escalated` (the terminal
// latch). Distinct from defaultForgetIntent, which deletes the whole entry
// (resetting attempts to 0 → removes the storm bound). Idempotent; never throws.
export function defaultClearIntentCooldown(ticket, opts = {}) {
  const orchDir = opts.orchDir ?? resolveOrchDir();
  if (!orchDir || !ticket) return false;
  const p = recoveryIntentPath(orchDir, ticket);
  let prior;
  try {
    prior = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return false; // absent / malformed → nothing to clear
  }
  if (!prior || typeof prior !== "object") return false;
  delete prior.lastTs;
  delete prior.ts;
  try {
    writeFileSync(p, JSON.stringify(prior));
    return true;
  } catch {
    return false;
  }
}
