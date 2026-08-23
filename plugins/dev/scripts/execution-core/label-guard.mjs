// label-guard.mjs — shared once-marker + cool-down primitives for Linear label
// writes from the execution-core daemon.
//
// Two guards live here because both need to be importable by `scheduler.mjs`
// and `recovery.mjs`, and `scheduler.mjs` already imports from `recovery.mjs`
// (the reclaim-dead-work seam) — so a recovery → scheduler import would
// create a cycle. Keeping the shared utility in a leaf module is the standard
// fix for that shape.
//
//   • labelOnce (CTL-585) — apply a Linear label to a ticket at most once per
//     daemon lifetime, per (ticket, label). Marker file lives under workers/<T>/.
//   • inEscalationCooldown / recordEscalation (CTL-638) — suppress the
//     `appendEscalatedEvent` + `applyStalledLabel` pair on the recovery-sweep
//     escalation path when the same (ticket, phase) already escalated within
//     ESCALATION_COOLDOWN_MS. Marker file lives OUTSIDE workers/<T>/ (see the
//     dispatch cool-down rationale in scheduler.mjs::dispatchCooldownPath and
//     memory project_scheduler_marker_under_workers_excludes_ticket).

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./config.mjs";
import { DISPOSITIONS } from "./worker-disposition.mjs";
import { YIELDED_STATUS } from "../lib/phase-yield.mjs"; // CTL-1854
import {
  TERMINAL_LABEL_REASONS, // COORD-236: one owner for the terminal set
  isThrottledLabelReason, // CTL-2043 (P2-a): the two NARROW predicates — see the
  isCloudReason, //          cool-down arm in labelOnce for why not the wide one
} from "./label-failure-class.mjs";
// CTL-2043 (P2-a): the shared time-boxed cool-down ledger. It lives in its own leaf
// precisely so this file can read it — scheduler.mjs imports THIS file, so importing
// the primitives from there would be a cycle (Decision C).
import { inLabelCooldown, recordLabelCooldown, clearLabelCooldown } from "./label-cooldown.mjs";
import { emitEscalationEvent } from "./escalation-event.mjs"; // CTL-2056
import { publishEscalation } from "./escalation-publish.mjs"; // CTL-2159
import { freshStallStatus, TERMINAL_STALL_STATUS } from "./stall-class.mjs"; // CTL-2159

// ─── labelOnce — moved from scheduler.mjs (CTL-585, then CTL-638 re-home) ───
//
// `linearis` label-add has no read-compare, so without a guard the scheduler
// (and CTL-587's recovery-sweep escalation path) would re-hit the API on every
// tick. Two marker files at workers/<T>/.linear-label-<label>.{applied,skipped}
// record terminal outcomes:
//
//   .applied — applyLabel returned applied:true. Happy path.
//   .skipped — applyLabel returned an UNRECOVERABLE reason ("missing-label": the
//              workspace lacks the label; "exclusive-conflict" (CTL-834): the
//              label's exclusive-group sibling is already on the ticket). Either
//              way the add can never land this run, so retrying every tick would
//              just storm the Linear API (CTL-585). An operator fixes the cause
//              (create the label / clear the sibling) and deletes this marker to
//              re-arm the apply.
//
// Transient failures (reason:"transient", undefined) write no marker so the next
// tick retries — CTL-558's recovery contract. CTL-638 pairs this with the
// escalation cool-down below to break the per-tick storm even when the
// transient-failure path keeps re-attempting the write.
//
// CTL-2043 (P2-a) adds a THIRD outcome between those two, because the pair above
// was not exhaustive and the gap was measured: a THROTTLED or CLOUD-authored
// refusal (`unauthorized`, `budget:*`, `rate-limited`, any `cloud:*`) got NO
// marker at all, so the operator-escalation path re-issued the write every
// tick and spent a host write unit each time for as long as the refusal lasted.
//
//   .applied         — success. Permanent.
//   .skipped         — TERMINAL only. Permanent. Can never land this run.
//   cool-down marker — THROTTLED ∪ CLOUD. TIME-BOXED (LABEL_COOLDOWN_MS), and
//                      kept OUTSIDE workers/<T>/ so worker-dir GC does not
//                      resurrect the storm.
//   (nothing)        — genuinely transient. Retries on the very next tick.
//
// ⛔ The cool-down must NEVER be spelled `.skipped`. That marker lives under
// workers/<T>/ and survives a restart, so it would outlive the credential
// re-mint / budget roll that clears the refusal, and the escalation label the
// operator page depends on would be abandoned for the daemon's life — strictly
// worse than the storm it would be fixing (COORD-236).
// labelMarkerBase — shared path prefix for the once-marker files used by
// labelOnce and clearStalledLabel (single source of truth for the marker path).
export function labelMarkerBase(orchDir, ticket, label) {
  return join(orchDir, "workers", ticket, `.linear-label-${label}`);
}

// UNRECOVERABLE_LABEL_REASONS — the TERMINAL class, now owned by
// label-failure-class.mjs (scheduler.mjs carried a byte-identical hand-written
// copy of this set; one owner, two readers). Kept under its original name so
// every existing reader here still resolves.
//
// ⛔ COORD-236 — READ THIS BEFORE WIDENING THE SET. `.skipped` is a PERMANENT
// marker: labelOnce early-returns for the rest of the daemon's life once it
// exists. So this predicate must stay TERMINAL-only. Adding the budget/rate-limit
// class here — the tempting "fix" for the same incident that motivated the
// converger's cool-down — would permanently abandon a `needs-human` label refused
// during one exhausted minute, and the operator it exists to page would never be
// paged. The converger uses the WIDER `shouldCoolDownLabel` because its cool-down
// is time-boxed and self-healing; this marker is not. There is a test pinning the
// asymmetry.
//
// CTL-2043 (P2-a): labelOnce now ALSO arms that time-boxed cool-down — but it still
// does not import `shouldCoolDownLabel`. It composes the two NARROW predicates
// (`isThrottledLabelReason || isCloudReason`) instead, which is exactly
// `shouldCoolDownLabel` MINUS the terminal class. That is not a stylistic choice:
// the wide predicate INCLUDES terminal, and this file is the one place where the
// terminal class means "write the permanent marker". Keeping the sets textually
// distinct is what stops a future edit from routing a throttled reason into
// `.skipped` — the wiring-guard test asserts the import is absent.
const UNRECOVERABLE_LABEL_REASONS = TERMINAL_LABEL_REASONS;

