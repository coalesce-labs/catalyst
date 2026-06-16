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

import { log as defaultLog } from "./config.mjs";

// Wrap defaultLog to ensure it's a function (config.mjs may export an object)
const defaultLogFn = typeof defaultLog === "function" ? defaultLog : (msg) => {
  if (typeof defaultLog?.debug === "function") {
    defaultLog.debug(msg);
  } else if (typeof console?.log === "function") {
    console.log(msg);
  }
};

// ─── Main entry point ──────────────────────────────────────────────────────

export function reasoningRecoveryPass(items, opts = {}) {
  const {
    mode = "off", // "off" | "shadow" | "enforce"
    classifyTicket = defaultClassifyTicket,
    invokeSeam = defaultInvokeSeam,
    invokeRemediateCapped = defaultInvokeRemediateCapped,
    recordIntent = defaultRecordIntent,
    postComment = defaultPostComment,
    emitEvent = defaultEmitEvent,
    shouldSkipItem = defaultShouldSkipItem,
    log = defaultLogFn,
  } = opts;

  if (mode === "off") {
    log("recovery-reasoning: mode=off, skipping");
    return { processed: 0, results: [], mode };
  }

  const results = [];

  for (const item of items) {
    // Check cooldown / already-escalated
    if (shouldSkipItem(item.ticket)) {
      log(`recovery-reasoning: ${item.ticket} skipped (cooldown/escalated)`);
      continue;
    }

    // DIAGNOSE: reuse diagnostician evidence
    const evidence = item.evidence || {};

    // PROPOSE: classify per CTL-828
    let classification;
    try {
      classification = classifyTicket(evidence, { log });
    } catch (err) {
      log(`recovery-reasoning: ${item.ticket} classification error: ${err.message}`);
      results.push({
        ticket: item.ticket,
        decision: "error",
        reason: err.message,
      });
      continue;
    }

    const { decision, fix_class, details } = classification;

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

      outcome = { decision, fix_class, actionLog, mode: "shadow" };
    } else if (mode === "enforce") {
      // Enforce mode: actually invoke seams / remediate, record intent
      if (decision === "fix") {
        const fixOutcome = attemptFix(item, classification, {
          invokeSeam,
          invokeRemediateCapped,
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
        } else {
          actionLog.push("emitted recovery.fix-failed");
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

        outcome = { decision, reason: classification.details.reason, actionLog, mode: "enforce" };
      }
    }

    results.push(outcome || { ticket: item.ticket, decision, error: "no outcome" });
  }

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
  if (!logsOutput) {
    // Check failureReason as fallback
    if (failureReason === "orphan-sweep-stale") {
      return {
        fix_class: "orphan_stale",
        seam_id: "orphan-reconcile",
        reason: "Orphan PR reconciliation needed",
      };
    }
    return null;
  }

  const logs = String(logsOutput).toLowerCase();

  // Known deterministic patterns (stub; real implementation would check seam registry CTL-1219)
  const patterns = [
    {
      pattern: "push.*rejected.*no.*workflow.*scope",
      fix_class: "push_rejected_no_workflow_scope",
      seam_id: "workflow-token-fallback",
      reason: "Push rejected: GitHub workflow scope missing",
    },
    {
      pattern: "conflict.*merge.*tree",
      fix_class: "merge_conflict",
      seam_id: "force-rebase",
      reason: "Merge conflict detected; rebase and retry",
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

  // Fallback: check failureReason if provided
  if (failureReason === "orphan-sweep-stale") {
    return {
      fix_class: "orphan_stale",
      seam_id: "orphan-reconcile",
      reason: "Orphan PR reconciliation needed",
    };
  }

  return null;
}

// Check for bounded-LLM fixes (small, verifiable)
export function checkBoundedLlmFixes(logsOutput, jobState, signal) {
  if (!logsOutput && !jobState) return null;

  const logs = String(logsOutput || "").toLowerCase();
  const details = jobState?.detail || "";

  // Bounded-LLM patterns: small fixes that are verifiable via one phase-remediate run
  const patterns = [
    {
      pattern: "stale.*main",
      reason: "Working tree diverged from origin/main; rebase needed",
      brief: "Rebase against origin/main and retry",
    },
    {
      pattern: "bun.*install",
      reason: "Package dependencies out of sync",
      brief: "Run bun install in affected packages and retry",
    },
    {
      pattern: "typescript.*error|ts.*error",
      reason: "TypeScript errors detected",
      brief: "Review and fix type errors, retry phase",
    },
  ];

  for (const p of patterns) {
    if (new RegExp(p.pattern).test(logs) || new RegExp(p.pattern).test(details)) {
      return {
        reason: p.reason,
        brief: p.brief,
      };
    }
  }

  return null;
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

function attemptFix(item, classification, { invokeSeam, invokeRemediateCapped, log }) {
  const { ticket } = item;
  const { fix_class, details } = classification;
  const actionLog = [];

  if (fix_class === "bounded-llm") {
    // Invoke capped remediate
    try {
      const remediateResult = invokeRemediateCapped(ticket, {
        brief: details.brief,
        reason: details.reason,
      });

      const remediateStatus = remediateResult.success ? "success" : "failed";
      actionLog.push(`remediate invoked: ${remediateStatus}`);

      return {
        success: remediateResult.success,
        reason: remediateResult.reason,
        attempts: remediateResult.attempts || 1,
        actionLog,
        details: remediateResult.details || {},
      };
    } catch (err) {
      log(`recovery-reasoning: ${ticket} remediate failed: ${err.message}`);
      actionLog.push(`remediate error: ${err.message}`);
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

function buildEscalationPayload(item, classification) {
  const evidence = item.evidence || {};
  return {
    diagnosis: classification.details.reason,
    evidence: {
      logs_available: !!evidence.logsOutput,
      job_state_available: !!evidence.jobState,
      belief_state: evidence.beliefState,
    },
    timestamp: new Date().toISOString(),
  };
}

// ─── Default injectable implementations ─────────────────────────────────────

function defaultInvokeSeam(ticket, seamId, brief) {
  // Stub: would invoke unstuck-sweep seam registry (CTL-1219)
  return {
    success: false,
    reason: `seam ${seamId} not implemented (stub)`,
    details: {},
  };
}

function defaultInvokeRemediateCapped(ticket, brief) {
  // Stub: would invoke phase-remediate with hard cycle cap (CTL-653)
  return {
    success: false,
    reason: "remediate not implemented (stub)",
    attempts: 1,
    details: {},
  };
}

function defaultRecordIntent(ticket, intent) {
  // Stub: would write to intention ledger (label-guard.mjs pattern)
}

function defaultPostComment(ticket, comment, opts) {
  // Stub: would use linearis or direct GraphQL
}

function defaultEmitEvent(event) {
  // Stub: would append to event log
}

function defaultShouldSkipItem(ticket) {
  // Stub: would check cooldown + escalation history
  return false;
}
