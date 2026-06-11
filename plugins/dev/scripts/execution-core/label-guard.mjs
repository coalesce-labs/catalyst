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
function labelMarkerBase(orchDir, ticket, label) {
  return join(orchDir, "workers", ticket, `.linear-label-${label}`);
}

// UNRECOVERABLE_LABEL_REASONS — applyLabel reasons that can never land this
// daemon lifetime (CTL-834); labelOnce writes its .skipped marker for these to
// stop the per-tick retry storm. "missing-label": the workspace lacks the label;
// "exclusive-conflict": the label's exclusive-group sibling is already present.
const UNRECOVERABLE_LABEL_REASONS = new Set(["missing-label", "exclusive-conflict"]);

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
export function labelOnce(orchDir, ticket, label, writeStatus, { appendEvent = null, env = process.env } = {}) {
  const base = labelMarkerBase(orchDir, ticket, label);
  if (existsSync(`${base}.applied`) || existsSync(`${base}.skipped`)) return false;
  try {
    const res = writeStatus.applyLabel({ ticket, label });
    // A fake that returns undefined (test stubs) is treated as success so
    // the once-semantics stay testable without a real result.
    if (res === undefined || res?.applied) {
      writeFileSync(`${base}.applied`, "");
    } else if (UNRECOVERABLE_LABEL_REASONS.has(res?.reason)) {
      writeFileSync(`${base}.skipped`, "");
      const reason = res.reason;
      log.warn(
        { ticket, label, reason },
        "scheduler: label unrecoverable (missing / exclusive-conflict) — skipping retries for this run"
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
export function clearStalledLabel(orchDir, ticket, label, writeStatus) {
  const base = labelMarkerBase(orchDir, ticket, label);
  try {
    const res = writeStatus.removeLabel(ticket, label);
    const finalize = (r) => {
      // undefined (test stub) treated as success; otherwise require removed:true.
      if (r === undefined || r?.removed) {
        for (const suffix of [".applied", ".skipped"]) {
          const p = `${base}${suffix}`;
          if (existsSync(p)) { try { unlinkSync(p); } catch { /* best-effort */ } }
        }
      }
    };
    if (res && typeof res.then === "function") {
      res.then(finalize).catch((err) =>
        log.warn({ ticket, label, err: err?.message }, "clearStalledLabel: removeLabel rejected — continuing"));
    } else {
      finalize(res);
    }
  } catch (err) {
    log.warn({ ticket, label, err: err.message }, "clearStalledLabel: threw — continuing tick");
  }
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

export function escalationCooldownPath(orchDir, ticket, phase) {
  return join(orchDir, ".escalation-cooldowns", `${ticket}-${phase}.json`);
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

export function recordEscalation(orchDir, ticket, phase, reason, now) {
  const dir = join(orchDir, ".escalation-cooldowns");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      escalationCooldownPath(orchDir, ticket, phase),
      JSON.stringify({ ticket, phase, reason, escalatedAt: now })
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