// CTL-936: labelOnce now accepts an optional `appendEvent` seam. When provided
// AND CATALYST_INTENTS_ENFORCE=1, an unrecoverable label-write failure emits an
// operator-visible "intent.ineffective" event instead of silently writing
// .skipped and logging a warn. The .skipped marker is still written so the
// per-tick retry storm stays suppressed — the difference is operator visibility.
// Default null → legacy behavior (all existing callers unaffected).
//
// CTL-962: returns a boolean so callers can bound side-effects (an operator
// event, a counter) to the FIRST application only. Returns `false` when a
// terminal marker (.applied/.skipped) already exists → this call is a no-op;
// `true` when this call performed the write attempt (the once-application).
// Existing callers ignore the return value, so this is backward-compatible.
// CTL-2043 (P2-a): `now` is the injectable clock for the time-boxed cool-down.
// It DEFAULTS to Date.now — production supplies no seam, and a guard reading an
// undefined clock would compute NaN, compare false, and never bite: a check that
// cannot fail, which is the shape this repo keeps getting burned by.
export function labelOnce(
  orchDir,
  ticket,
  label,
  writeStatus,
  { appendEvent = null, env = process.env, onApplyResult = null, now = () => Date.now() } = {}
) {
  const base = labelMarkerBase(orchDir, ticket, label);
  if (existsSync(`${base}.applied`) || existsSync(`${base}.skipped`)) return false;
  // CTL-2043 (P2-a): a live cool-down is a no-op of the SAME shape as the
  // marker-guarded early return above — applyLabel is not called, so `onApplyResult`
  // correctly does not fire and `false` is returned. The caller
  // (labelNeedsHumanUnlessBeliefOwner) already gates its side effects on a CONFIRMED
  // apply, so it needs no change: a cooled-down tick is indistinguishable from the
  // already-handled "this call performed no once-application" case.
  if (orchDir && inLabelCooldown(orchDir, ticket, label, now())) return false;
  try {
    const res = writeStatus.applyLabel({ ticket, label });
    // A fake that returns undefined (test stubs) is treated as success so
    // the once-semantics stay testable without a real result.
    const applied = res === undefined || res?.applied === true;
    // CTL-764 finding C: surface the CONFIRMED apply outcome to callers that must
    // gate a side-effect (labelNeedsHumanUnlessBeliefOwner → the worker.transition
    // emission) on a real application, not merely on this being the first write
    // attempt. Only fires when applyLabel actually ran — never on a throw or on the
    // marker-guarded early return above.
    if (typeof onApplyResult === "function") {
      onApplyResult({ applied, reason: res?.reason ?? null });
    }
    if (applied) {
      writeFileSync(`${base}.applied`, "");
      // CTL-2043: a success resets the ledger. The stale marker would be harmless to
      // labelOnce itself (`.applied` early-returns forever after), but the SAME
      // (ticket, label) ledger carries the attempt counter the converger's CTL-2052
      // cap gate reads — leaving a spent count behind would bring that cap closer
      // for a label that just landed.
      if (orchDir) clearLabelCooldown(orchDir, ticket, label);
    } else if (UNRECOVERABLE_LABEL_REASONS.has(res?.reason)) {
      writeFileSync(`${base}.skipped`, "");
      const reason = res.reason;
      log.warn(
        { ticket, label, reason },
        "scheduler: label unrecoverable (missing / exclusive-conflict / team-mismatch) — skipping retries for this run"
      );
      // CTL-936: emit operator-visible event when enforce mode is on.
      if ((env.CATALYST_INTENTS_ENFORCE ?? "0") === "1" && typeof appendEvent === "function") {
        try {
          appendEvent({
            "event.name": "intent.ineffective",
            payload: {
              kind: "label",
              subject: ticket,
              attempts: 1,
              postcondition: { kind: "label", subject: ticket, label, present: true },
              reason,
            },
          });
        } catch (evtErr) {
          log.warn(
            { ticket, label, err: evtErr?.message },
            "ctl-936: labelOnce appendEvent threw — continuing"
          );
        }
      }
    } else if (orchDir && (isThrottledLabelReason(res?.reason) || isCloudReason(res?.reason))) {
      // CTL-2043 (P2-a): arm the TIME-BOXED cool-down. Deliberately NOT `.skipped`
      // (see the header) — a throttled/cloud refusal clears on its own, and a
      // permanent marker would outlive the fix. Terminal reasons took the branch
      // above and early-return on `.skipped` forever, so they never reach here: the
      // set armed here is exactly `shouldCoolDownLabel` MINUS terminal.
      //
      // The AC3 retry CAP is deliberately not applied here (converger-only, CTL-2052):
      // this path exists to page a human, and a cap that eventually stops re-issuing
      // could silently abandon that page. The 60 s window alone is what CTL-2043 asks
      // for; the ledger it writes is nonetheless the shared one, so the spend is
      // counted once per (ticket, label) across both callers.
      recordLabelCooldown(orchDir, ticket, label, now());
      log.warn(
        { ticket, label, reason: res.reason },
        "ctl-2043: label apply refused (throttled / cloud) — backing off for the cool-down window; NOT marked skipped, so it retries once the window elapses"
      );
    }
  } catch (err) {
    log.warn(
      { ticket, label, err: err.message },
      "scheduler: label write-back threw — continuing tick"
    );
  }
  // CTL-962: reached only when no terminal marker existed at entry, i.e. this
  // call performed the write attempt (the once-application for this lifetime).
  return true;
}

