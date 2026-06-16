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
  // Check failureReason shortcuts first (no log scan needed)
  if (failureReason === "orphan-sweep-stale") {
    return {
      fix_class: "orphan_stale",
      seam_id: "orphan-reconcile",
      reason: "Orphan PR reconciliation needed",
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
