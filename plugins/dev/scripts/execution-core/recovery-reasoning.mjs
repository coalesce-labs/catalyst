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
    decisions: { fix_seam: 0, fix_bounded_llm: 0, escalate: 0 },
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
    const rule = decision === "escalate" ? 3 : fix_class === "bounded-llm" ? 2 : 1;
    if (decision === "escalate") tickStats.decisions.escalate += 1;
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

    if (mode === "shadow") {
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

        try {
          recordIntent(item.ticket, {
            type: "recovery-pass",
            decision: "escalate",
            reason: classification.details.reason,
            escalation: escalationPayload,
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

  // Rule 3: Check for human escalations (default)
  return {
    decision: "escalate",
    fix_class: "human",
    details: {
      reason: determineEscalationReason(logsOutput, jobState, signal, beliefState),
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

  return reasons.length > 0 ? reasons.join("; ") : "Unclassified stuck state requires human review";
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
    str("recovery.gate_decision", details.gateDecision);
    str("recovery.gate_reason", details.gateReason);
    str("recovery.mode", details.mode);
    for (const [name, r] of Object.entries(details.invariants ?? {})) {
      num(`recovery.inv.${name}.failed`, r?.failed);
    }
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
  let dispatchTicket, countRecoveryPassCycles;
  try {
    ({ dispatchTicket } = deps.dispatchMod ?? requireSync("./dispatch.mjs"));
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
    r = dispatch(orchDir, ticket, RECOVERY_PASS_PHASE);
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

function recoveryIntentPath(orchDir, ticket) {
  return join(orchDir, ".recovery-intents", `${ticket}.json`);
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

  const escalated =
    Boolean(prior.escalated) ||
    Boolean(intent.escalated) ||
    intent.decision === "escalate"; // an escalate-pass latches escalated

  const entry = {
    ticket,
    ts: typeof prior.ts === "number" ? prior.ts : ts, // first-action timestamp
    lastTs: ts, // most-recent action timestamp (drives the cooldown window)
    decision: intent.decision,
    fix_class: intent.fix_class ?? prior.fix_class ?? null,
    attempts:
      typeof intent.attempts === "number"
        ? intent.attempts
        : (typeof prior.attempts === "number" ? prior.attempts : 0) + 1,
    escalated,
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

// defaultShouldSkipItem — true when recovery should NOT act this pass. Fail-OPEN
// on absent/malformed ledger (returns false → recovery proceeds). Evaluation
// order: escalated (terminal) → attempts (terminal) → cooldown (transient).
export function defaultShouldSkipItem(ticket, opts = {}) {
  const orchDir = opts.orchDir ?? resolveOrchDir();
  if (!orchDir) return false;
  const now = opts.now ?? (() => Date.now());
  const p = recoveryIntentPath(orchDir, ticket);

  let data;
  try {
    data = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return false; // no ledger / malformed → never acted → don't skip
  }

  // (c) already escalated → terminal, hand off to human, stop acting.
  if (data?.escalated === true) return true;

  // (b) attempts exhausted → stop self-healing.
  if (typeof data?.attempts === "number" && data.attempts >= RECOVERY_MAX_ATTEMPTS) return true;

  // (a) acted within the cooldown window → too soon, skip this pass.
  const last = typeof data?.lastTs === "number" ? data.lastTs : data?.ts;
  if (typeof last === "number" && now() - last < RECOVERY_COOLDOWN_MS) return true;

  return false;
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