// ─── CTL-646: clearStalledLabel — inverse of labelOnce ───
//
// Removes the Linear label AND deletes the once-marker(s) so the apply guard
// re-arms. Both must happen together: deleting the marker without clearing the
// label would let the daemon believe the label is gone while Linear still shows
// it; clearing the label without deleting the marker would leave labelOnce
// permanently disarmed. Best-effort and never throws (mirrors labelOnce).
// The marker is deleted ONLY on a confirmed removal so a transient API failure
// is retried next tick.
//
// CTL-1078: accepts optional `now` seam (defaults to Date.now) for testability.
// After REMOVAL_ESCALATION_THRESHOLD consecutive failures, activates a back-off
// window (inRemovalBackoff) that short-circuits before calling removeLabel — the
// storm-break. Escalates once with a log.error on the threshold trip.
//
// CTL-1605: accepts optional `onSettled(confirmed)` — fired EXACTLY ONCE per call
// with the CONFIRMED removal outcome, on every exit path (backoff-skip, sync
// success/failure, async resolve, async reject, sync throw). Unlike `onRemoved`
// (which only fires on a confirmed removal, for marker/transition bookkeeping),
// `onSettled` always fires so a caller can aggregate "did this removal land"
// across several labels without inferring absence-of-call as failure — see
// resolveAndApplyWorkerStatusLabel's eviction gate below. Never throws.
export function clearStalledLabel(
  orchDir,
  ticket,
  label,
  writeStatus,
  { onRemoved = null, onSettled = null, now = () => Date.now() } = {}
) {
  const base = labelMarkerBase(orchDir, ticket, label);
  const settle = (confirmed) => {
    if (typeof onSettled === "function") {
      try {
        onSettled(confirmed);
      } catch (err) {
        log.warn(
          { ticket, label, err: err?.message },
          "clearStalledLabel: onSettled threw — continuing"
        );
      }
    }
  };
  // CTL-1078: guard at entry — if we're in backoff, skip the doomed removeLabel.
  if (inRemovalBackoff(orchDir, ticket, label, now())) {
    settle(false); // backoff-skip is NOT a confirmed removal
    return;
  }
  try {
    const res = writeStatus.removeLabel(ticket, label);
    const finalize = (r) => {
      // undefined (test stub) treated as success; otherwise require removed:true.
      if (r === undefined || r?.removed) {
        // Success: clear the failure counter.
        clearRemovalFailures(orchDir, ticket, label);
        // CTL-2098: only disarm the re-application markers when a real write
        // happened, or for the loose/undefined confirmed-removal shapes existing
        // callers/tests rely on. Two signals mean "this was a no-op, label was
        // ALREADY absent" (removed out-of-band by a steward or operator):
        //   - { wrote:false } — the DIRECT (non-proxy) path's shape.
        //   - { converged:true } — the enforce cloud-proxy path's ADDITIVE
        //     equivalent (Ryan's decision 2026-08-21, HIGH finding fix). Enforce
        //     hosts (production mini/mini-2) short-circuit before the direct-path
        //     read that produces wrote:false, so wrote:false is UNREACHABLE there
        //     — converged:true is the only signal that ever fires in production.
        //
        // ⛔ Codex round-1 P1: retention on EITHER signal must be scoped to the
        // STICKY `needs-human` label only. `clearStalledLabel` is also called
        // generically (scheduler.mjs:3054, convergeStartedHeldLabels) for the
        // tick-converged dispositions (queued/blocked/needs-input/waiting), which
        // are NOT apply-once-forever — they are supposed to complete their
        // retraction every time. Retaining THEIR markers on a converged/no-op
        // result would strand them in `budget:already-converged` refusals forever
        // instead of ever finishing. Only needs-human (labelOnce, apply-once) needs
        // the marker kept so it doesn't re-flap; every other label always disarms.
        if (r === undefined || label !== "needs-human" || (r?.wrote !== false && r?.converged !== true)) {
          for (const suffix of [".applied", ".skipped"]) {
            const p = `${base}${suffix}`;
            if (existsSync(p)) {
              try {
                unlinkSync(p);
              } catch {
                /* best-effort */
              }
            }
          }
        }
        // CTL-1045 Bug 4: run the caller's confirmed-removal hook ONLY when
        // removal is confirmed — e.g. the J3 once-marker write. A failed removal
        // must NOT disarm future genuine escalations via the once-marker.
        if (typeof onRemoved === "function") {
          try {
            onRemoved();
          } catch (err) {
            log.warn(
              { ticket, label, err: err?.message },
              "clearStalledLabel: onRemoved threw — continuing"
            );
          }
        }
        settle(true);
      } else if (r?.removed === false) {
        // CTL-1078: record failure and escalate once at threshold.
        const { count } = recordRemovalFailure(orchDir, ticket, label, r.reason, now());
        if (count === REMOVAL_ESCALATION_THRESHOLD) {
          log.error(
            { ticket, label, reason: r.reason, count },
            "clearStalledLabel: removal failed threshold times — entering back-off (CTL-1078)"
          );
        }
        settle(false);
      } else {
        settle(false);
      }
    };
    if (res && typeof res.then === "function") {
      res
        .then(finalize)
        .catch((err) => {
          log.warn(
            { ticket, label, err: err?.message },
            "clearStalledLabel: removeLabel rejected — continuing"
          );
          settle(false);
        });
    } else {
      finalize(res);
    }
  } catch (err) {
    log.warn({ ticket, label, err: err.message }, "clearStalledLabel: threw — continuing tick");
    settle(false);
  }
}

// ─── CTL-1078: per-(ticket, label) removal failure counter + backoff ───
//
// Mirrors the escalation-cooldown subsystem above but for the REMOVE path.
// Counts consecutive removeLabel failures per (ticket, label) and activates a
// back-off window (reusing ESCALATION_COOLDOWN_MS) after REMOVAL_ESCALATION_THRESHOLD
// consecutive failures. This breaks the per-tick retry storm without requiring
// the underlying auth issue to be resolved first.
//
// Marker lives under orchDir/.removal-failures/ (same rationale as
// .escalation-cooldowns/ — outside workers/<T>/ to avoid manufacturing worker dirs).
const REMOVAL_ESCALATION_THRESHOLD = Number(process.env.REMOVAL_ESCALATION_THRESHOLD) || 3;

function removalFailurePath(orchDir, ticket, label) {
  return join(orchDir, ".removal-failures", `${ticket}-${label}.json`);
}

