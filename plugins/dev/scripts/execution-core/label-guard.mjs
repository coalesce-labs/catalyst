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

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./config.mjs";
import { DISPOSITIONS } from "./worker-disposition.mjs";

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
// Transient failures (reason:"rate-limited", "transient", undefined) write no
// marker so the next tick retries — CTL-558's recovery contract. CTL-638 pairs
// this with the escalation cool-down below to break the per-tick storm even
// when the transient-failure path keeps re-attempting the write.
// labelMarkerBase — shared path prefix for the once-marker files used by
// labelOnce and clearStalledLabel (single source of truth for the marker path).
export function labelMarkerBase(orchDir, ticket, label) {
  return join(orchDir, "workers", ticket, `.linear-label-${label}`);
}

// UNRECOVERABLE_LABEL_REASONS — applyLabel reasons that can never land this
// daemon lifetime (CTL-834); labelOnce writes its .skipped marker for these to
// stop the per-tick retry storm. "missing-label": the workspace lacks the label;
// "exclusive-conflict": the label's exclusive-group sibling is already present;
// "team-mismatch": name resolution used the wrong team's UUID context (CTL-1085).
const UNRECOVERABLE_LABEL_REASONS = new Set([
  "missing-label",
  "exclusive-conflict",
  "team-mismatch",
]);

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
export function labelOnce(
  orchDir,
  ticket,
  label,
  writeStatus,
  { appendEvent = null, env = process.env, onApplyResult = null } = {}
) {
  const base = labelMarkerBase(orchDir, ticket, label);
  if (existsSync(`${base}.applied`) || existsSync(`${base}.skipped`)) return false;
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
        // Success: clear the failure counter and delete the once-markers.
        clearRemovalFailures(orchDir, ticket, label);
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
//     env   : Record<string,string>  (process.env in production)
//     site  : string                 (short site-id for the deferral log)
//     log   : { info }              (the module's log instance)
//   }
//
// CTL-764 finding 8 + finding C: returns whether the needs-human label was CONFIRMED
// applied on THIS call — `false` when it deferred to the belief owner, when labelOnce
// found a terminal marker (a persisted needs-human after a daemon restart), OR when the
// apply was attempted but did not land (rate-limited / exclusive-conflict / missing-label);
// `true` ONLY when applyLabel reported applied:true. Callers gate their worker.transition
// emission on this so neither a no-op re-application nor a failed attempt records a fresh
// escalation. Existing callers ignore the return, so this stays backward-compatible.
export function labelNeedsHumanUnlessBeliefOwner(
  orchDir,
  ticket,
  writeStatus,
  { env = process.env, site = "unknown", log: logArg = null } = {}
) {
  if (beliefOwnsNeedsHuman(env)) {
    // Defer to executeEscalations — R12 belief owner. Record, do not page.
    const logger = logArg ?? log;
    logger.info({ ticket, site }, "needs-human deferred to belief owner (CTL-1241)");
    return false;
  }
  // Enforcement OFF (default): call labelOnce exactly as before. CTL-764 finding C:
  // return whether the label was CONFIRMED applied, not merely attempted — labelOnce's
  // boolean is true for any first write attempt (including outcomes where the label never
  // landed). Capture applyLabel's applied result via onApplyResult; a marker-guarded no-op
  // (labelOnce early-returns, onApplyResult never fires) correctly stays false.
  let applied = false;
  labelOnce(orchDir, ticket, "needs-human", writeStatus, {
    onApplyResult: (r) => {
      applied = r.applied === true;
    },
  });
  return applied;
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
