// beliefs/escalate.mjs — CTL-962: the single owner of the escalate_human action.
//
// ── Why this module exists ────────────────────────────────────────────────────
// The escalation ladder derives, per tick, in the belief store:
//   R4  wedged_never_started   (a registered worker old enough with no turn)
//   R10 wake_diagnostician     (wake the stall diagnostician)
//   R11 action_ineffective     (the wake intent hit the cap, outcome still NULL)
//   R12 escalate_human         (R10 + R11 co-occur → page a human)
// R12 is a CONCLUSION with a provenance chain, not a label write buried in a
// branch. This module is the executor that ACTS on that conclusion exactly once.
//
// Before CTL-962, two places could page: the diagnostician's second-line branch
// (applyNeedsHuman) and — implicitly — the reconciler's outcome flip. That split
// risked double-paging and made "who owns needs-human?" ambiguous. CTL-962 makes
// escalate.mjs the SINGLE label owner:
//   • the reconciler (intent.mjs) only caps the channel and leaves outcome NULL;
//   • the diagnostician (diagnostician.mjs) only SUPPLIES EVIDENCE, applies no
//     label;
//   • escalate.mjs reads R12's escalate_human beliefs and pages once, gated by
//     labelOnce's per-(ticket,label) idempotency marker.
//
// ── Bounding escalation to exactly once ───────────────────────────────────────
// labelOnce is idempotent per (ticket, label) per daemon lifetime via marker
// files, so the needs-human label is applied at most once even if R12 keeps
// firing. To stop R11/R12 from re-deriving every tick (and re-driving this
// executor), we also flip the wake-diagnostician intent(s) for the subject to
// outcome='escalated'. That makes R11's `outcome IS NULL AND attempts >= max`
// predicate FALSE, so R11 — and therefore R12 — stop firing next tick. The flip
// is what bounds escalation to exactly once.
//
// ── Gating ────────────────────────────────────────────────────────────────────
// CATALYST_INTENTS_ENFORCE controls whether we ACT:
//   enforce=false (SHADOW) — record-only: do NOT apply the label, do NOT flip
//     the intent, do NOT emit. The belief rows still exist (the audit trail);
//     we just don't mutate Linear or runtime state.
//   enforce=true (ENFORCE) — emit the escalate.human operator event, apply the
//     needs-human label once via labelOnce, and flip the matching capped
//     wake-diagnostician intent(s) to 'escalated'.

import { labelOnce } from "../label-guard.mjs";
import { log } from "../config.mjs";

// ── executeEscalations — per-tick executor for R12 escalate_human beliefs.
//
// Parameters:
//   db      — the beliefs.db Database (bun:sqlite), already open
//   tickId  — the current tick's tick_id
//   opts    — {
//     orchDir     : string                         (for labelOnce marker path)
//     writeStatus : { applyLabel, ... }            (the Linear write seam)
//     appendEvent : (evt) => void | null           (operator-event seam)
//     enforce     : boolean                         (CATALYST_INTENTS_ENFORCE=1)
//     labelOnceFn : (orchDir,ticket,label,writeStatus,opts) => void  (injectable)
//     env         : Record<string,string>          (process.env in production)
//   }
//
// Returns { escalated, paged, skipped, errors } — never throws. Per-subject
// try/catch isolates one bad subject from the rest.
export function executeEscalations(
  db,
  tickId,
  {
    orchDir,
    writeStatus,
    appendEvent = null,
    enforce = false,
    labelOnceFn = labelOnce,
    env = process.env,
  } = {},
) {
  let escalated = 0; // subjects whose intent we flipped to 'escalated'
  let paged = 0; // subjects we applied the needs-human label for
  let skipped = 0; // subjects we record-only'd (shadow mode)
  const errors = [];

  let beliefs;
  try {
    beliefs = db
      .query("SELECT subject, value FROM belief WHERE tick_id = ? AND name = 'escalate_human'")
      .all(tickId);
  } catch (err) {
    errors.push({ phase: "read", err: String(err?.message ?? err) });
    return { escalated, paged, skipped, errors };
  }

  // Flip the still-open, capped wake-diagnostician intent(s) for a subject to
  // 'escalated'. Scoped to the cap so a fresh (uncapped) wake intent is never
  // prematurely closed. The cap comes from cfg(max_attempts), matching R11/R12.
  const flipIntent = db.prepare(
    `UPDATE intent SET outcome = 'escalated'
      WHERE kind = 'wake-diagnostician' AND subject = ?
        AND outcome IS NULL
        AND attempts >= (SELECT value_int FROM cfg WHERE key = 'max_attempts')`,
  );

  for (const row of beliefs) {
    const subject = row.subject; // 'TICKET/phase'
    const ticket = subject.split("/")[0];
    let why = null;
    try {
      why = JSON.parse(row.value ?? "{}").why ?? null;
    } catch {
      why = null;
    }

    try {
      if (enforce !== true) {
        // SHADOW: record-only. No label, no flip, no emit.
        skipped++;
        log.debug({ subject, ticket, why }, "escalate: would escalate (shadow) — no label, no flip");
        continue;
      }

      // ENFORCE.
      // (a) operator event (best-effort; never throws out of here)
      if (typeof appendEvent === "function") {
        try {
          appendEvent({
            "event.name": "escalate.human",
            payload: { subject, ticket, why },
          });
        } catch (evtErr) {
          errors.push({ subject, phase: "appendEvent", err: String(evtErr?.message ?? evtErr) });
        }
      }

      // (b) apply the label exactly once (labelOnce is idempotent per
      // (ticket,label) per daemon lifetime via marker files).
      if (ticket) {
        labelOnceFn(orchDir, ticket, "needs-human", writeStatus, { appendEvent, env });
        paged++;
      }

      // (c) flip the capped wake-diagnostician intent(s) to 'escalated' so
      // R11/R12 stop firing next tick — this is what bounds escalation to once.
      const info = flipIntent.run(subject);
      if (info?.changes > 0) escalated++;

      log.warn({ subject, ticket, why }, "escalate: paged operator (needs-human) and flipped intent → escalated");
    } catch (err) {
      errors.push({ subject, phase: "escalate", err: String(err?.message ?? err) });
    }
  }

  return { escalated, paged, skipped, errors: errors.length ? errors : [] };
}
