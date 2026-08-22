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
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
// CTL-1568: read-only predicate — is the belief engine the needs-human owner?
// label-guard imports only node builtins + config.mjs, so this adds no cycle.
import { beliefOwnsNeedsHuman } from "./label-guard.mjs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { log as defaultLog, getEventLogPath } from "./config.mjs";
import { buildCatalystResource } from "./lib/catalyst-resource.mjs";
import { defaultProbePrBlock } from "./pr-block-probe.mjs";
// Static (not requireSync) on purpose. Bun rejects `require()` of a module whose
// ESM graph is async — but ONLY on a COLD cache: once anything has imported this
// module, the same requireSync succeeds. That made the empty-registry fallback
// below silently order-dependent — it worked under the tests (whose own import
// graph warms the module) and returned `registry build failed: require() async
// module ... is unsupported` in a production process that reached the fallback
// first. There is no import cycle to break here (unstuck-act-seams.mjs and its
// dep closure do not import this module), so a plain static import is both safe
// and deterministic.
import { buildUnstuckActSeams } from "./unstuck-act-seams.mjs";
import { captureEvidence } from "./diagnostician.mjs";
import {
  clearFixFailures,
  commitFixCommentHash,
  fixCommentHash,
  inFixBackoff,
  recordFixFailure,
  shouldPostFixComment,
} from "./recovery-fix-backoff.mjs";
import {
  correlationId,
  groupCandidates,
  normalizeSignature,
  RECOVERY_CORRELATION_MIN_GROUP,
  RECOVERY_CORRELATION_WINDOW_MS,
} from "./escalation-correlation.mjs";

// Wrap defaultLog to ensure it's a function (config.mjs may export an object)
const defaultLogFn =
  typeof defaultLog === "function"
    ? defaultLog
    : (msg) => {
        if (typeof defaultLog?.debug === "function") {
          defaultLog.debug(msg);
        } else if (typeof console?.log === "function") {
          console.log(msg);
        }
      };

// linear-comment-post.sh — the app-actor OAuth comment helper (CTL-1182 path).
const LINEAR_COMMENT_POST_BIN = fileURLToPath(
  new URL("../lib/linear-comment-post.sh", import.meta.url)
);
import { postLinearCommentAsSpawnResult } from "./linear-comment-write.mjs"; // CTL-1889 inc 2

// phase-agent-emit-complete — the canonical wake/synthetic-complete emitter, used
// by the CTL-1186 phase-pr re-dispatch to nudge the scheduler after re-arming.
const EMIT_COMPLETE_BIN = fileURLToPath(new URL("../phase-agent-emit-complete", import.meta.url));

