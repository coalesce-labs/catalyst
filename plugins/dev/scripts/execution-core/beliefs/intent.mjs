// beliefs/intent.mjs — CTL-936: closed-loop intent layer.
//                       CTL-962: escalation is the executor's job, not the
//                                reconciler's.
//
// Every daemon side-effect records a DESIRED POSTCONDITION; a per-tick
// reconciler re-checks whether the world changed, increments attempts + backs
// off when it did not, and when attempts >= max_attempts STOPS retrying that
// channel — but it does NOT decide the outcome. It LEAVES outcome NULL so the
// belief rules can see the capped intent on the next tick:
//   R11 action_ineffective  (intent.outcome IS NULL AND attempts >= max_attempts)
//   R12 escalate_human       (wake_diagnostician + action_ineffective co-occur)
// and the escalate.mjs executor (CTL-962) pages the operator EXACTLY ONCE and
// flips outcome='escalated'. Before CTL-962 the reconciler imperatively flipped
// outcome='ineffective' the moment the cap was hit; that stranded the ladder
// because R11's `outcome IS NULL` predicate never matched (the reconciler runs
// before the NEXT tick's evaluateBeliefs), so R12 never derived and nobody was
// ever paged. The reconciler now only counts the capped intent and stops.
//
// This fixes three bug classes documented in 2026-06-09-execution-core-fable-
// root-cause-and-architecture.md:
//   A2  kill-storm  — `claude stop` re-issued every ~7s for 8h (§A2)
//   A3  fire-once   — Linear mirror / label writes silently dropped on first
//                     transient failure (§A3/A4)
//   A4  pager-fail  — label write failure invisible to operator (§A4)
//
// ── Gating flags ──────────────────────────────────────────────────────────────
//   CATALYST_INTENTS_ENFORCE  (default "0")
//     "0" — shadow: intents are RECORDED + RECONCILED into beliefs.db so the
//           belief rules (R11/R12) fire and the audit trail exists, but NO
//           retry-suppression or alternate-channel escalation affects runtime
//           behavior. Safe to enable alongside CATALYST_BELIEFS_SHADOW=1.
//     "1" — enforce: reconcileIntents WILL suppress re-issuance of an
//           ineffective channel. Operator paging (the needs-human label + the
//           escalate.human event) is now owned by escalate.mjs's executor, also
//           gated on this flag. Gate this on a controlled canary first.
//
//   Rationale for the flag split: the kill-suppress (stop retrying claude stop)
//   and alternate-channel escalation paths mutate RUNTIME behavior. The mirror
//   and label retry paths are additive (they fire where nothing did before), so
//   their "enforcement" is an improvement. However, all three share the same
//   flag so operators have ONE knob.
//
// ── Intent kinds ──────────────────────────────────────────────────────────────
//   kill           — `claude stop <shortId>` against a bg worker
//   mirror         — Linear board-state write (applyPhaseStatus)
//   label          — needs-human / blocked / waiting label write
//   wake-diag      — diagnostician channel wake (escalate to human operator)
//
// ── Postcondition shapes (stored as JSON in intent.postcondition) ─────────────
//   kill:      { kind:"kill",  subject:"<ticket>/<phase>", bgJobId:"<id>", sessionNotRegistered:true }
//              bgJobId pins the SPECIFIC session we wanted stopped; satisfied
//              when that specific session is absent from obs_agent (not just any
//              session for the subject — a revived worker is a different session)
//   mirror:    { kind:"mirror", subject:"<ticket>", wantState:"<Linear key>" }
//              satisfied when obs_linear.state == wantState for the ticket
//   label:     { kind:"label", subject:"<ticket>", label:"<name>", present:true }
//              satisfied when the label appears in the current label listing
//   wake-diag: { kind:"wake-diag", subject:"<ticket>/<phase>" }
//              satisfied by operator acknowledgement (out-of-band; treated as
//              satisfied after max_attempts to avoid runaway events)
//
// ── Reconciliation contract (CTL-962) ─────────────────────────────────────────
// reconcileIntents(db, tickId, worldSnapshot, opts) runs INSIDE the belief-tick
// transaction (same tx as evaluateBeliefs), so intent mutations and the derived
// R11 belief are always in sync. It:
//   1. Reads all OPEN intents (outcome IS NULL).
//   2. For each: evaluates the postcondition against worldSnapshot.
//      • satisfied → outcome='satisfied', stop.
//      • unsatisfied:
//          attempts < max_attempts → increment attempts (backoff deferred to
//          caller — the tick cadence already provides natural backoff).
//          attempts >= max_attempts → STOP. Do NOT increment further (attempts
//          plateaus at max_attempts, never exceeds), LEAVE outcome NULL, do NOT
//          re-issue the channel, and do NOT emit any escalation event. The capped
//          intent is counted in the returned `ineffective` stat so the caller can
//          log it, but the OUTCOME decision is no longer made here.
//   3. Returns { satisfied, retried, ineffective, events } counts. `events` is
//      always empty (escalation moved to escalate.mjs); retained for caller compat.
//
// Why leave outcome NULL: R11's SQL matches `outcome IS NULL AND attempts >=
// max_attempts`. The reconciler runs AFTER evaluateBeliefs in the tick, so any
// flip here would only ever be visible to the NEXT tick's R11 — but flipping to
// a terminal outcome makes that predicate FALSE, so R11 would never see it and
// R12 escalate_human would never derive. Leaving outcome NULL lets R11 derive
// action_ineffective next tick, R12 derive escalate_human, and escalate.mjs page
// the operator once and flip outcome='escalated' (which then suppresses R11/R12).