export function recordRemovalFailure(orchDir, ticket, label, reason, now) {
  const p = removalFailurePath(orchDir, ticket, label);
  const dir = join(orchDir, ".removal-failures");
  let count = 1;
  let firstFailedAt = now;
  try {
    try {
      const existing = JSON.parse(readFileSync(p, "utf8"));
      count = (existing?.count ?? 0) + 1;
      firstFailedAt = existing?.firstFailedAt ?? now;
    } catch {
      // absent or malformed → start fresh
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ ticket, label, count, firstFailedAt, lastReason: reason, lastFailedAt: now })
    );
  } catch (err) {
    log.warn(
      { ticket, label, err: err.message },
      "label-guard: removal-failure marker write failed — continuing"
    );
    return { count };
  }
  return { count };
}

export function clearRemovalFailures(orchDir, ticket, label) {
  const p = removalFailurePath(orchDir, ticket, label);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch (err) {
    log.warn(
      { ticket, label, err: err.message },
      "label-guard: removal-failure marker delete failed — continuing"
    );
  }
}

export function inRemovalBackoff(orchDir, ticket, label, now) {
  const p = removalFailurePath(orchDir, ticket, label);
  let data;
  try {
    data = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return false;
  }
  if (typeof data?.count !== "number" || data.count < REMOVAL_ESCALATION_THRESHOLD) return false;
  const lastFailedAt = data?.lastFailedAt ?? data?.firstFailedAt;
  if (typeof lastFailedAt !== "number") return false;
  return now - lastFailedAt < ESCALATION_COOLDOWN_MS;
}

// ─── CTL-638: per-(ticket, phase) escalation cool-down ───
//
// The pre-CTL-638 recovery sweep called `appendEscalatedEvent` + `applyStalledLabel`
// on every tick the same (ticket, phase) was classified effectively-dead. Each
// `appendEscalatedEvent` append to events.jsonl re-triggered the scheduler's own
// `fs.watch` fast-path, debouncing to ~2s — a self-feeding 28/min storm that
// exhausted Linear's 2,500/hr quota in <1 hour.
//
// This cool-down throttles ONLY the recovery-sweep escalation call site
// (`reclaimDeadWorkIfPossible` branches A, C, and revive-budget-exhausted).
// Window = 10min by default — long enough to defeat the 2s debounce + 30s
// periodic tick storm; short enough that a phase that ACTUALLY stalls
// re-escalates once an operator clears the prior incident.
//
// Mirrors the CTL-624 dispatch cool-down primitive shape (file under
// orchDir/.escalation-cooldowns/, JSON envelope with a numeric timestamp).
// The marker deliberately lives OUTSIDE workers/<T>/ to avoid manufacturing
// a worker dir for a ticket that has none — see scheduler.mjs comment block
// at dispatchCooldownPath and memory project_scheduler_marker_under_workers_excludes_ticket.
export const ESCALATION_COOLDOWN_MS =
  Number(process.env.RECOVERY_ESCALATION_COOLDOWN_MS) || 10 * 60 * 1000;

// CTL-1442: consecutive same-reason asks before an escalation goes TERMINAL.
// The 10-min cooldown above only THROTTLES re-emission — with no cap, a
// no-progress ticket asks "authorize retry?" every window forever (ADV-1374/
// ADV-1376 fired for days; audit RC4) because nothing consumes the ask and
// nothing ever transitions the ticket. After this many asks the escalation
// site parks the ticket terminally instead of asking again.
export const ESCALATION_ASK_CAP = Number(process.env.CATALYST_ESCALATION_ASK_CAP) || 3;

// LABEL_CONFIRM_CAP — maximum transient label-write attempts before escalation.label-unconfirmed
// fires and the cooldown is written unconditionally. Bounds the label-retry storm so a persistent
// Linear outage eventually produces a loud operator-visible alert instead of silent per-tick retries.
export const LABEL_CONFIRM_CAP = Number(process.env.CATALYST_LABEL_CONFIRM_CAP) || 5;

export function escalationCooldownPath(orchDir, ticket, phase) {
  return join(orchDir, ".escalation-cooldowns", `${ticket}-${phase}.json`);
}