// deriveFailureSignature — CAT-170 (Codex #3209 P1). PURE. The raw failure text a
// recovery attempt is signed with, read from wherever the caller actually put it.
//
// The original read `item.reason ?? item.signal?.stalledReason ??
// item.signal?.failureReason` — but the PRODUCTION caller is the scheduler, whose
// buildRecoveryItems (recovery-evidence.mjs) returns `{ticket, phase, bgJobId,
// evidence}` and populates NEITHER `item.reason` NOR `item.signal`: the raw signal
// fields are spread onto `item.evidence`, with the whole signal also nested at
// `evidence.signal`. So every normal per-item fix attempt persisted a NULL
// signature, its exhausted intent could never participate in correlation, and the
// correlation feature was structurally dead on the path that produces the most
// candidates. (The same gap CTL-1299 closed for the classifier, one field over.)
//
// Reads the item-level fields FIRST so a caller that does supply them (the tests'
// hand-built items, and any future caller with a richer shape) keeps its meaning,
// then falls back to the evidence object the scheduler really sends. `stalledReason`
// outranks `failureReason` at both altitudes, preserving the original precedence.
export function deriveFailureSignature(item = {}, evidence = null) {
  const ev = evidence ?? item.evidence ?? {};
  return (
    item.reason ??
    item.signal?.stalledReason ??
    item.signal?.failureReason ??
    ev.stalledReason ??
    ev.failureReason ??
    ev.signal?.stalledReason ??
    ev.signal?.failureReason ??
    null
  );
}

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
    inFixBackoffFn = inFixBackoff,
    recordFixFailureFn = recordFixFailure,
    clearFixFailuresFn = clearFixFailures,
    fixCommentHashFn = fixCommentHash,
    shouldPostFixCommentFn = shouldPostFixComment,
    commitFixCommentHashFn = commitFixCommentHash,
    nowMs = () => Date.now(),
    orchDir = process.env.CATALYST_ORCHESTRATOR_DIR ?? null,
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
    "invokeRemediateCapped"
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

  // CTL-1679 Phase 3: per-ticket skip breadcrumb. A reason-bearing failure that is
  // skipped (cooldown / escalated-latch) previously emitted ONLY the coarse
  // recovery.tick roster — the specific reason that keeps getting skipped was not
  // per-ticket queryable, so a coverage gap (e.g. an unrecognized retry-safe reason
  // latched to a human) was invisible in Loki. Emit recovery.skipped.<sanitized
  // reason> so `count by (reason)` over the JSONL log surfaces every gap.
  // recovery.* is deliberately UNPROTECTED — no namespace registration needed.
  const emitSkipBreadcrumb = (item) => {
    const reason = item.evidence?.failureReason ?? item.evidence?.signal?.failureReason ?? null;
    if (!reason) return; // only reason-bearing skips are queryable gaps
    emitEvent({
      type: `recovery.skipped.${sanitizeReasonForEvent(reason)}`,
      ticket: item.ticket,
      reason,
    });
  };

  for (const item of items) {
    // Check cooldown / already-escalated
    if (shouldSkipItem(item.ticket)) {
      log(`recovery-reasoning: ${item.ticket} skipped (cooldown/escalated)`);
      tickStats.ledgerSkipped.push(item.ticket);
      emitSkipBreadcrumb(item);
      continue;
    }

    // CTL-1243: never post the give-up comment on tickets that are already terminal.
    // Mirrors classifyStalledTicket's linearTerminal skip (unstuck-sweep.mjs:95-97).
    if (item.evidence?.linearTerminal) {
      log(`recovery-reasoning: ${item.ticket} skipped (linear-terminal)`);
      tickStats.terminalSkipped.push(item.ticket);
      continue;
    }

    // PROJ-1657 Codex P1 (round 8): a probe-less phase already parked terminal
    // via markEscalationCapTerminal (stalledReason "no-probe-for-phase" — a dead
    // recovery-pass worker with no retry path) has no typed failure signature,
    // so defaultClassifyTicket would fall through to its generic
    // decision:"defer"/fix_class:"board-health" case. readDeferredBoardHealthIntents
    // later picks that defer up as a holistic board-health candidate, and
    // holisticBoardHealthAct can dispatch a brand-new recovery-pass generation
    // for it — silently reversing the terminal hand-off to a human this branch
    // just declared. Same skip shape as the linearTerminal guard above.
    if (item.evidence?.signal?.stalledReason === "no-probe-for-phase") {
      log(`recovery-reasoning: ${item.ticket} skipped (terminal no-probe-for-phase)`);
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
    // CTL-1679 Phase 3: thread the ticket id + intent-budget reader so the
    // retry-safe rules can bound their retries against the shared ledger.
    let classification;
    try {
      classification = classifyTicket(evidence, {
        log,
        ticket: item.ticket,
        readIntentAttempts,
      });
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
    const rule =
      decision === "escalate" || decision === "defer" ? 3 : fix_class === "bounded-llm" ? 2 : 1;
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
        // CTL-1679 Phase 3: a retry-safe redispatch is a bounded RETRY, not an
        // open-ended fix — emit the recovery.would-retry twin so the shadow-rollout
        // LogQL can distinguish "would have retried" from other would-fixes.
        // recovery.* is deliberately UNPROTECTED — no namespace registration needed.
        if (fix_class === "retry_safe_redispatch" || fix_class === "fence_stale_redispatch") {
          emitEvent({
            type: "recovery.would-retry",
            ticket: item.ticket,
            fix_class,
            reason: details?.reason ?? null,
          });
          actionLog.push("emitted recovery.would-retry");
        }
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
        // Deliberately after shouldSkipItem: the attempts ledger bounds failures within one
        // lifetime. This history survives forgetIntent and guards identical post-reset re-entry.
        const backoff = inFixBackoffFn(orchDir, item.ticket, fix_class, nowMs());
        if (backoff.blocked) {
          actionLog.push(`fix backoff: ${fix_class} blocked (${backoff.count} identical failures)`);
          emitEvent({
            type: "recovery.fix-backoff",
            ticket: item.ticket,
            fix_class,
            count: backoff.count,
            until: backoff.until,
            reason: backoff.lastReason,
          });
          tickStats.actions.fixBackoff = (tickStats.actions.fixBackoff ?? 0) + 1;
          results.push({ ticket: item.ticket, decision: "deferred", fix_class, actionLog, mode });
          continue;
        }
        // CTL-1176: per-tick fix cap. Once maxFixesPerTick FIX-actions have been
        // taken this invocation, defer the rest — no action, no cooldown burn —
        // so the next scheduler tick processes them. Bounds a one-sweep storm.
        if (fixesThisTick >= maxFixesPerTick) {
          actionLog.push(`deferred: per-tick fix cap (${maxFixesPerTick}) reached`);
          tickStats.actions.deferred += 1;
          log(
            `recovery-reasoning: ${item.ticket} deferred — per-tick fix cap ${maxFixesPerTick} reached`
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

        if (fixOutcome.success) {
          clearFixFailuresFn(orchDir, item.ticket, fix_class);
        } else {
          recordFixFailureFn(orchDir, item.ticket, fix_class, fixOutcome.reason, nowMs(), { log });
        }

        // Record intent
        try {
          recordIntent(item.ticket, {
            type: "recovery-pass",
            decision: "fix",
            fix_class,
            outcome: fixOutcome.success,
            details: fixOutcome.details,
            // CAT-170 (Codex #3209 P1): read the signature from the COLLECTED
            // evidence — the production item shape carries no `.reason`/`.signal`.
            signature: deriveFailureSignature(item, evidence),
          });
          actionLog.push("recorded recovery-pass intent");
        } catch (err) {
          log(`recovery-reasoning: ${item.ticket} intent record failed: ${err.message}`);
        }

        // Post audit comment
        const fixComment = formatFixComment(item.ticket, fixOutcome, classification);
        const commentHash = fixCommentHashFn(fixComment);
        if (shouldPostFixCommentFn(orchDir, item.ticket, fix_class, commentHash, nowMs())) {
          // defaultPostComment fails CLOSED WITHOUT THROWING — a non-zero
          // linear-comment-post.sh exit returns {ok:false}. Committing the dedup
          // hash on that path would suppress this audit comment forever on a
          // Linear outage, so only an explicitly non-failing result counts as
          // delivery. An injected seam that returns nothing is treated as
          // delivered (for those, a throw is the failure signal).
          let delivered = false;
          try {
            const posted = postComment(item.ticket, fixComment, { mode: "enforce" });
            delivered = !(posted && posted.ok === false);
            if (!delivered) {
              log(
                `recovery-reasoning: ${item.ticket} comment post reported failure; ` +
                  `dedup hash not committed (comment stays eligible for retry)`
              );
            }
          } catch (err) {
            log(`recovery-reasoning: ${item.ticket} comment post failed: ${err.message}`);
          }
          if (delivered) {
            // Isolated from the post above: a failure HERE means the comment WAS
            // delivered but the latch did not land, which must be logged as a
            // latch-write failure rather than misattributed to the post.
            try {
              commitFixCommentHashFn(orchDir, item.ticket, fix_class, commentHash, nowMs());
            } catch (err) {
              log(
                `recovery-reasoning: ${item.ticket} fix-comment dedup latch write failed: ` +
                  `${err.message}`
              );
            }
            actionLog.push("posted fix audit comment");
          }
        } else {
          actionLog.push("suppressed duplicate fix audit comment");
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

// CTL-1496: the failureReason value emitted by phase-teardown's pr_not_merged gate.
export const PR_NOT_MERGED_REASON = "pr_not_merged";

// CTL-1680: phase-monitor-deploy's empty-mergeCommitSha false-done guard emits bespoke prose
// reasons (not teardown's literal "pr_not_merged"). They all share this recognizable prefix.
// Recognize them so the same live PR-state probe runs, instead of falling through to defer/escalate.
export const MONITOR_DEPLOY_EMPTY_SHA_PREFIX =
  "phase-monitor-merge.json has empty .pr.mergeCommitSha";
// CTL-1680 (Codex #3079 round-3 P1): pull the PR number out of a failure reason that
// names one. phase-monitor-deploy emits `… gh REST fallback also returned empty for
// pr#<N>`; the tolerant pattern also accepts `PR #<N>` / `pr #<N>` so a future reason
// phrased that way is picked up too. Returns a positive integer or undefined — never
// throws, and never guesses from a bare number (an unprefixed digit run in prose is
// far more likely a SHA fragment, count, or timestamp than a PR id).
export function parsePrNumberFromReason(reason) {
  if (typeof reason !== "string") return undefined;
  const m = /\bpr\s*#(\d+)\b/i.exec(reason);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// CTL-1680 (Codex #3079 round-4 P1): the reason string is only ONE of the places the
// PR number lives, and two production reasons carry none —
// phase-monitor-deploy's "…no PR number available for gh REST fallback" (phase-pr.json
// had no `.pr.number`) and "…gh repo view returned empty" (the number WAS known but was
// never written into the prose). For those, the number is still on disk in a SIBLING
// phase artifact next to the failing signal. Read it from there, most-authoritative
// first:
//   phase-pr.json        .pr.number      — the PR the pipeline actually opened
//   phase-monitor-merge  .pr.number      — same PR, recorded again at merge watch
//   phase-implement.json .draftPr.number — the early draft PR (CTL-783), the only
//                                          record when the pipeline never reached `pr`
// Without this the probe falls through to a `--state all --limit 1` title search, which
// on a ticket with several historical PRs can resolve a DIFFERENT attempt and recover
// ITS merge SHA — resuming deployment on the wrong commit.
//
// Pure over the filesystem and total: any missing file, unreadable path, malformed JSON,
// or non-positive value is skipped, and an exhausted search returns undefined so the
// caller keeps its existing search fallback. `signalPath` is the failing phase signal's
// own path (WorkerSignal.signalPath); its directory is the worker dir. A flat legacy
// signal (workers/<T>.json) has no sibling phase artifacts — the reads simply miss.
const PR_NUMBER_SIBLING_SOURCES = [
  ["phase-pr.json", (d) => d?.pr?.number],
  ["phase-monitor-merge.json", (d) => d?.pr?.number],
  ["phase-implement.json", (d) => d?.draftPr?.number],
];

export function prNumberFromWorkerDir(signalPath, { readFile = readFileSync } = {}) {
  if (typeof signalPath !== "string" || signalPath === "") return undefined;
  const dir = dirname(signalPath);
  for (const [name, pick] of PR_NUMBER_SIBLING_SOURCES) {
    let n;
    try {
      n = pick(JSON.parse(readFile(join(dir, name), "utf8")));
    } catch {
      continue; // absent / unreadable / malformed → try the next source
    }
    const v = Number(n);
    if (Number.isInteger(v) && v > 0) return v;
  }
  return undefined;
}

// CTL-1680 (Codex #3079 round-4 P1): resolve the PR number for a recovery item from
// every place it can legitimately live, most-precise first — the failure reason's own
// `pr#<N>`, then the sibling phase artifacts on disk. Returns undefined when nothing
// names a PR, which leaves the probe's title-search fallback in place.
export function resolvePrNumberForRecovery(evidence, { readFile = readFileSync } = {}) {
  const fromReason = parsePrNumberFromReason(
    evidence?.failureReason ?? evidence?.signal?.failureReason
  );
  if (fromReason !== undefined) return fromReason;
  return prNumberFromWorkerDir(evidence?.signalPath ?? evidence?.signal?.signalPath, {
    readFile,
  });
}

export function isPrMergeUnconfirmedReason(reason) {
  return (
    reason === PR_NOT_MERGED_REASON ||
    (typeof reason === "string" && reason.startsWith(MONITOR_DEPLOY_EMPTY_SHA_PREFIX))
  );
}

// CTL-1496: classify a pr_not_merged recovery item by probing live PR state.
// All GitHub calls are behind the injectable probePrBlock seam so this function
// stays pure and unit-testable with a fake probe.
export function classifyPrNotMerged(evidence, { probePrBlock = defaultProbePrBlock, log } = {}) {
  const ticket = evidence.ticket ?? evidence.signal?.ticket;
  // CTL-1496: thread the ticket's head branch to the probe when the evidence
  // carries it, so the probe resolves the ticket's PR by `--head <branch>`
  // rather than the daemon's current branch. Falls back to ticket-in-title
  // search inside the probe when branch is absent.
  const branch =
    evidence.branch ?? evidence.signal?.branch ?? evidence.signal?.branchName ?? undefined;
  // CTL-1496 P1: thread the ticket's repository into the probe so it resolves
  // the ticket's PR, not a same-ticket PR in the daemon's own checkout. `repo`
  // (owner/name) is used directly; `worktreePath` lets the probe derive the repo
  // from the ticket's worktree when `repo` isn't pre-resolved. Both come off the
  // worker signal the scheduler already carries — without them an external-repo
  // ticket falls back to the daemon cwd and is misclassified as having no PR.
  const repo = evidence.repo ?? evidence.signal?.repo ?? undefined;
  const worktreePath = evidence.worktreePath ?? evidence.signal?.worktreePath ?? undefined;
  // CTL-1680 (Codex #3079 round-3/4 P1): phase-monitor-deploy's empty-SHA guard names
  // the PR in its own reason string (`… returned empty for pr#<N>`). Thread that
  // number to the probe so it resolves THAT PR exactly. Without it, a ticket with no
  // head branch and several non-open historical PRs fell back to a title search that
  // collapses every match to one — and the MERGED branch below would then recover a
  // DIFFERENT PR's merge SHA and resume deployment on the wrong commit. Round 4: two
  // production reasons carry no `pr#<N>` at all, so fall back to the sibling phase
  // artifacts on disk, where the exact number is still recorded.
  const prNumber = resolvePrNumberForRecovery(evidence);
  let probe;
  try {
    probe = probePrBlock(ticket, { branch, repo, worktreePath, prNumber });
  } catch (e) {
    log?.(`pr-block probe failed: ${e.message}`);
    return {
      decision: "defer",
      fix_class: "board-health",
      details: {
        reason: `pr_not_merged: PR-state probe failed (${e.message}); retry next tick`,
      },
    };
  }

  if (!probe || !probe.prNumber) {
    return {
      decision: "escalate",
      fix_class: "human",
      details: { reason: `pr_not_merged: no PR found for ${ticket}` },
    };
  }

  // CTL-1680: the empty-mergeCommitSha family (isPrMergeUnconfirmedReason) can fire
  // on a PR that ACTUALLY merged — monitor-merge confirmed REST `.merged==true` but
  // recorded an empty SHA, so monitor-deploy's guard tripped. With `--state all` the
  // probe now resolves that PR as MERGED. The correct recovery is to re-record the
  // merge SHA and resume monitor-deploy — NOT to escalate a successfully-merged PR to
  // a human (Codex #3079 P1: the prior `--state open` probe missed it → false
  // "no open PR" escalate). A merged PR has no failing/pending checks or open threads,
  // so without this branch it would fall through to the generic terminal escalate.
  if (probe.state === "MERGED") {
    const sha = probe.mergeCommitSha;
    return {
      decision: "fix",
      fix_class: "bounded-llm",
      details: {
        reason:
          `PR #${probe.prNumber} is already MERGED` +
          (sha ? ` (${sha.slice(0, 10)})` : "") +
          ` but the merge SHA was not recorded; recover it and resume monitor-deploy`,
        brief: generateRemediateBrief("pr-merge-sha-missing", probe),
      },
    };
  }

  // Human decision required → escalate with the SPECIFIC ask. The escalation
  // condition is the aggregate CHANGES_REQUESTED verdict ONLY (CTL-1496 P2): a
  // merely-open human discussion thread or question — with reviewDecision not
  // CHANGES_REQUESTED — is not a change request, so it must NOT short-circuit to
  // a terminal human-escalation latch while the PR has a fixable failing check
  // or bot finding. Such non-requesting threads fall through to the actionable
  // path below (and, if nothing is fixable, the generic escalate at the end).
  if (probe.hasChangesRequested) {
    const t = probe.unresolvedHumanThreads[0];
    return {
      decision: "escalate",
      fix_class: "human",
      details: {
        reason:
          `PR #${probe.prNumber} blocked by human review` +
          (t
            ? ` — "${(t.body || "").slice(0, 120)}" (${t.path}:${t.line})`
            : " (CHANGES_REQUESTED)"),
      },
    };
  }

  // Remediable when there is a concrete LLM-actionable cause (failing checks or
  // unresolved bot threads), or the PR is already CLEAN and just needs merging.
  // A BLOCKED PR with NO actionable cause (awaiting a required approving review
  // or a still-pending required check) is not LLM-fixable — falling through to
  // escalate avoids burning the recovery-attempt budget re-entering as 'fix'.
  const remediable =
    probe.failingChecks.length > 0 ||
    probe.unresolvedBotThreads.length > 0 ||
    probe.mergeStateStatus === "CLEAN";
  if (remediable) {
    return {
      decision: "fix",
      fix_class: "bounded-llm",
      details: {
        reason: _prNotMergedReasonText(probe),
        brief: generateRemediateBrief("pr-not-merged", probe),
      },
    };
  }

  // CTL-1496 P2: a PR blocked only by queued/in-progress required checks has no
  // fixable cause YET — but it is not stuck. Escalating here would latch a
  // "no remediable cause" record for days and never revisit a CI run that
  // later turns green. Defer instead so the next tick re-probes once checks
  // settle.
  if (probe.pendingChecks?.length > 0) {
    return {
      decision: "defer",
      fix_class: "board-health",
      details: {
        reason:
          `PR #${probe.prNumber} awaiting checks: ` +
          `${probe.pendingChecks.map((c) => c.name).join(", ")}; retry next tick`,
      },
    };
  }

  // Genuinely stuck with no actionable cause.
  return {
    decision: "escalate",
    fix_class: "human",
    details: {
      reason: `PR #${probe.prNumber} not merged; mergeState=${probe.mergeStateStatus}, no remediable cause`,
    },
  };
}

function _prNotMergedReasonText(probe) {
  const parts = [];
  if (probe.failingChecks.length > 0) {
    parts.push(`failing checks: ${probe.failingChecks.map((c) => c.name).join(", ")}`);
  }
  if (probe.unresolvedBotThreads.length > 0) {
    parts.push(`${probe.unresolvedBotThreads.length} unresolved bot review thread(s)`);
  }
  if (parts.length === 0) {
    parts.push(`mergeState=${probe.mergeStateStatus}`);
  }
  return `PR #${probe.prNumber} not merged — ${parts.join("; ")}`;
}

// CTL-1679 Phase 3: the shared bounded-retry budget decision for a retry-safe
// failure. Consults the recovery-intent ledger (attempts auto-increment; the same
// RECOVERY_MAX_ATTEMPTS budget the fix/escalate cooldown ledger already uses) so
// NO retry-safe reason — the deterministic cluster_fence_stale OR a generic
// unrecognized-but-safe failure — can loop unboundedly:
//   attempts < MAX → { retry: true }  (redispatch via the fence-stale seam)
//   attempts ≥ MAX → { retry: false } (escalate with a reason-named coverage-gap
//                     explanation carrying the attempts history)
// Pure over the injected reader; readIntentAttempts defaults to the on-disk ledger
// reader (orchDir from env) but is injectable for hermetic tests.
export function retrySafeBudgetDecision(
  ticket,
  { readIntentAttempts = defaultReadIntentAttempts } = {}
) {
  let attempts = 0;
  try {
    attempts = readIntentAttempts(ticket) ?? 0;
  } catch {
    attempts = 0; // fail-open: an unreadable ledger means "never retried" → allow
  }
  return { retry: attempts < RECOVERY_MAX_ATTEMPTS, attempts };
}

// CTL-1679 Phase 3: build the reason-named coverage-gap escalation for a
// retry-safe failure whose retry budget is exhausted. Reuses the buildEscalationPayload
// tagged-union shape (escalation_type + problem/call_to_action) so the existing
// escalate path writes it verbatim, and names the reason so the operator inbox
// renders a real "unrecognized retry-safe failure <reason>" card instead of a bare label.
export function buildRetrySafeExhaustionExplanation(ticket, reason, attempts) {
  return {
    escalation_type: "coverage_gap",
    problem:
      `${ticket}: the retry-safe failure "${reason}" exhausted its ${RECOVERY_MAX_ATTEMPTS}-attempt ` +
      `bounded-retry budget (${attempts} attempts) without resolving — it is an unrecognized ` +
      `coverage gap (no deterministic seam or bounded-LLM rule matches this reason).`,
    call_to_action:
      `Investigate why re-dispatching ${ticket} did not clear "${reason}"; if this reason is ` +
      `mechanically recoverable, add a classifier rule for it, otherwise resolve the ticket by hand.`,
    blocked_capability: `automatic recovery of the retry-safe failure "${reason}" — it survived the bounded retry budget`,
    instructions: [
      `Read ${ticket}'s worker evidence (claude logs + the failed phase signal)`,
      `Decide whether "${reason}" needs a new classifier rule or a hand fix`,
    ],
    attempts: [{ reason, count: attempts, budget: RECOVERY_MAX_ATTEMPTS }],
    why_not_auto:
      `the retry-safe redispatch was attempted ${attempts} time(s) and did not resolve "${reason}", ` +
      `so further automatic retries would loop without progress`,
    timestamp: new Date().toISOString(),
  };
}

// CTL-1679 Phase 3: sanitize an arbitrary failure reason into a safe event-name
// suffix for the per-ticket recovery.skipped.<reason> breadcrumb (dots break the
// phase-event name parser; keep it to a bounded [a-z0-9_-] slug).
export function sanitizeReasonForEvent(reason) {
  if (typeof reason !== "string" || reason === "") return "unknown";
  return (
    reason
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "unknown"
  );
}

export function defaultClassifyTicket(evidence, opts = {}) {
  const {
    log = defaultLogFn,
    probePrBlock,
    // CTL-1679 Phase 3: the intent-budget reader + the ticket id, threaded from
    // reasoningRecoveryPass so the retry-safe rules can bound their retries.
    // Default to the on-disk ledger reader (orchDir from env); a bare classifier
    // call (no ticket) reads attempts=0 → the retry path stays available.
    readIntentAttempts = defaultReadIntentAttempts,
    ticket: optTicket,
  } = opts;

  // Extract evidence fields
  const { logsOutput, jobState, signal, beliefState, failureReason } = evidence;
  const ticket = optTicket ?? evidence.ticket ?? signal?.ticket ?? null;

  // CTL-1496 / CTL-1680: route to the live PR-state probe for any "merge not confirmed" failure.
  // Covers teardown's literal "pr_not_merged" (CTL-1496) AND phase-monitor-deploy's bespoke
  // empty-mergeCommitSha prose reasons (CTL-1680), which share a recognizable prefix.
  // All other failure reasons are intentionally untouched — the probe is bounded to this family.
  const effectiveFailureReason = failureReason ?? signal?.failureReason;
  if (isPrMergeUnconfirmedReason(effectiveFailureReason)) {
    return classifyPrNotMerged(evidence, {
      probePrBlock: probePrBlock ?? defaultProbePrBlock,
      log,
    });
  }

  // Rule 1: Check for deterministic errors in logs.
  // CTL-1679: pass the EFFECTIVE failure reason (top-level or signal-borne) plus
  // the signal itself, so the cluster_fence_stale shortcut can read signal.phase
  // to derive the failed phase for the fence-stale-redispatch seam.
  const deterministic = checkDeterministicErrors(logsOutput, effectiveFailureReason, signal);
  if (deterministic) {
    // CTL-1679 Phase 3: the cluster_fence_stale deterministic redispatch is
    // retry-safe but must NOT loop forever on an infinitely-stale fence — gate it
    // on the shared retry budget. Within budget → fix; exhausted → escalate with a
    // reason-named coverage-gap explanation. Other deterministic seams (orphan,
    // workflow-token) are unbounded as before.
    if (deterministic.fix_class === "fence_stale_redispatch") {
      const budget = retrySafeBudgetDecision(ticket, { readIntentAttempts });
      if (!budget.retry) {
        return {
          decision: "escalate",
          fix_class: "human",
          details: {
            reason:
              `cluster_fence_stale: retry budget exhausted (${budget.attempts}/${RECOVERY_MAX_ATTEMPTS}) ` +
              `— a repeatedly-stale fence needs a human`,
            explanation: buildRetrySafeExhaustionExplanation(
              ticket,
              "cluster_fence_stale",
              budget.attempts
            ),
          },
        };
      }
    }
    // CAT-60 — deterministic checks that already carry an explicit escalate
    // verdict (e.g. push_denied_no_permission) short-circuit straight to
    // escalate rather than falling through to the generic "fix" return below.
    if (deterministic.escalate) {
      return {
        decision: "escalate",
        fix_class: deterministic.fix_class,
        details: {
          reason: deterministic.reason,
          explanation: deterministic.explanation,
        },
      };
    }
    return {
      decision: "fix",
      fix_class: deterministic.fix_class,
      details: {
        reason: deterministic.reason,
        seam_id: deterministic.seam_id,
        ...(deterministic.phase !== undefined ? { phase: deterministic.phase } : {}),
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

  // CTL-1679 Phase 3: generalized bounded-retry for UNRECOGNIZED-but-retry-safe
  // failures. Reached only when no Rule-1/Rule-2 handler matched. When the signal
  // carries retrySafe:true (the fence guard stamps it; any future retry-safe reason
  // can too), consult the shared budget: within budget → redispatch via the generic
  // fence-stale-redispatch seam (it is the reason-neutral "reset to pending +
  // re-dispatch" actuator); exhausted → escalate naming the reason as an
  // unrecognized coverage gap. An unrecognized UNSAFE failure (no retrySafe) skips
  // this rule entirely and falls through to Rule 3's immediate escalate (unchanged).
  if (evidence.retrySafe === true) {
    const reason = effectiveFailureReason ?? "unrecognized-retry-safe";
    const phase = signal?.phase;
    const budget = retrySafeBudgetDecision(ticket, { readIntentAttempts });
    if (budget.retry) {
      return {
        decision: "fix",
        fix_class: "retry_safe_redispatch",
        details: {
          reason: `retry-safe failure "${reason}" (attempt ${budget.attempts + 1}/${RECOVERY_MAX_ATTEMPTS}); re-dispatching`,
          seam_id: "fence-stale-redispatch",
          ...(phase !== undefined ? { phase } : {}),
        },
      };
    }
    return {
      decision: "escalate",
      fix_class: "human",
      details: {
        reason:
          `unrecognized retry-safe failure "${reason}": retry budget exhausted ` +
          `(${budget.attempts}/${RECOVERY_MAX_ATTEMPTS})`,
        explanation: buildRetrySafeExhaustionExplanation(ticket, reason, budget.attempts),
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
export function checkDeterministicErrors(logsOutput, failureReason, signal = null) {
  // CTL-1679: cluster_fence_stale is provably retry-safe — cluster-fence-guard.sh
  // emits it BEFORE any guarded side-effect and exit-10s, and a fresh dispatch
  // bumps the cluster generation so the next fence-check passes. So it is a
  // deterministic FIX (re-dispatch the failed phase at generation N+1), NOT a
  // human escalate. Routed to the fence-stale-redispatch seam; the failed phase
  // rides in details.phase (read from the signal) so the seam knows which
  // phase-<P>.json to re-arm. Checked first — it needs no log scan.
  if (failureReason === "cluster_fence_stale") {
    return {
      fix_class: "fence_stale_redispatch",
      seam_id: "fence-stale-redispatch",
      reason:
        "Cluster fence stale (side-effect not taken); re-dispatch the failed phase at a fresh generation",
      phase: signal?.phase,
    };
  }
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
  if (failureReason === "push_denied_no_permission") {
    return {
      fix_class: "push_denied_no_permission",
      seam_id: null,
      escalate: true,
      reason:
        "Cannot publish to the repository: the automation's GitHub identity lacks push " +
        "permission on the configured push remote. Reviewed commits exist only on this " +
        "host until the push target or the identity's permission changes.",
      explanation: {
        problem:
          "The configured push remote rejected the automation identity because it lacks repository push permission.",
        call_to_action:
          "Grant the automation identity push permission on that repository, or set catalyst.pr.pushRemote to a writable remote.",
      },
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
      pattern:
        "conflict.*merge.*tree|merge conflict in|conflict \\(content\\)|could not apply|rebase.*conflict",
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
    const logMatch =
      new RegExp(p.pattern, "i").test(logs) || new RegExp(p.pattern, "i").test(details);
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

// Generate a structured brief for phase-remediate / recovery-pass that includes
// explicit instruction on escalation bar.  For the "pr-not-merged" category an
// optional `probe` object embeds the concrete blockers so the worker has them
// without re-probing at act-time.
export function generateRemediateBrief(category, probe = null) {
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
    "typescript-error":
      "Review and fix type errors reported by the compiler, then retry the phase.",
    // CTL-1496: pr-not-merged remediation brief (embeds concrete blockers from the probe).
    "pr-not-merged": [
      probe
        ? `PR #${probe.prNumber} is OPEN (mergeState=${probe.mergeStateStatus}).`
        : "A PR for this ticket is open but not merged.",
      probe?.failingChecks?.length
        ? `Failing checks: ${probe.failingChecks.map((c) => c.name).join(", ")}. ` +
          "For each, run `gh run view --log-failed`, fix the root cause, commit and push to re-run it."
        : "",
      probe?.unresolvedBotThreads?.length
        ? `Unresolved automated-review threads: ` +
          `${probe.unresolvedBotThreads.map((t) => `${t.path}:${t.line}`).join(", ")}. ` +
          "Address each actionable finding in code, resolve the thread via resolveReviewThread, " +
          "then post `@codex review` via gh-pr-comment.sh to re-trigger the reviewer."
        : "",
      "When the PR is CLEAN, run `gh pr view <n> --json mergeable,mergeStateStatus` to confirm, " +
        "then capture the head ref + head repo (`gh api repos/<repo>/pulls/<n> --jq '.head.ref'` and `.head.repo.full_name`) and " +
        "merge with `gh pr merge --squash` (worktree-safe, CTL-56). " +
        "After the merge is REST-confirmed, delete the remote head ref checkout-free: " +
        "`gh api --method DELETE repos/<repo>/git/refs/heads/<head_ref>` — but ONLY when the head branch lives in <repo> " +
        "(`.head.repo.full_name == <repo>`); a fork PR's head ref lives in the fork, so deleting it from the base repo could " +
        "hit an unrelated same-named branch (CTL-56). URL-encode <head_ref> (preserve '/') first — a metacharacter like '#' " +
        "in a branch name would otherwise truncate the endpoint and delete the wrong ref. Idempotent + best-effort. " +
        "After addressing any review finding, post `@codex review` via gh-pr-comment.sh to re-trigger the reviewer.",
      "Never --admin or force-merge past a failing or pending check. " +
        "Escalate ONLY a finding that genuinely requires a human decision, " +
        "with the PR number and thread linked.",
    ]
      .filter(Boolean)
      .join(" "),
    // CTL-1680: the PR merged but monitor-merge recorded an empty merge SHA, so
    // monitor-deploy's empty-SHA guard false-failed. No code fix is needed — the work
    // shipped; recover the SHA and let the pipeline proceed.
    "pr-merge-sha-missing": [
      probe
        ? `PR #${probe.prNumber} is already MERGED` +
          (probe.mergeCommitSha ? ` (merge commit ${probe.mergeCommitSha}).` : ".")
        : "The PR for this ticket is already merged.",
      "Do NOT re-merge or reopen it. Read the true merge commit SHA from " +
        "`gh api repos/{owner}/{repo}/pulls/<n> --jq .merge_commit_sha`, " +
        "write it into `.pr.mergeCommitSha` (and `.pr.mergedAt`, `.pr.ciStatus=merged`) " +
        "in the ticket's phase-monitor-merge.json signal file, then re-dispatch " +
        "monitor-deploy so the pipeline resumes from the recorded SHA.",
      "Escalate ONLY if the PR is NOT actually merged on the base branch " +
        "(verify with `gh pr view <n> --json state,mergedAt` — `merged` is not a " +
        'supported `gh pr view --json` field; merged means state == "MERGED").',
    ]
      .filter(Boolean)
      .join(" "),
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
      const seamResult = invokeSeam(
        ticket,
        details.seam_id,
        {
          reason: details.reason,
          fix_class,
          // CTL-1679: the fence-stale-redispatch seam needs the failed phase to
          // know which phase-<P>.json to re-arm. The classifier stamped it on
          // details.phase; thread it through the brief so defaultInvokeSeam reads
          // it (it prefers deps.phase for test injection, else brief.phase).
          ...(details.phase !== undefined ? { phase: details.phase } : {}),
        },
        {
          candidate: {
            ticket,
            phase: item.phase ?? null,
            signal: evidence?.signal ?? item.evidence?.signal ?? null,
          },
        }
      );

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
    : (p.remediation_then_retry ??
      "Resolve the stuck state by hand; the next scheduler tick re-evaluates the ticket and re-dispatches if appropriate.");
  const outcome =
    p.remediation_then_retry ??
    "Once the stuck state is resolved by hand, the next scheduler tick re-evaluates the ticket and re-dispatches if appropriate.";
  const why_you =
    p.why_you ??
    `No autonomous fix path matched this failure: ${reason}. A human must read the raw evidence and decide: re-dispatch the phase, fix the branch by hand, or close the ticket.`;
  const why_not_auto =
    p.why_not_auto ??
    p.blocked_capability ??
    "neither a deterministic act-seam nor a bounded-LLM fix matched this failure signature, so the pass has no safe action to take";
  return {
    escalation_type: typeof p.escalation_type === "string" ? p.escalation_type : "manual",
    call_to_action:
      p.call_to_action ??
      `Look at this ticket's worker log and decide whether to re-dispatch the phase, fix the branch by hand, or close it`,
    problem:
      p.problem ??
      `This ticket is stuck and the recovery pass could not classify it for an autonomous fix: ${reason}`,
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
// CAT-170 (Codex #3209 round-2 P1): reports SUCCESS as a boolean. It still never
// throws, but a silent catch-and-log gave the caller no way to tell a persisted
// signal from a lost one — and for a correlated member the `correlation` block
// written here is the ONLY durable carrier of its member role. The escalate path
// below needs that answer to decide whether the act may latch.
function writeEscalationSignal(orchDir, ticket, escalationPayload, opts = {}) {
  const log = opts.log ?? defaultLogFn;
  if (!orchDir || !ticket) return false;
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
      // parseSignal keys off raw.ticket — WITHOUT a ticket, readWorkerSignals() would
      // report ticket:null and scheduler-recovery / board-health consumers would lose
      // the escalated ticket after the first pass.
      // CTL-1552: status normalized to the terminal "stalled" + stalledReason (was the
      // bespoke non-terminal "needs-human"). byActivePhase now ranks this vs. the failed
      // phase signal by updatedAt recency (both terminal): this escalation is written
      // LAST, so it stays the freshest and still wins. isTicketInFlight now frees the
      // slot (intended). needs-human SEMANTICS ride on needsHumanSince + explanation +
      // the Linear label/marker, not the raw status.
      ticket,
      status: "stalled",
      stalledReason: "needs_human",
      needsHumanSince:
        typeof prior.needsHumanSince === "string" && prior.needsHumanSince !== ""
          ? prior.needsHumanSince
          : nowIso,
      updatedAt: nowIso,
      phase: RECOVERY_PASS_PHASE,
      explanation,
      // CAT-170 (Codex #3209 P1): persist the correlation identity as a FIRST-CLASS
      // signal field. It used to ride only inside `escalation.observed`, and
      // synthesizeEscalationExplanation (called just above) projects the payload down
      // to its six render fields — dropping `observed` entirely. The board therefore
      // saw an ordinary `needs-human` authorization for every correlated member and
      // its notification projector, which keys on ticket id, emitted a separate
      // "<member> needs your decision" push for each one — precisely the per-ticket
      // operator spam this correlation work exists to collapse. Written top-level so
      // a consumer can group by `correlation.id` or suppress `correlation.role ===
      // "member"` without reaching into the explanation. Omitted entirely for an
      // uncorrelated escalation, so an existing single-ticket signal is unchanged.
      ...(escalationPayload?.correlation ? { correlation: escalationPayload.correlation } : {}),
    };
    // CAT-170 (phase-review): this writer is a read-modify-write over `prior`, so an
    // omitted `correlation` block does NOT clear the one a previous escalation left
    // behind — it inherits it. A ticket that once escalated as a correlated MEMBER
    // would keep `correlation.role === "member"` forever, and a later INDEPENDENT
    // escalation on that ticket (fresh exhaustion after the 7-day latch TTL) would be
    // suppressed by every notification path that keys on the role — board projector
    // and desktop bridge alike — so the operator gets no alert at all. Silent
    // suppression of a genuine escalation is the exact failure this feature exists to
    // prevent, inverted. The block is per-incident state, not accumulating history:
    // an uncorrelated payload must ERASE it, not merely decline to replace it.
    if (!escalationPayload?.correlation) delete signal.correlation;
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(signal, null, 2));
    renameSync(tmp, p); // atomic
    return true;
  } catch (err) {
    try {
      log(`recovery-reasoning: ${ticket} escalation signal write failed: ${err.message}`);
    } catch {
      /* logging must never break the escalate path */
    }
    return false;
  }
}

// defaultWriteEscalationSignal — the injectable default the scheduler binds to the
// tick's orchDir. Resolves orchDir from opts/env (a no-op when unset).
export function defaultWriteEscalationSignal(ticket, escalationPayload, opts = {}) {
  const orchDir = opts.orchDir ?? resolveOrchDir();
  // CAT-170 (Codex #3209 round-2 P1): propagate the boolean. With no orchDir there
  // is nowhere to persist the member role, which is a failed write, not a success.
  if (!orchDir) return false;
  return writeEscalationSignal(orchDir, ticket, escalationPayload, opts);
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
  const authored = classification?.details?.escalation || item.authoredEscalation || null;
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
    // CTL-1607: per-host slot census → chartable Loki metadata. Fleet-wide free
    // capacity is sum(recovery.slot.free) across hosts (host identity via host_name
    // metadata). Sum FREE directly — never slot.capacity - slot.in_use: on a
    // draining/stale-liveness node slot.free is gate-collapsed to 0 while
    // slot.in_use still reports actual occupancy, so capacity − in_use overstates
    // admittable free (see the emit-site note in board-health.mjs).
    num("recovery.slot.capacity", details.slotCapacity);
    num("recovery.slot.in_use", details.slotInUse);
    num("recovery.slot.free", details.slotFree);
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
    // CTL-1475: same contract for the unowned-in-flight cohort — the tickets whose
    // Linear state claims a worker that does not exist. Promoted (not left in
    // body.payload) so the sweep is chartable: this count going DOWN is the only
    // queryable proof the delegate is actually landing these, rather than merely
    // re-flagging them every scan.
    num("cohort_unowned_in_flight", details.invariants?.unownedInFlight?.failed);
    // CTL-1644 (Codex P2 round 4): promote the stranded-mid-pipeline population
    // counters. They were added to details as "chartable" scalars, but the
    // forwarder ships only attributes and drops body.payload off-host, so an
    // un-promoted detail is invisible to Loki/Grafana. cohort_stranded_mid_pipeline
    // is the whole flagged population; cohort_stranded_held is the non-dispatchable
    // (held) subset the anchor filter keeps out of tier2Moves/boardContext — in
    // Phase 2 these are equal (every stranded ticket is unknown-salvage), and the
    // gap between them (total − held) is the dispatchable set as Phase 3 lands.
    num("cohort_stranded_mid_pipeline", details.strandedCount);
    num("cohort_stranded_held", details.strandedHeldCount);
    // CAT-40 (Codex P1): promote the GitHub core-REST quota scalars. They are the
    // whole point of the sampler — a board-wide cause with per-ticket symptoms —
    // and the forwarder drops body.payload off-host, so leaving them in details
    // makes the default shadow rollout unverifiable: an operator could see the
    // scan fire but never chart the quota it observed. Both are bounded (a count
    // and a 0-100 percentage); the reset timestamp and sampling host stay in
    // body.payload. `num` drops nulls, so an absent snapshot promotes nothing
    // rather than charting a fake zero.
    num("recovery.github.core_remaining", details.githubCoreRemaining);
    num("recovery.github.core_remaining_pct", details.githubCoreRemainingPct);
    // CTL-2027 Phase 2: promote the Linear write-budget headroom scalars — same
    // rationale as the GitHub quota pair above (the forwarder drops
    // body.payload off-host, so an un-promoted detail is unqueryable). `state`
    // is a bounded enum (ok|warn|capped|unknown, ≤64 chars) so it takes the
    // `str` path, not `num`.
    num("recovery.linear_write.remaining", details.linearWriteRemaining);
    num("recovery.linear_write.remaining_pct", details.linearWriteRemainingPct);
    str("recovery.linear_write.state", details.linearWriteState);
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
    site = null,
    deferrals = null,
    // CAT-170 (Codex #3209 P2): the correlation identifiers were passed by both the
    // shadow (`recovery.escalation.would-correlate`) and enforce
    // (`recovery.escalation.correlated`) emitters and silently DROPPED here, so a
    // shadow event carried nothing but its own name and a null ticket — it could not
    // identify the proposed group at all, which is the entire point of shadow mode.
    // (The unit tests missed it because they inspect the raw pre-envelope object.)
    correlation_id = null,
    signature = null,
    anchor = null,
    tickets = null,
  } = event;
  // Escalations carry WARN severity; fixes/triage carry INFO.
  //
  // CTL-1568 (Codex #2861 P1): recovery.escalation.split is an alarm — it fires when
  // the escalation comment and the needs-human label DISAGREE, i.e. a human was told
  // to check an inbox row that does not exist. It was serialized as INFO, so the
  // "loud one-time alarm" was an unclassified log line no severity-based alert or
  // dashboard would surface. It is WARN, like the other escalation events.
  const escalated =
    type === "recovery.would-escalate" ||
    type === "recovery.escalated" ||
    type === "recovery.escalation.split";
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
      // CTL-1568 (Codex #2861 P1): carry the split alarm's own dimensions. Both were
      // passed by the emitter and silently dropped here, leaving the alarm with no
      // source site and no retry count — the two things an operator needs to tell a
      // one-off transient from a ticket wedged against a permanently failing label.
      ...(site != null ? { "recovery.site": String(site) } : {}),
      ...(deferrals != null ? { "recovery.deferrals": Number(deferrals) } : {}),
      // CAT-170: correlation dimensions promoted to attributes so a dashboard can
      // group an incident by id/anchor without parsing the body. `tickets` stays
      // body-only — an unbounded list has no place in an attribute set.
      ...(correlation_id != null ? { "recovery.correlation_id": String(correlation_id) } : {}),
      ...(signature != null ? { "recovery.signature": String(signature) } : {}),
      ...(anchor != null ? { "recovery.anchor": String(anchor) } : {}),
      ...(Array.isArray(tickets) ? { "recovery.correlated_count": tickets.length } : {}),
      // CTL-1291: bounded numerics/enums promoted so the numbers are chartable.
      ...promoteNumericAttrs(type, details),
    },
    // human-readable mirror; also the reader's fallback ticket-key source.
    body: {
      payload: {
        ticket,
        type,
        fix_class,
        reason,
        details,
        escalation,
        site,
        deferrals,
        ...(correlation_id != null ? { correlation_id } : {}),
        ...(signature != null ? { signature } : {}),
        ...(anchor != null ? { anchor } : {}),
        ...(Array.isArray(tickets) ? { tickets } : {}),
      },
    },
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
    // CTL-1889 inc 2: cloud write proxy under enforce; the helper otherwise, with its
    // cwd/env preserved verbatim (it resolves projectKey from cwd ancestry).
    const res = postLinearCommentAsSpawnResult(ticket, markdown, {
      caller: "recovery-reasoning",
      runHelper: (t, b) =>
        spawnSync(LINEAR_COMMENT_POST_BIN, [t, b], {
          cwd: opts.cwd ?? process.cwd(),
          env: { ...process.env, ...(opts.env ?? {}) },
          encoding: "utf8",
          maxBuffer: 10 * 1024 * 1024,
        }),
    });
    if (res.status === 0) {
      return { ok: true, via: "app-actor" };
    }
    log(
      `recovery-reasoning: ${ticket} comment post failed (status ${res.status}): ` +
        `${(res.stderr || res.error?.message || "unknown").toString().trim().split("\n").pop()}`
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

// CTL-1679: derive the phase whose synthetic `complete` wakes the scheduler to
// re-dispatch `phase` (its immediate predecessor in the pipeline). Mirrors the
// workflow-token-redispatch template, which emits `review` (prev of `pr`) to
// re-arm `pr`. PHASES is loaded lazily via requireSync to avoid a static cycle
// (phase-fsm re-exports the workflow descriptor's ordered phase list). Fail-safe:
// if the phase is the first / unknown, fall back to the phase itself (an
// idempotent wake — deriveAdvancement still re-derives `pending` as next).
export function fenceStalePrevPhase(phase) {
  try {
    const { PHASES } = requireSync("../lib/phase-fsm.mjs");
    const idx = Array.isArray(PHASES) ? PHASES.indexOf(phase) : -1;
    if (idx > 0) return PHASES[idx - 1];
  } catch {
    /* descriptor unavailable → fall back to the phase itself */
  }
  return phase;
}

export function defaultInvokeSeam(ticket, seamId, brief = {}, deps = {}) {
  // CTL-1679: fence-stale-redispatch — re-arm the phase that bowed out on a stale
  // cluster fence (cluster_fence_stale) for a fresh-generation re-dispatch. It is
  // the workflow-token-redispatch template plus two extra steps the fence case
  // needs (research Addendum): (1) delete the stale claim tombstone
  // workers/<T>/phase-<P>.claim.<N> — a leftover collides on the next O_EXCL claim
  // create → "claim-lost" silent stall (mirrors scheduler.mjs maybeResetForRemediateCycle);
  // (2) clear the dispatch cooldown so a 30-min window / armed circuit breaker
  // doesn't suppress the redispatch. `spawnSyncFn` is injectable for hermetic tests.
  if (seamId === "fence-stale-redispatch") {
    const orchDir = deps.orchDir ?? resolveOrchDir();
    if (!orchDir) {
      return { success: false, reason: "no orchDir for fence-stale re-dispatch", details: {} };
    }
    const spawnSyncFn = deps.spawnSyncFn ?? spawnSync;
    // Production threads the failed phase through the brief (attemptFix sets
    // brief.phase from classification details.phase); tests inject deps.phase.
    const phase = deps.phase ?? brief?.phase;
    if (!phase) {
      return { success: false, reason: "no phase for fence-stale re-dispatch", details: {} };
    }
    const signalPath = join(orchDir, "workers", ticket, `phase-${phase}.json`);
    if (!existsSync(signalPath)) {
      return {
        success: false,
        reason: `fence-stale re-dispatch: signal file absent (${signalPath})`,
        details: { phase, signalPath },
      };
    }
    try {
      let sig = {};
      try {
        sig = JSON.parse(readFileSync(signalPath, "utf8"));
      } catch {
        sig = {};
      }
      // (1) delete the stale claim tombstone at the signal's generation.
      const gen = sig.generation;
      if (gen !== undefined && gen !== null) {
        try {
          rmSync(join(orchDir, "workers", ticket, `phase-${phase}.claim.${gen}`), { force: true });
        } catch {
          /* best-effort — a leftover tombstone is the very thing we're clearing */
        }
      }
      // (2) reset signal → pending, drop failureReason AND retrySafe, preserve all
      // other fields. Clearing retrySafe is load-bearing: a re-dispatched phase that
      // later fails for a DIFFERENT, unrecognized-and-UNSAFE reason (emitted without
      // --payload-json, so it stamps no retry_safe) must NOT inherit this run's stale
      // retrySafe:true — that would misroute it into the bounded-retry rule instead of
      // an immediate escalate (Codex finding). The next genuine fence-stale bow-out
      // re-stamps it fresh via emit-complete's --payload-json.
      sig.status = "pending";
      delete sig.failureReason;
      delete sig.retrySafe;
      const tmp = `${signalPath}.tmp.${process.pid}`;
      writeFileSync(tmp, JSON.stringify(sig, null, 2));
      renameSync(tmp, signalPath);
      // (3) clear the dispatch cooldown marker (inline — importing scheduler.mjs
      // here would be a cycle; the marker lives at .dispatch-cooldowns/<T>-<P>.json).
      try {
        rmSync(join(orchDir, ".dispatch-cooldowns", `${ticket}-${phase}.json`), { force: true });
      } catch {
        /* best-effort — a stale marker just suppresses one re-dispatch */
      }
      // (4) synthetic wake: emit prev-phase complete so deriveAdvancement re-derives
      // <phase> as next and re-dispatches it. --no-signal-update: we own the reset.
      const wakePhase = fenceStalePrevPhase(phase);
      const res = spawnSyncFn(
        EMIT_COMPLETE_BIN,
        [
          "--phase",
          wakePhase,
          "--ticket",
          ticket,
          "--status",
          "complete",
          "--no-signal-update",
          "--orch-dir",
          orchDir,
          "--orch-id",
          ticket,
        ],
        { encoding: "utf8" }
      );
      return {
        success: res.status === 0 || res.status == null,
        reason: "re-armed fence-stale phase (reset failed→pending) and woke the scheduler",
        details: { phase, wakePhase, signalPath, wakeStatus: res.status ?? null, seam_id: seamId },
      };
    } catch (err) {
      return { success: false, reason: err.message, details: { error: err.message } };
    }
  }

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
          "--phase",
          "review",
          "--ticket",
          ticket,
          "--status",
          "complete",
          "--no-signal-update",
          "--orch-dir",
          orchDir,
          "--orch-id",
          ticket,
        ],
        { encoding: "utf8" }
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

  // Select by capability: partial/empty registries fall back to a registry built
  // with the production dependency bundle. resolvePrState/jobLifecycle defaults
  // are deliberately inert, so callers with live evidence must inject them.
  let registry = deps.actByCategory;
  if (!registry || typeof registry[category] !== "function") {
    // An explicit operator registry is a posture binding both passes. Do not rebuild a live
    // fallback behind an empty or partial registry supplied to keep this category inert.
    if (deps.seamFallbackSuppressed === true) {
      return {
        success: false,
        reason: `registry seam '${category}' suppressed by operator override`,
        details: { suppressed: true, category },
      };
    }
    try {
      registry = buildUnstuckActSeams({
        orchDir: deps.orchDir ?? resolveOrchDir(),
        ...(deps.resolvePrState ? { resolvePrState: deps.resolvePrState } : {}),
        ...(deps.jobLifecycle ? { jobLifecycle: deps.jobLifecycle } : {}),
        ...(deps.clearStall ? { clearStall: deps.clearStall } : {}),
        ...(deps.writeStatus ? { writeStatus: deps.writeStatus } : {}),
        ...(deps.emitPhaseComplete ? { emitPhaseComplete: deps.emitPhaseComplete } : {}),
        ...(deps.nowMs ? { nowMs: deps.nowMs } : {}),
      });
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
export const RECOVERY_PASS_CYCLE_CAP = Number(process.env.CATALYST_RECOVERY_PASS_CYCLE_CAP) || 3;

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
  let dispatchTicket,
    countRecoveryPassCycles,
    settleDispatchSync,
    isThenable,
    backstopOnRejection,
    sdkSignalRunnable;
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
          backstopOnRejection?.({ orchDir, ticket, phase: RECOVERY_PASS_PHASE, log: defaultLogFn })(
            _res,
            err ?? new Error(`sdk recovery-pass resolved code=${_res?.code}`)
          );
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
        verifySync: () =>
          sdkSignalRunnable ? sdkSignalRunnable(orchDir, ticket, RECOVERY_PASS_PHASE) : true,
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
        pendingSdk: r.async ? (r.pending ?? null) : null,
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
export const RECOVERY_MAX_ATTEMPTS = Number(process.env.CATALYST_RECOVERY_MAX_ATTEMPTS) || 2;

// CTL-1568: how many consecutive ticks an attempts-exhausted escalation may DEFER
// because its needs-human label write did not land (fence suppression, rate limit,
// missing label) before the sweep gives up, latches terminal, and raises the
// escalation-split alarm. Bounded because the deferred entry stays un-latched so the
// next tick retries — without a ceiling a permanently-fenced host would re-scan and
// re-emit forever. Env-overridable, default 5 (NaN/0 → default, matching siblings).
export const RECOVERY_MAX_ESCALATION_DEFERRALS =
  Number(process.env.CATALYST_RECOVERY_MAX_ESCALATION_DEFERRALS) || 5;

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
export function readDeferredBoardHealthIntents(
  orchDir,
  { now = () => Date.now(), cooldownMs = RECOVERY_COOLDOWN_MS } = {}
) {
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
  // CAT-170: best-effort typed failure signature, written on attempt/marker
  // writes. Absence means no typed signature; terminal writes clear stale data.
  const signature =
    normalizeSignature(intent.signature) ??
    (isMarkerWrite ? normalizeSignature(prior.signature) : null);
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
    ...(signature ? { signature } : {}),
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
      opts
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
      opts
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
      opts
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
    // CTL-1440 (Codex R1): TWO gates for a board-health defer. The per-item
    // pass throttles on lastTs (the last touch — a re-defer refreshes it, so
    // re-processing is once per window). The HOLISTIC act (opts.holistic) gates
    // on the FROZEN aging anchor deferredSince: the per-item pass re-deferring
    // seconds before board-health reads is a no-op handoff and must not push
    // the aged candidate back under cooldown (the residual starvation half of
    // the RC3 collision). Non-board-health defers keep the lastTs gate.
    const holisticAnchor =
      opts.holistic && data?.fix_class === "board-health" && typeof data?.deferredSince === "number"
        ? data.deferredSince
        : null;
    const last = holisticAnchor ?? (typeof data?.lastTs === "number" ? data.lastTs : data?.ts);
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

// ─── CTL-1568: escalation-deferral counter ──────────────────────────────────
// Deliberately NOT stored in the recovery-intent ledger: defaultRecordIntent
// latches `escalated` stickily and any write carrying decision:"escalate" trips
// that latch, which would make the sweep skip the very ticket we still need to
// retry. A side marker keeps the retry counter orthogonal to the latch.
// Best-effort throughout — a counter failure must never break the sweep.
function escalationDeferralPath(orchDir, ticket) {
  return join(orchDir, ".escalation-deferrals", `${ticket}.json`);
}

// readEscalationDeferrals — this ticket's consecutive deferral count (0 when
// absent/malformed). Read separately from the bump so the sweep can cheaply skip a
// ticket whose deferrals are already exhausted BEFORE spending a Linear label write
// on it. Never throws.
export function readEscalationDeferrals(orchDir, ticket) {
  try {
    const prior = JSON.parse(readFileSync(escalationDeferralPath(orchDir, ticket), "utf8"));
    return typeof prior?.count === "number" ? prior.count : 0;
  } catch {
    return 0;
  }
}

// bumpEscalationDeferrals — increment and return this ticket's consecutive deferral
// count (1 on the first).
//
// Returns NULL when the counter could not be persisted. That is deliberate and
// load-bearing: the reorder that puts the label attempt ahead of the ledger latch
// weakens Codex R1's "verify the latch before any human-facing side effect" rule,
// whose purpose was to stop a disk-full/permission failure re-firing every tick. The
// counter is what restores that bound — so if the counter itself cannot be written,
// we have no bound, and the caller must stay SILENT (retry quietly, emit nothing)
// rather than emit a WARN on every tick of a broken disk. Never throws.
export function bumpEscalationDeferrals(orchDir, ticket, now) {
  const p = escalationDeferralPath(orchDir, ticket);
  const next = readEscalationDeferrals(orchDir, ticket) + 1;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ ticket, count: next, lastAt: now }));
  } catch {
    return null; // unbounded → caller must not emit
  }
  return next;
}

// clearEscalationDeferrals — drop the counter once the escalation completes, so a
// later unrelated exhaustion starts from a clean slate. Idempotent; never throws.
export function clearEscalationDeferrals(orchDir, ticket) {
  try {
    unlinkSync(escalationDeferralPath(orchDir, ticket));
    return true;
  } catch {
    return false; // absent is the common case
  }
}

// ─── CAT-170: pending member→anchor pointer ─────────────────────────────────
// Codex #3209 P1. A correlated group escalates in two steps: the anchor is acted on
// first, then each member gets a pointer brief. When the anchor SUCCEEDS but a
// member's label write transiently fails, that member is left unlatched — and the
// anchor's ledger is now `escalated:true`, which excludes it from the next sweep's
// candidate scan. So on the following tick the member regroups ALONE, classifies as
// a singleton, and receives its own full `recovery.escalated` decision — a second
// operator incident for a cause the anchor already advertised as covering it.
//
// This marker is what survives that gap: it records which anchor the member belongs
// to, so its retry stays a POINTER instead of becoming a new decision. Stored beside
// the deferral counter (never in the recovery-intent ledger, for the same reason:
// any write carrying decision:"escalate" trips the sticky `escalated` latch and the
// sweep would skip the very ticket we still need to retry).
//
// The pointer is deliberately WINDOWED by the same correlation window the grouping
// uses — an anchor from days ago is no longer a live incident, so a stale pointer
// expires into normal singleton handling rather than pointing a human at an
// escalation they have long since closed.
function correlationPointerPath(orchDir, ticket) {
  return join(orchDir, ".escalation-correlation", `${ticket}.json`);
}

// readCorrelationPointer — this ticket's pending member pointer, or null when absent,
// malformed, or older than `windowMs`. Never throws.
export function readCorrelationPointer(orchDir, ticket, { windowMs, now } = {}) {
  let prior;
  try {
    prior = JSON.parse(readFileSync(correlationPointerPath(orchDir, ticket), "utf8"));
  } catch {
    return null; // absent or malformed → no pointer
  }
  if (!prior || typeof prior.anchor !== "string" || !prior.anchor) return null;
  // A pointer at its own anchor is meaningless (and would make the member loop skip
  // the anchor act entirely) — treat it as absent.
  if (prior.anchor === ticket) return null;
  if (typeof windowMs === "number" && Number.isFinite(windowMs)) {
    const at = Number(prior.at);
    const ts = typeof now === "number" ? now : Date.now();
    if (!Number.isFinite(at) || ts - at > windowMs) return null; // stale → expired
  }
  return prior;
}

// writeCorrelationPointer — record that `ticket` is a deferred member of `anchor`.
// Best-effort: a write failure just means the next tick treats it as a singleton
// (the pre-CAT-170 behaviour), never a thrown error. Returns true when persisted.
export function writeCorrelationPointer(orchDir, ticket, pointer, now) {
  const p = correlationPointerPath(orchDir, ticket);
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        ticket,
        anchor: pointer.anchor,
        correlation_id: pointer.correlation_id ?? null,
        signature: pointer.signature ?? null,
        tickets: Array.isArray(pointer.tickets) ? pointer.tickets : [ticket],
        at: now,
      })
    );
    return true;
  } catch {
    return false;
  }
}

// clearCorrelationPointer — drop the pointer once the member's escalation completes
// (or once it is no longer a member). Idempotent; never throws.
export function clearCorrelationPointer(orchDir, ticket) {
  try {
    unlinkSync(correlationPointerPath(orchDir, ticket));
    return true;
  } catch {
    return false; // absent is the common case
  }
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
// CAT-170 (Codex #3209 P2): only three modes are recognized downstream (`off`,
// `shadow`, `enforce`). The raw env value used to pass through unvalidated, so an
// empty string, a typo, or `Shadow` fell through every branch and behaved like
// `off` — silently suppressing even the default-shadow telemetry an operator relies
// on to see what correlation WOULD do. Normalize case/whitespace and fall an
// unrecognized value back to the DECLARED default (`shadow`), never to `off`:
// degrading toward observe-only is safe, degrading toward silence is not.
export const RECOVERY_CORRELATION_MODES = Object.freeze(["off", "shadow", "enforce"]);

export function resolveCorrelationMode(raw, fallback = "shadow") {
  const mode = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return RECOVERY_CORRELATION_MODES.includes(mode) ? mode : fallback;
}

export const RECOVERY_CORRELATION_MODE = () =>
  resolveCorrelationMode(process.env.CATALYST_RECOVERY_CORRELATION);

export function escalateExhaustedIntents(orchDir, opts = {}) {
  const {
    now = () => Date.now(),
    maxAttempts = RECOVERY_MAX_ATTEMPTS,
    recordIntent = (t, i) => defaultRecordIntent(t, i, { orchDir, now }),
    postComment = defaultPostComment,
    emitEvent = defaultEmitEvent,
    // CTL-1568: the seam's contract is now (orchDir, ticket) => boolean — TRUE only
    // when the needs-human label was CONFIRMED applied on this call. The scheduler
    // wires labelNeedsHumanUnlessBeliefOwner, which already returns exactly that
    // (label-guard.mjs:381-411). The escalation comment is gated on it, so a stub
    // that returns undefined reads as "did not land" and withholds the comment.
    labelNeedsHuman = null,
    // CTL-1568: distinguishes the two reasons the label write can report false.
    // `false` from labelNeedsHuman means EITHER the write was suppressed/failed OR
    // the belief engine owns the label (CATALYST_INTENTS_ENFORCE=1) and will apply
    // it out-of-band. Only the first is a broken escalation; the second is the
    // ticket's sanctioned "hand the escalation to the owning host" remedy, where
    // the comment stays truthful. Defaults to the real predicate.
    beliefOwnsLabel = () => beliefOwnsNeedsHuman(process.env),
    maxDeferrals = RECOVERY_MAX_ESCALATION_DEFERRALS,
    writeSignal = (t, payload) => defaultWriteEscalationSignal(t, payload, { orchDir }),
    // Codex R1: a finished ticket can hold a stale exhausted ledger until the
    // terminal cleanup (recoveryForgetIntent) runs LATER in the tick — the sweep
    // must not page a human about a Done ticket. The scheduler wires this to the
    // cached terminal/merged check; default keeps the function pure/hermetic.
    isActive = () => true,
    log = defaultLogFn,
    correlationMode: correlationModeOpt = RECOVERY_CORRELATION_MODE(),
    correlationWindowMs = RECOVERY_CORRELATION_WINDOW_MS,
    correlationMinGroup = RECOVERY_CORRELATION_MIN_GROUP,
  } = opts;
  // CAT-170 (Codex #3209 P2): an INJECTED mode gets the same validation as the env
  // one, so a caller cannot smuggle an unrecognized value past the branches below.
  const correlationMode = resolveCorrelationMode(correlationModeOpt);
  if (!orchDir) return [];
  let files;
  try {
    files = readdirSync(join(orchDir, ".recovery-intents"));
  } catch {
    return [];
  }
  const candidates = [];
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
    // Codex R1: never escalate a finished ticket (fail toward ACTIVE — a wrongly
    // skipped live ticket just waits a tick; the ledger is forgotten by the
    // terminal cleanup once the ticket is confirmed done).
    let active = true;
    try {
      active = isActive(ticket) !== false;
    } catch {
      active = true;
    }
    if (!active) continue;
    if (readEscalationDeferrals(orchDir, ticket) >= maxDeferrals) continue;
    candidates.push({
      ticket,
      file: f,
      data,
      signature: data.signature ?? null,
      lastTs: data.lastTs ?? data.ts,
    });
  }

  // CAT-170 (Codex #3209 P1): pull out candidates carrying a PENDING member pointer
  // BEFORE grouping. A member whose act failed after its anchor already latched is
  // still part of that incident — but the anchor's ledger now reads `escalated:true`,
  // so it is no longer a candidate and cannot re-form the group. Left to normal
  // grouping the member would classify as a singleton and emit a second full
  // `recovery.escalated` for a cause the anchor already advertised as covering it.
  // Routing it through the pointer pass keeps its retry a POINTER at the original
  // anchor. Only `enforce` produces members; a pointer older than the correlation
  // window expires inside readCorrelationPointer and the ticket falls back to normal
  // grouping (a long-closed incident must not keep pointing a human at it).
  const pendingPointers = new Map();
  if (correlationMode === "enforce") {
    for (const candidate of candidates) {
      const pointer = readCorrelationPointer(orchDir, candidate.ticket, {
        windowMs: correlationWindowMs,
        now: now(),
      });
      if (pointer) pendingPointers.set(candidate.ticket, pointer);
    }
  }
  const groupableCandidates = pendingPointers.size
    ? candidates.filter((candidate) => !pendingPointers.has(candidate.ticket))
    : candidates;

  const computedGroups = groupCandidates(groupableCandidates, {
    windowMs: correlationWindowMs,
    minGroup: correlationMinGroup,
    now: now(),
  });
  const candidateByTicket = new Map(
    groupableCandidates.map((candidate) => [candidate.ticket, candidate])
  );
  if (correlationMode === "shadow") {
    for (const group of computedGroups.filter((g) => g.correlated)) {
      emitEvent({
        type: "recovery.escalation.would-correlate",
        correlation_id: correlationId(group.signature, group.anchor),
        signature: group.signature,
        anchor: group.anchor,
        tickets: group.tickets,
      });
    }
  }
  const groups =
    correlationMode === "enforce"
      ? computedGroups.map((group) => ({
          ...group,
          anchor: candidateByTicket.get(group.anchor),
          members: group.members.map((ticket) => candidateByTicket.get(ticket)).filter(Boolean),
        }))
      : candidates.map((candidate) => ({
          signature: candidate.signature,
          anchor: candidate,
          members: [],
          tickets: [candidate.ticket],
          correlated: false,
        }));
  const escalatedTickets = [];
  // A provisional anchor whose signal persisted is already operator-visible even
  // when its ledger latch later fails. Do not fail over to a second anchor in the
  // same tick: that would leave two durable `role: "anchor"` signals until retry.
  const durableAnchorSignals = new Set();

  const actOnTicket = (candidate, { role = "singleton", group = null, anchor = null } = {}) => {
    const { ticket, data, file: f } = candidate;
    const reason = `self-heal attempts exhausted (${data.attempts} dispatches without a recorded verdict)`;
    // CAT-170: a resumed member carries the correlation id its anchor was escalated
    // under, so prefer the recorded value over a recompute — the id a human already
    // saw must stay stable even if the signature text is normalized differently later.
    const corrId = group?.correlated
      ? (group.correlationId ?? correlationId(group.signature, anchor ?? ticket))
      : null;
    const correlatedTickets = group?.tickets ?? [ticket];
    const escalation =
      role === "singleton"
        ? {
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
          }
        : {
            escalation_type: "authorization",
            problem:
              role === "anchor"
                ? `${correlatedTickets.join(", ")} exhausted recovery attempts for the shared cause "${group.signature}".`
                : `${ticket} is part of correlated incident ${corrId} — ${correlatedTickets.length} tickets share this cause; the decision is on ${anchor}.`,
            call_to_action:
              role === "anchor"
                ? `look at ${correlatedTickets.join(", ")}: authorize one recovery cycle for this shared cause, or take the incident over?`
                : `see the escalation on ${anchor}`,
            recommendation: `inspect the correlated recovery-pass failures on ${anchor ?? ticket}`,
            risk: `left latched the affected tickets rot silently`,
            why_asking: reason,
            observed: {
              attempts: data.attempts,
              decision: data.decision ?? null,
              fix_class: data.fix_class ?? null,
              correlation_id: corrId,
              signature: group.signature,
              correlated_tickets: correlatedTickets,
              correlated_count: correlatedTickets.length,
            },
            // CAT-170 (Codex #3209 P1): the same identity ALSO as a first-class payload
            // key. `observed` is audit passthrough that synthesizeEscalationExplanation
            // discards, so it cannot be what a board consumer groups or suppresses on —
            // writeEscalationSignal persists THIS key onto the signal instead.
            correlation: {
              id: corrId,
              role,
              anchor: anchor ?? ticket,
              signature: group.signature,
              tickets: correlatedTickets,
              count: correlatedTickets.length,
            },
            attempts: [],
          };
    // ─── CTL-1568: the LABEL is attempted FIRST, and it gates everything after ───
    // The escalation comment claims "(See your inbox.)". For a ticket with no worker
    // dir — 10 of 12 parked tickets, measured 2026-07-29 (daemon.mjs:431-434) — there
    // is no signal file, so the board synthesizes that inbox row from the LABEL alone.
    // A comment without the label therefore advertises an inbox entry that does not
    // exist, which is the CTL-1568 split.
    //
    // The attempt MUST precede the ledger latch. defaultRecordIntent makes the latch
    // STICKY (`(prior.escalated && !expired) || intent.escalated || decision ===
    // "escalate"`, CTL-1431 F2), so once `escalated:true` is written no later call can
    // un-latch it and the sweep would skip the ticket forever. Attempting the label
    // first means a failed write leaves the ledger untouched, and the next tick
    // re-scans and retries the whole act naturally.
    //
    // Bound the total cost: once a ticket has burned its deferrals the split alarm
    // has already fired and only a human can resolve it, so stop spending a Linear
    // label write on it every tick. This ceiling is what keeps the pre-latch attempt
    // from re-firing forever on a persistently-failing host.
    let labelled = false;
    try {
      labelled = labelNeedsHuman?.(orchDir, ticket) === true;
    } catch (err) {
      log(`recovery-reasoning: ${ticket} exhausted-escalate label failed: ${err.message}`);
    }
    // A `false` return has TWO causes and only one is a broken escalation: the belief
    // engine (CATALYST_INTENTS_ENFORCE=1) owns needs-human and applies it out-of-band
    // (label-guard.mjs:394-399). That is the ticket's sanctioned "hand the escalation
    // to the owning host" remedy — ownership transferred, so the comment stays truthful.
    let ownedByBelief = false;
    if (!labelled) {
      try {
        ownedByBelief = beliefOwnsLabel() === true;
      } catch {
        ownedByBelief = false; // unreadable → treat as a real miss, never a transfer
      }
    }
    if (!labelled && !ownedByBelief) {
      // Half the escalation is missing. Post NO comment, latch NOTHING, and let the
      // next tick retry. Bounded by maxDeferrals so a persistently-failing host raises
      // the split alarm once instead of re-emitting a WARN every tick forever.
      const deferrals = bumpEscalationDeferrals(orchDir, ticket, now());
      if (deferrals === null) {
        // Counter unwritable → no bound available. Retry quietly next tick; emitting
        // here would re-fire on every tick of a broken disk (Codex R1's storm).
        log(
          `recovery-reasoning: ${ticket} exhausted-escalate label did not land and the deferral counter is unwritable — retrying silently`
        );
      } else if (deferrals < maxDeferrals) {
        emitEvent({
          type: "recovery.escalation.deferred",
          ticket,
          reason,
          deferrals,
          site: "attempts-exhausted",
        });
        log(
          `recovery-reasoning: ${ticket} exhausted-escalate label did not land — comment withheld, ` +
            `escalation deferred (${deferrals}/${maxDeferrals}); retrying next tick`
        );
      } else if (deferrals === maxDeferrals) {
        // AC #5 — the should-never-happen state, raised ONCE, loudly.
        emitEvent({
          type: "recovery.escalation.split",
          ticket,
          reason,
          deferrals,
          site: "attempts-exhausted",
        });
        log(
          `recovery-reasoning: ${ticket} exhausted-escalate SPLIT — needs-human label has not landed ` +
            `after ${deferrals} attempts; escalation cannot complete from this host`
        );
      }
      // CAT-170 (Codex #3209 P1): the act failed for a ticket that IS part of a
      // correlated incident whose anchor has already latched. Record which anchor it
      // belongs to so the next tick retries it as a POINTER rather than regrouping it
      // into a fresh standalone escalation. Best-effort — a failed pointer write just
      // restores the previous singleton behaviour.
      if (group?.correlated && anchor && anchor !== ticket) {
        writeCorrelationPointer(
          orchDir,
          ticket,
          {
            anchor,
            correlation_id: corrId,
            signature: group.signature,
            tickets: correlatedTickets,
          },
          now()
        );
      }
      return false; // the act did not complete — not counted as escalated
    }
    // The label landed (or its owner has it) — this escalation can now complete.
    clearEscalationDeferrals(orchDir, ticket);

    // CAT-170 (Codex #3209 round-2 P1): persist the escalation signal BEFORE the
    // ledger latch, and treat a failed write as a failed act. The `correlation`
    // block on this signal is the ONLY durable carrier of a member's role, and the
    // latch below is IRREVERSIBLE: `escalated:true` drops the ticket from every
    // later candidate sweep, so its pointer is never re-read and the role can never
    // be retried. Latching first turned one lost write into a PERMANENTLY
    // uncorrelated member — both notification projectors then treat it as
    // independent and emit exactly the duplicate operator alert this feature exists
    // to suppress. Writing first keeps that failure recoverable: no latch, pointer
    // retained, so the next sweep re-acts it as a member. Ordering is safe because
    // this write is an idempotent atomic tmp+rename keyed by ticket — a retry
    // rewrites one file rather than re-posting anything operator-visible. The
    // comment/event below stay gated behind the VERIFIED latch, exactly as before,
    // so the at-most-once discipline for those surfaces is unchanged.
    let signalWritten = true;
    try {
      // `!== false` so an injected double returning undefined still reads as success.
      signalWritten = writeSignal(ticket, escalation) !== false;
    } catch (err) {
      log(`recovery-reasoning: ${ticket} exhausted-escalate signal write failed: ${err.message}`);
      signalWritten = false;
    }
    if (!signalWritten) {
      // Same reasoning as the label-failure branch above: this act failed for a
      // ticket whose anchor may have already latched this tick, so the group cannot
      // re-form next tick. Record (or refresh) the pointer or the member regroups as
      // a singleton and raises the duplicate escalation anyway.
      if (group?.correlated && anchor && anchor !== ticket) {
        writeCorrelationPointer(
          orchDir,
          ticket,
          {
            anchor,
            correlation_id: corrId,
            signature: group.signature,
            tickets: correlatedTickets,
          },
          now()
        );
      }
      log(
        `recovery-reasoning: ${ticket} exhausted-escalate signal did not persist — retrying next tick (correlation pointer retained)`
      );
      return false; // unlatched → still a candidate, pointer intact → retried as a member
    }
    if (role === "anchor") durableAnchorSignals.add(ticket);

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
      return false; // without the latch the sweep would re-fire every tick — try again next tick
    }
    // Codex R1: defaultRecordIntent swallows write failures (best-effort by
    // design) — VERIFY the latch actually landed before any human-facing side
    // effect, or a disk-full/permission failure would re-post the signal/
    // comment/label/event every tick.
    let latched = false;
    try {
      latched =
        JSON.parse(readFileSync(join(orchDir, ".recovery-intents", f), "utf8"))?.escalated === true;
    } catch {
      latched = false;
    }
    if (!latched) {
      log(
        `recovery-reasoning: ${ticket} exhausted-escalate latch did not persist — deferring side effects to the next tick`
      );
      return false;
    }
    // CAT-170 (Codex #3209 P2): clear the member pointer ONLY once the latch is
    // verified. It used to be cleared before recordIntent, which meant a throwing
    // ledger write or a latch that did not persist dropped the durable anchor
    // pointer while the escalation itself returned for retry. The next sweep then
    // saw an unlatched ticket with no pointer, regrouped it as a singleton, and
    // raised a SECOND full operator escalation — the exact duplicate-alert failure
    // this correlation work exists to prevent. Retaining the pointer until the
    // latch is proven costs at most a stale pointer on a permanently-failing host,
    // which the correlation window expires anyway.
    // The signal (and with it the member's correlation role) is already durable —
    // written and confirmed above, before the latch — so dropping the pointer here
    // can no longer lose the role.
    clearCorrelationPointer(orchDir, ticket);
    emitEvent({
      type: role === "member" ? "recovery.escalation.correlated" : "recovery.escalated",
      ticket,
      reason,
      escalation,
      ...(corrId ? { correlation_id: corrId, anchor: anchor ?? ticket } : {}),
    });
    try {
      postComment(
        ticket,
        role === "member"
          ? `Part of correlated recovery incident ${corrId}; see the operator escalation on ${anchor}.`
          : `🔼 **recovery-pass** self-heal attempts exhausted on this ticket — escalated to the operator. ${reason}. (See your inbox.)`
      );
    } catch {
      /* comment is best-effort; the signal + event are the durable surfaces */
    }
    if (role !== "member") escalatedTickets.push(ticket);
    log(
      `recovery-reasoning: ${ticket} attempts-exhausted → escalated loudly (CTL-1440)` +
        (ownedByBelief ? " [label owned by belief engine — CTL-1568 transfer]" : "")
    );
    return true;
  };

  for (const group of groups) {
    if (!group.correlated) {
      actOnTicket(group.anchor);
      continue;
    }
    const ordered = [group.anchor, ...group.members];
    let anchorCandidate = null;
    // CAT-170 (Codex #3209 P2): remember which candidates the anchor-selection loop
    // already spent an act on. It breaks on the FIRST success, so every candidate up
    // to and including the winner has been attempted; the member loop below must not
    // act on any of them a second time. A persistently label-failing ticket that was
    // tried as a provisional anchor and then re-tried as a member performed two label
    // writes, emitted two recovery.escalation.deferred events, and burned its bounded
    // RECOVERY_MAX_ESCALATION_DEFERRALS budget at 2x rate in a single tick.
    const attempted = new Set();
    for (const candidate of ordered) {
      attempted.add(candidate.ticket);
      if (actOnTicket(candidate, { role: "anchor", group, anchor: candidate.ticket })) {
        anchorCandidate = candidate;
        break;
      }
      if (durableAnchorSignals.has(candidate.ticket)) break;
    }
    if (!anchorCandidate) {
      // Every candidate was already attempted above (the loop only breaks on a
      // success), and a FAILED anchor attempt produces exactly the singleton
      // path's side effects — the label gate fails before any correlated
      // escalation is written. Re-running them here would bump each ticket's
      // escalation-deferral counter twice in one tick, burning the
      // RECOVERY_MAX_ESCALATION_DEFERRALS budget at 2x rate and double-emitting
      // recovery.escalation.deferred. Nothing left to do for this group.
      continue;
    }
    for (const candidate of ordered) {
      if (candidate.ticket === anchorCandidate.ticket) continue;
      if (attempted.has(candidate.ticket)) {
        // Already acted on this tick as a provisional anchor, and it failed. Do not
        // spend a second act — but DO record the pointer, so its retry next tick is a
        // member of the anchor that actually won rather than a fresh singleton
        // escalation (the same P1 correlation loss the deferred-member path fixes).
        writeCorrelationPointer(
          orchDir,
          candidate.ticket,
          {
            anchor: anchorCandidate.ticket,
            correlation_id: correlationId(group.signature, anchorCandidate.ticket),
            signature: group.signature,
            tickets: group.tickets,
          },
          now()
        );
        continue;
      }
      actOnTicket(candidate, {
        role: "member",
        group,
        anchor: anchorCandidate.ticket,
      });
    }
  }

  // CAT-170 (Codex #3209 P1): the pointer pass — deferred members retrying against an
  // anchor that has already latched (and is therefore no longer a candidate, so no
  // group can re-form around it). Each is acted on as a MEMBER of its recorded
  // anchor, so it stays a pointer brief instead of becoming a second standalone
  // operator decision. A synthetic group carries the pointer's own recorded identity;
  // `correlated: true` is what makes actOnTicket take the member branch.
  for (const [ticket, pointer] of pendingPointers) {
    const candidate = candidates.find((c) => c.ticket === ticket);
    if (!candidate) continue;
    actOnTicket(candidate, {
      role: "member",
      group: {
        signature: pointer.signature ?? null,
        correlationId: pointer.correlation_id ?? null,
        tickets: Array.isArray(pointer.tickets) ? pointer.tickets : [ticket],
        correlated: true,
      },
      anchor: pointer.anchor,
    });
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
  // CTL-1610: a failed dispatch resets only the retryable COOLDOWN timer. An
  // escalated entry's ts/lastTs are the TERMINAL human-handoff clock the 7-day
  // TTL ages off (RECOVERY_TERMINAL_INTENT_TTL_MS) — stripping them here strands
  // the ticket in a permanent "escalated" latch (defaultSkipReason:2136). Refuse.
  if (prior.escalated === true) return false;
  delete prior.lastTs;
  delete prior.ts;
  try {
    writeFileSync(p, JSON.stringify(prior));
    return true;
  } catch {
    return false;
  }
}

// CTL-1610 (Phase 2): true iff the intent is an escalated latch with NO numeric
// clock — the timestamp-less state that defaultSkipReason:2136 treats as
// permanently terminal. Read-only; absent/malformed ledger → false.
export function defaultLatchHasNoClock(ticket, opts = {}) {
  const orchDir = opts.orchDir ?? resolveOrchDir();
  if (!orchDir || !ticket) return false;
  let data;
  try {
    data = JSON.parse(readFileSync(recoveryIntentPath(orchDir, ticket), "utf8"));
  } catch {
    return false;
  }
  if (!data || data.escalated !== true) return false;
  const last = typeof data.lastTs === "number" ? data.lastTs : data.ts;
  return typeof last !== "number";
}

// CTL-1610 (Phase 3): one-time heal for entries stripped before the Phase-1
// guard shipped. Re-stamps ts/lastTs=now on every escalated+no-clock intent so
// it becomes TTL-bounded instead of permanently terminal. Returns the tickets
// changed. dryRun:true lists without writing.
export function restampNoClockEscalations(opts = {}) {
  const orchDir = opts.orchDir ?? resolveOrchDir();
  const now = opts.now ?? (() => Date.now());
  const dryRun = opts.dryRun === true;
  const dir = join(orchDir, ".recovery-intents");
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const changed = [];
  for (const f of files) {
    const ticket = f.replace(/\.json$/, "");
    if (!defaultLatchHasNoClock(ticket, { orchDir })) continue;
    if (dryRun) {
      changed.push(ticket);
      continue;
    }
    // Per-file try/catch: a single unreadable/unwritable file must not abort
    // the scan — remaining entries must still be healed (CTL-1610 Codex P2).
    try {
      const p = join(dir, f);
      const data = JSON.parse(readFileSync(p, "utf8"));
      const ts = now();
      data.ts = ts;
      data.lastTs = ts;
      writeFileSync(p, JSON.stringify(data));
      changed.push(ticket);
    } catch {
      /* best-effort per-file — continue to next */
    }
  }
  return changed;
}