import { log } from "../config.mjs";

// ── recordIntent — insert a new open intent row ───────────────────────────────
//
// Parameters:
//   db         — open bun:sqlite Database (beliefs.db)
//   tickId     — current tick (from the INSERT into tick)
//   kind       — one of 'kill' | 'mirror' | 'label' | 'wake-diag'
//   subject    — ticket/phase (kill/wake-diag) or ticket (mirror/label)
//   postcondition — plain-object; stored as JSON
//   beliefId   — optional INTEGER belief_id that triggered this action
//
// Returns the inserted intent_id.
export function recordIntent(db, { tickId, kind, subject, postcondition, beliefId = null }) {
  db.run(
    `INSERT INTO intent (tick_id, kind, subject, belief_id, postcondition, attempts, outcome)
     VALUES (?, ?, ?, ?, ?, 0, NULL)`,
    [tickId, kind, subject, beliefId, JSON.stringify(postcondition)],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}

// ── hasOpenIntent — guard to avoid double-recording an intent for the same
// (kind, subject) when one is already open (outcome IS NULL).
export function hasOpenIntent(db, kind, subject) {
  const row = db
    .query("SELECT 1 FROM intent WHERE kind = ? AND subject = ? AND outcome IS NULL LIMIT 1")
    .get(kind, subject);
  return row != null;
}

// ── resolvePostcondition — evaluate whether a postcondition is satisfied
// against a world snapshot. Returns true/false. Never throws (returns false on
// error so the intent stays open and retries next tick).
//
// worldSnapshot shape (all fields optional — unresolvable fields → unsatisfied):
//   agentsBySubject   Map<"ticket/phase", { session_id, short_id } | null>
//                     null means "no session registered for this subject"
//   linearStateByTicket Map<ticket, string|null>  (null = unreadable this tick)
//   labelsByTicket    Map<ticket, Set<string>>
function resolvePostcondition(postcondition, worldSnapshot) {
  try {
    const pc = typeof postcondition === "string" ? JSON.parse(postcondition) : postcondition;
    switch (pc.kind) {
      case "kill": {
        // Satisfied when the SPECIFIC bg job we wanted stopped is absent.
        // If the postcondition pins a bgJobId (CTL-936 H1 fix), check that
        // the specific session is gone — a newly-revived worker filling the
        // same subject slot has a different bgJobId and must not satisfy this
        // intent. Falls back to subject-level absence for legacy records that
        // have no bgJobId (safe: those were recorded before the revive path
        // was a concern).
        const entry = worldSnapshot.agentsBySubject?.get(pc.subject);
        if (pc.bgJobId) {
          // Specific session: satisfied only when that exact bgJobId is absent.
          // entry.session_id may be a full session id; bgJobId may be the same
          // or a short prefix — compare the stored bgJobId against both forms.
          if (entry == null) return true; // slot empty — definitely gone
          const entryBgId = entry.session_id ?? "";
          // Consider it gone if the current entry's session does NOT match the
          // targeted bgJobId (either as-is or as a prefix match for short ids).
          return !entryBgId.startsWith(pc.bgJobId) && !pc.bgJobId.startsWith(entryBgId);
        }
        return entry == null; // legacy: subject-level absence (no bgJobId pinned)
      }
      case "mirror": {
        // Satisfied when the Linear state for the ticket matches wantState.
        // Terminal Done is exempt per CTL-758 — if the ticket is already
        // terminal we should not re-write it backwards; treat as satisfied
        // to prevent the intent from cycling forever against a terminal ticket.
        const state = worldSnapshot.linearStateByTicket?.get(pc.subject);
        if (state == null) return false; // unreadable this tick → retry
        if (state === "Done" || state === "Canceled" || state === "Cancelled") return true; // exempt
        return state === pc.wantState;
      }
      case "label": {
        const labels = worldSnapshot.labelsByTicket?.get(pc.subject);
        if (labels == null) return false; // unreadable → retry
        return pc.present ? labels.has(pc.label) : !labels.has(pc.label);
      }
      case "wake-diag":
        // Operator-acknowledged out-of-band; treat as satisfied-after-N to
        // avoid runaway paging. Caller drives max_attempts for this kind.
        return false; // never auto-satisfied — R11 will mark ineffective
      case "unstuck-sweep": {
        // CTL-1064: satisfied when the signal for this subject is no longer
        // stalled. Absent map entry → retry (unreadable → never auto-satisfied).
        const signalStatus = worldSnapshot.signalStatusBySubject?.get(pc.subject);
        if (signalStatus == null) return false; // unreadable → retry
        return signalStatus !== "stalled" && signalStatus !== "failed";
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}

// ── reconcileIntents — the per-tick closed loop. Runs INSIDE the belief-tick
// transaction. Pure given worldSnapshot + db (no clock read — now comes from
// tick.now_ms; callers pass now explicitly for the log lines).
//
// opts:
//   maxAttempts   — from cfg(max_attempts), default 2
//   enforce       — true when CATALYST_INTENTS_ENFORCE=1 (kept for the
//                   retry-suppression log line; escalation is escalate.mjs's job)
//   appendEvent   — RETAINED for caller compat; reconcileIntents no longer emits
//                   any escalation event (escalate.mjs owns that seam, CTL-962)
//   now           — epoch-ms (for log context; does not affect SQL)
export function reconcileIntents(
  db,
  tickId,
  worldSnapshot,
  { maxAttempts = 2, enforce = false, appendEvent = null, now = null } = {},
) {
  const open = db
    .query("SELECT * FROM intent WHERE outcome IS NULL ORDER BY intent_id")
    .all();

  let satisfied = 0;
  let retried = 0;
  let ineffective = 0;
  const events = [];

  const updateOutcome = db.prepare(
    "UPDATE intent SET outcome = ? WHERE intent_id = ?",
  );
  const incrementAttempts = db.prepare(
    "UPDATE intent SET attempts = attempts + 1 WHERE intent_id = ?",
  );

  for (const intent of open) {
    let pc;
    try {
      pc = typeof intent.postcondition === "string"
        ? JSON.parse(intent.postcondition)
        : intent.postcondition;
    } catch {
      pc = {};
    }

    const isSatisfied = resolvePostcondition(pc, worldSnapshot);

    if (isSatisfied) {
      updateOutcome.run("satisfied", intent.intent_id);
      satisfied++;
      log.debug(
        { intentId: intent.intent_id, kind: intent.kind, subject: intent.subject, now },
        "intents: satisfied",
      );
      continue;
    }

    // Not satisfied. CTL-962: the reconciler stops deciding the outcome.
    //   • below the cap → increment attempts (one retry; tick cadence is backoff)
    //   • at/over the cap → STOP: do not increment further (attempts plateaus at
    //     maxAttempts), leave outcome NULL, do not re-issue, do not emit. R11
    //     derives action_ineffective next tick over this still-open capped intent,
    //     R12 derives escalate_human, and escalate.mjs pages once + flips
    //     outcome='escalated'. We only COUNT the capped intent here.
    if (intent.attempts >= maxAttempts) {
      // Already at/over the cap from a prior tick — stop retrying this channel.
      // Leave attempts and outcome untouched so R11's `outcome IS NULL AND
      // attempts >= max_attempts` predicate keeps matching until escalate.mjs
      // flips it to 'escalated'.
      ineffective++;
      log.warn(
        {
          intentId: intent.intent_id,
          kind: intent.kind,
          subject: intent.subject,
          attempts: intent.attempts,
          enforce,
          now,
        },
        "intents: action_ineffective — channel capped, outcome left NULL for R11/R12 (escalate.mjs pages)",
      );
      continue;
    }

    // Below the cap — one retry. Increment, then re-check whether THIS increment
    // reached the cap (so we count it as ineffective the moment it plateaus).
    incrementAttempts.run(intent.intent_id);
    const attemptsAfter = intent.attempts + 1;

    if (attemptsAfter >= maxAttempts) {
      // Just hit the cap. Leave outcome NULL; this is the last increment (the
      // capped-branch above will no-op it on subsequent ticks). Count it so the
      // caller's stats reflect that the channel stopped here.
      ineffective++;
      log.warn(
        {
          intentId: intent.intent_id,
          kind: intent.kind,
          subject: intent.subject,
          attempts: attemptsAfter,
          enforce,
          now,
        },
        "intents: action_ineffective — reached cap, outcome left NULL for R11/R12 (escalate.mjs pages)",
      );
    } else {
      retried++;
      log.debug(
        { intentId: intent.intent_id, kind: intent.kind, subject: intent.subject, attempts: attemptsAfter, now },
        "intents: unsatisfied, incremented attempts",
      );
    }
  }

  // `events` stays empty — escalation moved to escalate.mjs (CTL-962). The field
  // is retained so existing callers that destructure it keep working.
  void appendEvent; // intentionally unused; retained in the signature for compat
  return { satisfied, retried, ineffective, events };
}

// ── isIntentEffective — query helper for the kill-stop suppression seam.
// Returns true when there is NO open intent for (kind, subject) that has
// reached maxAttempts without satisfaction — meaning the channel is still
// viable. Returns false (suppress the stop) when the intent is ineffective.
//
// This is the guard that kills the 8-hour stop-storm: when enforce=true and
// killBgJob's intent has gone ineffective, callers skip re-issuing the stop.
export function isIntentEffective(db, kind, subject, { maxAttempts = 2 } = {}) {
  // CTL-962: an intent is "ineffective" (channel NOT viable) when its outcome is
  // 'ineffective' or 'escalated' (legacy + escalate.mjs's terminal flip) OR it is
  // still open (outcome IS NULL) but has reached the cap — the steady state the
  // reconciler now leaves it in until escalate.mjs flips it to 'escalated'. After
  // escalation outcome='escalated' must STILL suppress re-issuance, hence it is in
  // the terminal set below.
  const row = db
    .query(
      `SELECT 1 FROM intent
        WHERE kind = ? AND subject = ?
          AND (outcome IN ('ineffective', 'escalated')
            OR (outcome IS NULL AND attempts >= ?))
        LIMIT 1`,
    )
    .get(kind, subject, maxAttempts);
  return row == null; // no ineffective/escalated intent → channel still viable
}

// ── getMaxAttempts — read cfg(max_attempts) from the beliefs db.
// Falls back to 2 (the RULE_CFG_SEED default) when the row is absent.
export function getMaxAttempts(db) {
  try {
    const row = db.query("SELECT value_int FROM cfg WHERE key = 'max_attempts'").get();
    return typeof row?.value_int === "number" ? row.value_int : 2;
  } catch {
    return 2;
  }
}
