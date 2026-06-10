// beliefs/intent.mjs — CTL-936: closed-loop intent layer.
//
// Every daemon side-effect records a DESIRED POSTCONDITION; a per-tick
// reconciler re-checks whether the world changed, increments attempts + backs
// off when it did not, and when attempts >= max_attempts (R11 action_ineffective)
// STOPS retrying that channel and ESCALATES to an operator-visible event.
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
//           ineffective channel and WILL emit operator-visible events via the
//           appendEvent seam. Gate this on a controlled canary first.
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
// ── Reconciliation contract ───────────────────────────────────────────────────
// reconcileIntents(db, tickId, worldSnapshot, opts) runs INSIDE the belief-tick
// transaction (same tx as evaluateBeliefs), so intent mutations and the derived
// R11 belief are always in sync. It:
//   1. Reads all OPEN intents (outcome IS NULL).
//   2. For each: evaluates the postcondition against worldSnapshot.
//      • satisfied → outcome='satisfied', stop.
//      • unsatisfied:
//          attempts < max_attempts → increment attempts (backoff deferred to
//          caller — the tick cadence already provides natural backoff).
//          attempts >= max_attempts → outcome='ineffective', emit operator event
//          (when CATALYST_INTENTS_ENFORCE=1) or log-only (shadow).
//   3. Returns { satisfied, retried, ineffective, events } counts.
//
// ── Operator event shape ──────────────────────────────────────────────────────
// When an intent goes ineffective the appendEvent seam is called with:
//   { "event.name": "intent.ineffective",
//     payload: { kind, subject, attempts, postcondition } }
// Callers wire this into the daemon's unified event log.

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
//   enforce       — true when CATALYST_INTENTS_ENFORCE=1
//   appendEvent   — (evt) => void, the operator-event seam
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

    // Not satisfied — increment attempts first, then check threshold.
    incrementAttempts.run(intent.intent_id);
    const attemptsAfter = intent.attempts + 1;

    if (attemptsAfter >= maxAttempts) {
      // R11 territory: action_ineffective. Mark the intent ineffective so the
      // SQL rule R11 fires on the NEXT tick's belief derivation (the belief
      // table is derived AFTER reconcileIntents in the tick order — see
      // collector.mjs's call order; the R11 SQL reads intents with outcome IS
      // NULL and attempts >= max_attempts, so we leave outcome NULL here to let
      // R11 see it this tick, and flip to 'ineffective' AFTER evaluation — BUT
      // the simplest correct approach is to flip here and re-seed R11 via the
      // NEXT tick. We therefore flip to 'ineffective' immediately so we don't
      // silently retry on the next tick, and rely on the R11 SQL matching
      // attempts >= max_attempts with outcome IS NULL on intermediate ticks.
      //
      // DESIGN NOTE: R11 matches `outcome IS NULL AND attempts >= max_attempts`.
      // This means we must NOT flip outcome to 'ineffective' before evaluateBeliefs
      // runs (otherwise R11 won't see it this tick either). Since reconcileIntents
      // is called AFTER evaluateBeliefs in the collector's transaction, we flip
      // outcome='ineffective' here so it is accurate for the next tick's R11. The
      // current tick's R11 already fired over the previous tick's open intents.
      updateOutcome.run("ineffective", intent.intent_id);
      ineffective++;

      const evt = {
        "event.name": "intent.ineffective",
        payload: {
          kind: intent.kind,
          subject: intent.subject,
          attempts: attemptsAfter,
          postcondition: pc,
        },
      };
      events.push(evt);

      if (enforce && typeof appendEvent === "function") {
        try {
          appendEvent(evt);
        } catch (err) {
          log.warn({ err: err?.message, intentId: intent.intent_id }, "intents: appendEvent threw — continuing");
        }
      }

      log.warn(
        {
          intentId: intent.intent_id,
          kind: intent.kind,
          subject: intent.subject,
          attempts: attemptsAfter,
          enforce,
          now,
        },
        enforce
          ? "intents: action_ineffective — stopped retrying channel, operator event emitted"
          : "intents: action_ineffective (shadow) — would stop retrying channel",
      );
    } else {
      retried++;
      log.debug(
        { intentId: intent.intent_id, kind: intent.kind, subject: intent.subject, attempts: attemptsAfter, now },
        "intents: unsatisfied, incremented attempts",
      );
    }
  }

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
  // An intent is "ineffective" if outcome='ineffective' OR (outcome IS NULL AND
  // attempts >= maxAttempts — the in-flight state before reconcileIntents flips it).
  const row = db
    .query(
      `SELECT 1 FROM intent
        WHERE kind = ? AND subject = ?
          AND (outcome = 'ineffective'
            OR (outcome IS NULL AND attempts >= ?))
        LIMIT 1`,
    )
    .get(kind, subject, maxAttempts);
  return row == null; // no ineffective intent → channel still viable
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