// readEscalationRecord — CTL-1442: the full cool-down marker (reason, askCount,
// asks[] history), for the ask-cap gate + truthful `attempts` event payloads.
// Absent/malformed → null (fail-open — the cap only ever under-counts).
export function readEscalationRecord(orchDir, ticket, phase) {
  try {
    const data = JSON.parse(readFileSync(escalationCooldownPath(orchDir, ticket, phase), "utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

export function inEscalationCooldown(orchDir, ticket, phase, now) {
  const p = escalationCooldownPath(orchDir, ticket, phase);
  let escalatedAt;
  try {
    escalatedAt = JSON.parse(readFileSync(p, "utf8"))?.escalatedAt;
  } catch {
    return false; // absent / malformed → treat as no cool-down
  }
  if (typeof escalatedAt !== "number") return false;
  return now - escalatedAt < ESCALATION_COOLDOWN_MS;
}

// ─── CTL-1609: explanation signal writer ─────────────────────────────────────
//
// Writes a board-readable `phase-recovery-pass.json` carrying `.explanation` so
// the operator inbox renders a "What's needed now" card instead of a bare
// "escalated — needs human". Shape mirrors writeEscalationSignal in
// recovery-reasoning.mjs (the proven write pattern). Colocated here (not
// imported from recovery-reasoning) to avoid pulling scheduler-adjacent
// internals into this leaf module.
//
// No-overwrite guard: if the existing signal already carries a non-degraded
// `.explanation` (e.g., from escalateExhaustedIntents's prior writeSignal call
// on the `attempts-exhausted` site), the coerced thin explanation must NOT
// clobber it. `degraded:true` means the earlier writer also fell back → the
// new coerce may be equivalent or richer, so we overwrite; absent `degraded`
// (a proper typed-union object) means a human-readable curated signal → keep.
// The recovery-pass statuses that mean a worker is in flight and owns
// phase-recovery-pass.json. Must stay in sync with delegate-queue.mjs's
// recoveryPassWorkerLive (the enqueue-time dedup probe) — those are the reads
// that go blind if this file's status is overwritten.
// CTL-1854: awaiting-work included — its own comment above requires staying in sync
// with delegate-queue.mjs's recoveryPassWorkerLive, and a yielded worker still owns
// the file this guard protects from being overwritten.
const LIVE_RECOVERY_PASS_STATUSES = new Set(["dispatched", "running", YIELDED_STATUS]);

// readRecoveryPassSignal — the on-disk half of the classifier's reason fallback.
// Same path writeExplanationSignal writes. Fail-open: an absent or malformed file
// is `null`, never a throw, and never blocks the escalation path.
function readRecoveryPassSignal(orchDir, ticket) {
  if (!orchDir || !ticket) return null;
  try {
    const p = join(orchDir, "workers", ticket, "phase-recovery-pass.json");
    const sig = JSON.parse(readFileSync(p, "utf8"));
    return sig && typeof sig === "object" ? sig : null;
  } catch {
    return null;
  }
}

function writeExplanationSignal(
  orchDir,
  ticket,
  explanation,
  { log: logArg = null, extraFields = {}, freshStatus = TERMINAL_STALL_STATUS } = {}
) {
  // CTL-2159: the signal is now worth writing even with NO explanation — the
  // stall CLASS is the durable record, and manufacturing an explanation to have
  // something to write is exactly the defect this epic deletes.
  if (!orchDir || !ticket) return;
  if (!explanation && Object.keys(extraFields).length === 0) return;
  try {
    const p = join(orchDir, "workers", ticket, "phase-recovery-pass.json");
    let prior = {};
    try {
      prior = JSON.parse(readFileSync(p, "utf8")) ?? {};
    } catch {
      prior = {};
    }
    // LIVE-WORKER guard (CTL-1609, Codex P1). `phase-recovery-pass.json` is not
    // only an explanation carrier — it is the recovery-pass worker's own status
    // record, and `dispatched`/`running` is exactly what the liveness probes read
    // (delegate-queue's recoveryPassWorkerLive, the SDK occupancy accounting).
    // Stamping `status:"needs-human"` over a live worker makes that worker
    // invisible: it stops deduping a re-enqueue (double-dispatch) and drops out of
    // capacity accounting. A ticket can legitimately be in both states at once —
    // a sibling phase failed while its recovery-pass worker is still running — so
    // this is reachable in normal operation, not a corner case.
    //
    // Preserve the live record verbatim rather than merging: the worker itself
    // writes this file, so a concurrent partial update from here could interleave.
    // The label still applies (this function is called AFTER the confirmed label
    // write); only the signal-file mutation is skipped.
    if (LIVE_RECOVERY_PASS_STATUSES.has(prior.status)) {
      try {
        (logArg ?? log).warn(
          { ticket, priorStatus: prior.status },
          "label-guard: live recovery-pass worker — preserving its signal, explanation not written"
        );
      } catch {
        /* logging must never block the label path */
      }
      return;
    }
    // No-overwrite guard for the `attempts-exhausted` site (and any future site
    // that pre-writes a rich curated explanation before the label apply).
    // CTL-2159: scoped to the case that can actually clobber — a class-only
    // stamp carries no explanation, so it must not be dropped just because a
    // curated one is already on disk.
    //
    // ⛔ CTL-2159 (verification finding): this used to be an UNCONDITIONAL early
    // return, which silently swallowed the stall-CLASS stamp too. A caller that
    // passes a real explanation onto a ticket that already has a curated one
    // (recovery.mjs's applyStalledLabel, the `attempts-exhausted` sweep) got no
    // `stallClass` on disk at all — so the durable S/A/M/HELD record, the one
    // thing this epic replaces the label with, was missing at exactly the sites
    // that escalate most. Now the CURATED PROSE is still protected (it is simply
    // not overwritten below), while a stamp carrying anything new still lands.
    const priorExplanationWins = Boolean(
      explanation && prior.explanation && prior.explanation.degraded !== true
    );
    const stampHasNews = Object.entries(extraFields ?? {}).some(
      ([k, v]) => prior[k] !== v
    );
    if (priorExplanationWins && !stampHasNews) return;
    const nowIso = new Date().toISOString();
    const signal = {
      ...prior,
      ticket,
      // ⛔ CTL-2159: was an unconditional terminal status. It is now THREE things,
      // and the third is the one a reader will be tempted to "simplify" away:
      //   1. a PRIOR status is PRESERVED rather than clobbered. The old write only
      //      ran when the Linear label landed, so the clobber was rare and
      //      invisible; publishing no longer depends on a Linear call, so an
      //      unconditional overwrite would newly rewrite `failed` (and the
      //      yield-expiry sweep's `failureReason` record) on every escalation.
      //      The escalation's durable contribution is the CLASS, not a status edit.
      //   2. the fresh-signal value is a spelling every reader already handles.
      //   3. ⛔ WHICH spelling DERIVES FROM THE STALL CLASS (freshStallStatus).
      //      A hardcoded `stalled` here is TERMINAL to isTicketInFlight, so the
      //      escalation that fires at DISPATCH_FAILURE_ESCALATION_THRESHOLD (3)
      //      silently truncated every retry loop behind it — the circuit breaker's
      //      8 and getMaxDispatchRetries's 5 both became 3, with nothing in the log
      //      to say so (CTL-671's own test caught it). A SYSTEM stall is
      //      retry-with-backoff BY DEFINITION; only ASK/MOOT/HELD stop the work.
      //      See stall-class.mjs for why the two statuses cannot be one value.
      status:
        typeof prior.status === "string" && prior.status !== "" ? prior.status : freshStatus,
      ...(prior.stalledReason ? {} : { stalledReason: "escalated" }),
      ...extraFields,
      needsHumanSince:
        typeof prior.needsHumanSince === "string" && prior.needsHumanSince !== ""
          ? prior.needsHumanSince
          : nowIso,
      updatedAt: nowIso,
      phase: "recovery-pass",
      // Curated prose on disk beats a caller's thin one — that is the whole point
      // of the guard above; only the stamp gets through.
      ...(explanation && !priorExplanationWins ? { explanation } : {}),
    };
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(signal, null, 2));
    renameSync(tmp, p);
  } catch (err) {
    try {
      const logger = logArg ?? log;
      logger.warn(
        { ticket, err: err?.message },
        "label-guard: explanation signal write failed — continuing"
      );
    } catch {
      /* logging must never block the label path */
    }
  }
}

// ─── CTL-1241: belief-ownership deferral guard ────────────────────────────────
//
// When CATALYST_INTENTS_ENFORCE=1, the belief engine's executeEscalations
// (beliefs/escalate.mjs) is the SINGLE owner of the needs-human label. The six
// non-belief producers are gated through labelNeedsHumanUnlessBeliefOwner so
// they defer to the belief owner instead of writing directly. With enforcement
// OFF (the default), behavior is byte-for-byte unchanged.
//
// Enforcement flag: CATALYST_INTENTS_ENFORCE=1 (Layer-2 config / launchd env).
// Flipping the flag is an operational rollout step (see CTL-1241 plan §Rollout)
// — NOT a code default change. All code here is behavior-neutral while the flag
// is OFF, matching the belief-engine shadow discipline (CTL-933, ADR-023).

// beliefOwnsNeedsHuman — returns true when enforcement is ON and the belief
// engine is the single owner of the needs-human label. Single source of truth
// for the deferral predicate.
export function beliefOwnsNeedsHuman(env = process.env) {
  return (env ?? process.env).CATALYST_INTENTS_ENFORCE === "1";
}

// labelNeedsHumanUnlessBeliefOwner — the shared gate used by every non-belief
// needs-human producer. Either defers to executeEscalations (enforcement ON) or
// calls labelOnce exactly as before (enforcement OFF / default).
//
// Parameters match labelOnce's calling convention at each producer site:
//   orchDir     — path to the orchestrator directory
//   ticket      — ticket identifier
//   writeStatus — { applyLabel } as passed to labelOnce
//   opts        — {
//     env         : Record<string,string>  (process.env in production)
//     site        : string                 (short site-id for the deferral log)
//     log         : { info, warn }        (the module's log instance)
//     explanation : object | undefined    (CTL-1609 Gap 2 — structured escalation
//                   explanation; coerced via coerceExplanation if partial/absent)
//     onOutcome   : ({deferred,applied,ran,reason}) => void  (optional, CTL-1641)
//   }
//
// CTL-764 finding 8 + finding C: returns whether the needs-human label was CONFIRMED
// applied on THIS call — `false` when it deferred to the belief owner, when labelOnce
// found a terminal marker (a persisted needs-human after a daemon restart), OR when the
// apply was attempted but did not land (rate-limited / exclusive-conflict / missing-label);
// `true` ONLY when applyLabel reported applied:true. Callers gate their worker.transition
// emission on this so neither a no-op re-application nor a failed attempt records a fresh
// escalation. Existing callers ignore the return, so this stays backward-compatible.
//
// CTL-1641 (Codex #3005 P2): the boolean return CONFLATES three `false` cases —
// belief-owner deferral, a marker-guarded no-op (label already handled this lifetime),
// and a GENUINE non-confirming write (applyLabel ran but returned applied:false). A
// caller that must count a failed escalation (unstuck-escalate-seam) cannot tell them
// apart from the boolean alone. The optional `onOutcome` callback reports the richer
// signal WITHOUT changing the return type: `deferred` (belief owner), `ran` (applyLabel
// actually executed — false on a marker no-op), `applied`, and `reason`. A genuine
// failure is exactly `!deferred && ran && !applied`.
export function labelNeedsHumanUnlessBeliefOwner(
  orchDir,
  ticket,
  writeStatus,
  {
    env = process.env,
    site = "unknown",
    log: logArg = null,
    explanation = undefined,
    // CTL-2159: the stall reason token, handed to the classifier. ⛔ LOAD-BEARING:
    // with no reason the classifier correctly returns HELD ("I could not look" is
    // not "nothing is wrong"), so a caller that knows its reason and does not pass
    // it silently turns every SYSTEM stall into a held one and the retry/alert path
    // never fires. Every producer that has a reason MUST forward it — the six
    // routeStuckTicketToDelegate sites do so through delegate-first's labelDirect.
    reason = null,
    // CTL-2159 (verification finding): the phase signal, when the caller holds
    // one. classifyStall falls back `reason ?? signal.stalledReason ?? signal
    // .failureReason` — but this call site never passed `signal`, so that whole
    // fallback was DEAD on the only path any producer uses and a caller that
    // omitted `reason` had no second chance. When neither is supplied we now read
    // the on-disk signal ourselves (see resolveReasonFallback) rather than
    // classifying HELD on an absence we could have looked up.
    signal = null,
    onOutcome = null,
    // CTL-2056: injectable emit seam so tests can record escalation events
    // without real I/O. Defaults to the real emitter (fail-open, never throws).
    emitEscalation = emitEscalationEvent,
    // CTL-1568 (Codex #2861 P1): treat a pre-existing `.applied` marker as LANDED.
    //
    // labelOnce early-returns false for BOTH `.applied` and `.skipped`, conflating
    // "the label is already on the ticket" with "the label is not on the ticket".
    // The CTL-764 worker.transition callers need "confirmed on THIS call" and must
    // keep the strict meaning, so this is opt-in: only the CTL-1568 sites that gate
    // a HUMAN-FACING side effect on the label being PRESENT pass it. Without it, a
    // ticket already parked needs-human by any other producer (scheduler, monitor,
    // stale-pr-rescue) has its later recovery escalation permanently suppressed —
    // comment withheld, deferral counter burned — even though the label is right
    // there on the ticket. `.skipped` still counts as failure either way.
    treatAlreadyAppliedAsLanded = false,
  } = {}
) {
  if (beliefOwnsNeedsHuman(env)) {
    // Defer to executeEscalations — R12 belief owner. Record, do not page.
    const logger = logArg ?? log;
    logger.info({ ticket, site }, "needs-human deferred to belief owner (CTL-1241)");
    if (typeof onOutcome === "function") {
      onOutcome({ deferred: true, applied: false, ran: false, reason: null });
    }
    return false;
  }
  // ⛔ CTL-2159 — THIS NO LONGER WRITES A LINEAR LABEL.
  //
  // It used to call `labelOnce(orchDir, ticket, "needs-human", …)`, which is the
  // single chokepoint every non-belief producer reaches. Deleting the label
  // therefore means deleting it HERE and nowhere else — which is why the six
  // producers that route through `routeStuckTicketToDelegate` (invisible to any
  // grep for `labelOnce(`) are covered too, including scheduler.mjs:9294, the
  // volume producer.
  //
  // What replaces it is `publishEscalation`: the CTL-2158 classifier decides
  // whether this stall is SYSTEM (retry, zero per-ticket artifacts, the CTL-2156
  // fleet alert covers it), ASK (ONE ask ticket carrying `blocks`, CTL-2157),
  // MOOT (close) or HELD (visible, un-dispositioned). The RETURN CONTRACT is
  // deliberately unchanged — "a disposition was published on THIS call" — because
  // five retry loops read it as their STOP condition (see escalation-publish.mjs
  // header note 1). Every existing caller keeps compiling and keeps its retry.
  //
  // ⛔ AND NOTHING IS COERCED HERE ANY MORE. The old line was
  // `coerceExplanation(explanation ?? {}, { ticket, canExecute: false })` with
  // canExecute HARDCODED false, so an unexplained worker death degraded to a
  // fabricated "priority call the agent cannot make unilaterally" card. That
  // template is what turned one provider outage into 37 separate human decisions.
  // ⛔ THE NO-REASON CLIFF, MADE LOUD. `classifyStall` returns HELD with
  // rule:"no-reason" when it is handed nothing — correct, because "I could not
  // look" is not "nothing is wrong". But a producer that KNOWS its reason and
  // forgets to forward it gets that same silent HELD, and the SYSTEM retry/alert
  // path never fires. Three verification lenses independently found five such
  // sites in this repo. So: recover the reason from the signal (given, or read
  // off disk), and if there is genuinely none, WARN — a site that classifies
  // HELD for want of a token should be visible in the log, not inferred weeks
  // later from an absent alert.
  const resolvedSignal = signal ?? readRecoveryPassSignal(orchDir, ticket);
  const resolvedReason =
    reason ?? resolvedSignal?.stalledReason ?? resolvedSignal?.failureReason ?? null;
  if (resolvedReason == null) {
    try {
      (logArg ?? log).warn(
        { ticket, site },
        "escalation: no stall reason available — classifying HELD (CTL-2159)"
      );
    } catch {
      /* logging must never block the escalation path */
    }
  }
  const published = publishEscalation(orchDir, ticket, {
    env,
    site,
    reason: resolvedReason,
    signal: resolvedSignal,
    log: logArg,
    explanation: explanation ?? null,
    markerBase: labelMarkerBase(orchDir, ticket, "needs-human"),
    emitEscalation,
    onOutcome,
    treatAlreadyPublishedAsLanded: treatAlreadyAppliedAsLanded,
    // The explanation card is written ONLY when the caller supplied a real one;
    // the stall CLASS is stamped either way, so an unexplained SYSTEM stall
    // leaves a durable record without manufacturing a human question.
    writeSignal: ({ fields, klass }) =>
      writeExplanationSignal(orchDir, ticket, explanation ?? null, {
        log: logArg,
        extraFields: fields,
        // ⛔ The CLASS picks the status. publishEscalation hands us the verdict it
        // just reached; deriving here (rather than at the classifier) keeps
        // stall-class.mjs pure and keeps the choice next to the write it governs.
        freshStatus: freshStallStatus(klass),
      }),
  });
  return published;
}

// ─── CTL-1605: the worker-status label group (Axis 2) — single source of truth. ───
// Membership DERIVES from worker-disposition.mjs's canonical DISPOSITIONS (its
// header contract: "Import constants and functions from this module; never
// instantiate them elsewhere"), plus the legacy "waiting" so a terminal ticket
// still wearing it is drained too. worker-disposition.mjs is a pure leaf, so
// this import creates no cycle.
export const WORKER_STATUS_LABELS = Object.freeze([...DISPOSITIONS, "waiting"]);

// resolveAndApplyWorkerStatusLabel — the ONE terminal-aware chokepoint every
// worker-status apply site routes through (CTL-1605). It reads live Linear Status
// via the injected `isTerminal` probe (isTicketTerminalOrMerged in production —
// fail-safe NOT-terminal, never throws). If the ticket is terminal it removes every
// worker-status label present on the ticket and calls the injected `evictWorkerDir`
// seam (guarded, live-session-safe — Phase 3), then returns { terminal:true } WITHOUT
// applying `desired`. Otherwise it invokes the caller's existing `applyDesired`
// closure (labelOnce / convergeHeldLabel / clearStalledLabel) unchanged and returns
// { terminal:false }. All effects are seams → pure/leaf, fully unit-testable.
//
// `needs-human` is cleared through clearStalledLabel (re-arms markers + CTL-1078
// backoff); the held labels through writeStatus.removeLabel. `onTerminalCleared(arg)`
// fires EXACTLY ONCE per call — after every present label's removal has settled,
// the same aggregation point that gates eviction (CTL-1605 Codex thread,
// scheduler.mjs:5518) — not once per label. A per-label firing let a single
// confirmed removal on a multi-label ticket (e.g. "blocked") report a clear even
// when a sibling label (e.g. the sticky "needs-human") was backoff-skipped or
// failed to confirm, falsely telling the caller the ticket's disposition was
// clear while a worker-status label was still live on Linear. `arg` is `null`
// when every present label confirmed removed, or the highest-precedence
// surviving label (DISPOSITIONS order; legacy "waiting" ranks last, since it
// carries no precedence of its own) otherwise.
export function resolveAndApplyWorkerStatusLabel(
  orchDir,
  ticket,
  {
    desired = null,
    currentLabels = [],
    isTerminal,
    writeStatus,
    evictWorkerDir = null,
    applyDesired = null,
    onTerminalCleared = null,
    now = () => Date.now(),
  } = {}
) {
  // `desired` is a caller intent marker (which label WOULD be applied on the
  // non-terminal path); the apply itself is owned by the caller's applyDesired
  // closure, so we only read it for clarity — it is intentionally not used here.
  void desired;
  let verdict = { terminal: false };
  try {
    if (typeof isTerminal === "function") verdict = isTerminal(ticket) ?? { terminal: false };
  } catch (err) {
    // Fail-safe NOT-terminal — a throw must never manufacture a terminal verdict
    // (mirrors isTicketTerminalOrMerged). Caller proceeds with its normal apply.
    log.warn(
      { ticket, err: err?.message },
      "resolveAndApplyWorkerStatusLabel: isTerminal threw — treating NOT-terminal"
    );
    verdict = { terminal: false };
  }

  if (!verdict?.terminal) {
    if (typeof applyDesired === "function") applyDesired();
    return { terminal: false };
  }

  // Terminal: refuse the write. Clear every worker-status label present, then evict
  // — but ONLY once every present label's removal is CONFIRMED (CTL-1605 finding:
  // evicting on the mere ISSUING of async removals destroys the only retry record,
  // since STEP A / J3 / J4 all key their candidate sets off workers/<T>/ existing on
  // disk). Each present label contributes a {settled, confirmed} outcome, tracked
  // synchronously when the underlying write resolves synchronously (the common sync
  // test-stub / already-settled-promise-free case) and asynchronously otherwise.
  const present = new Set(currentLabels ?? []);
  const outcomes = []; // [{ label, settled: boolean, confirmed: boolean, promise: Promise<boolean> }]
  const evictOnce = () => {
    if (typeof evictWorkerDir !== "function") return false;
    try {
      return evictWorkerDir(ticket) === true;
    } catch (err) {
      log.warn(
        { ticket, err: err?.message },
        "resolveAndApplyWorkerStatusLabel: evict threw — continuing"
      );
      return false;
    }
  };
  // rankOf / fireTerminalCleared — the single aggregation point for
  // onTerminalCleared (see the header comment above). Only called once every
  // present label's outcome has settled, and only when at least one label was
  // present (mirrors the old per-label loop's zero-iteration no-op on a clean
  // terminal ticket — nothing to report, nothing fires).
  const rankOf = (label) => {
    const idx = DISPOSITIONS.indexOf(label);
    return idx === -1 ? DISPOSITIONS.length : idx; // legacy "waiting" ranks last
  };
  const fireTerminalCleared = () => {
    if (outcomes.length === 0) return;
    if (typeof onTerminalCleared !== "function") return;
    const survivors = outcomes.filter((o) => !o.confirmed).map((o) => o.label);
    const arg =
      survivors.length === 0
        ? null
        : survivors.reduce((best, label) => (rankOf(label) < rankOf(best) ? label : best));
    onTerminalCleared(arg);
  };
  for (const label of WORKER_STATUS_LABELS) {
    if (!present.has(label)) continue; // steady-state zero-write on a clean terminal ticket
    const outcome = { label, settled: false, confirmed: false, promise: null };
    outcomes.push(outcome);
    let resolveOutcome;
    outcome.promise = new Promise((resolve) => {
      resolveOutcome = resolve;
    });
    const settle = (confirmed) => {
      outcome.settled = true;
      outcome.confirmed = confirmed;
      resolveOutcome(confirmed);
    };
    if (label === "needs-human") {
      clearStalledLabel(orchDir, ticket, label, writeStatus, { onSettled: settle, now });
    } else {
      try {
        const res = writeStatus?.removeLabel?.(ticket, label);
        // undefined (sync test stub) → success; else require removed !== false.
        const finalize = (r) => {
          const confirmed = r == null || r?.removed !== false;
          settle(confirmed);
        };
        if (res && typeof res.then === "function") {
          res
            .then(finalize)
            .catch((err) => {
              log.warn(
                { ticket, label, err: err?.message },
                "resolveAndApplyWorkerStatusLabel: removeLabel rejected — continuing"
              );
              settle(false);
            });
        } else {
          finalize(res);
        }
      } catch (err) {
        log.warn(
          { ticket, label, err: err?.message },
          "resolveAndApplyWorkerStatusLabel: removeLabel threw — continuing"
        );
        settle(false);
      }
    }
  }

  // Every outcome settled synchronously (the sync test-stub / no-present-labels
  // case) → evict (or not) and fire the aggregate callback in THIS tick,
  // preserving the prior synchronous contract. Any outcome still pending (a
  // real async removeLabel) → defer BOTH to the aggregated resolution; the
  // worker dir stays put — and thus retryable by STEP A / J3 / J4 — until every
  // present label has settled.
  const allSettled = outcomes.every((o) => o.settled);
  let evicted = false;
  if (allSettled) {
    if (outcomes.every((o) => o.confirmed)) evicted = evictOnce();
    fireTerminalCleared();
  } else {
    Promise.all(outcomes.map((o) => o.promise)).then((results) => {
      if (results.every(Boolean)) evictOnce();
      fireTerminalCleared();
    });
  }
  return {
    terminal: true,
    reason: verdict.reason ?? "linear-terminal",
    state: verdict.state ?? null,
    evicted,
  };
}

export function recordEscalation(orchDir, ticket, phase, reason, now) {
  const dir = join(orchDir, ".escalation-cooldowns");
  try {
    mkdirSync(dir, { recursive: true });
    // CTL-1442: accrue the consecutive same-reason ask count (+ a bounded ask
    // history for truthful event payloads). A DIFFERENT reason restarts the
    // count — it is a new question to the operator, not a repeat of the last.
    const prior = readEscalationRecord(orchDir, ticket, phase);
    const sameReason = prior?.reason === reason;
    const askCount = sameReason && typeof prior?.askCount === "number" ? prior.askCount + 1 : 1;
    const asks = [...(sameReason && Array.isArray(prior?.asks) ? prior.asks : []).slice(-9), now];
    writeFileSync(
      escalationCooldownPath(orchDir, ticket, phase),
      JSON.stringify({ ticket, phase, reason, escalatedAt: now, askCount, asks })
    );
  } catch (err) {
    // Never let a marker write crash the tick — worst case is the next tick
    // re-escalates (the pre-CTL-638 behavior we're throttling).
    log.warn(
      { ticket, phase, err: err.message },
      "recovery: escalation cool-down marker write failed — continuing"
    );
  }
}
