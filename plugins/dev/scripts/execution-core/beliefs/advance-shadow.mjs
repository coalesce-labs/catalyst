// beliefs/advance-shadow.mjs — CTL-966 + CTL-935 shadow comparator: compares the
// PROCEDURAL advancement oracle (deriveAdvancement) against the DERIVE-ONLY
// advance_to / cycle_exhausted beliefs for the current tick, and logs every
// disagreement as an operator event. SHADOW ONLY — this path NEVER dispatches,
// writes a signal, resets a cycle, or writes Linear. It READS beliefs.db +
// computes the oracle + appends an operator event. Nothing here gates the tick.
//
// The free_slots-shadow pattern applied to advancement: on ANY disagreement,
// append a `beliefs.advance_shadow.disagree` event carrying the procedural
// answer, the belief answer, a signals summary, and the differing input — so
// disagreements are logged with rate + direction + differing-input. On agreement
// the caller may emit a `beliefs.advance_shadow.tick` summary (agree/disagree
// counts). The whole function is wrapped in the caller's own try/catch (shadow
// contract); it additionally guards each ticket so one bad ticket can't abort the
// comparison of the rest.
//
// TIMING (shadow fidelity): this comparator runs AFTER collectBeliefsTick (so the
// advance_to/cycle_exhausted beliefs for THIS tick exist) and BEFORE schedulerTick
// (which runs maybeResetForRemediateCycle + the real dispatch). In production the
// oracle reads its inputs from the tick-locked EDB snapshot (obs_signal/obs_verdict/
// obs_cycle for this tickId) — the SAME rows the belief consumed at collectBeliefsTick.
// This is a true apples-to-apples comparison: a logged disagreement reflects a genuine
// belief/oracle mismatch on identical inputs, not mid-tick input skew from a phase
// signal file mutating between Steps 2 and 4 (CTL-1058). The disk seams remain
// available as test-override hooks; only the production wiring was changed.

// readAdvanceBeliefs — for one tick, the advance_to + cycle_exhausted beliefs
// keyed by ticket (subject). Returns { advanceTo: Map<ticket,{from,to}>,
// cycleExhausted: Set<ticket> }. Pure read; null-safe on a missing db.
export function readAdvanceBeliefs(db, tickId) {
  const advanceTo = new Map();
  const cycleExhausted = new Set();
  if (!db || tickId == null) return { advanceTo, cycleExhausted };
  const rows = db
    .query(
      "SELECT name, subject, value FROM belief WHERE tick_id = ? AND name IN ('advance_to','cycle_exhausted')",
    )
    .all(tickId);
  for (const r of rows) {
    if (r.name === "cycle_exhausted") {
      cycleExhausted.add(r.subject);
      continue;
    }
    let v = null;
    try {
      v = r.value ? JSON.parse(r.value) : null;
    } catch {
      v = null;
    }
    advanceTo.set(r.subject, v);
  }
  return { advanceTo, cycleExhausted };
}

// readSignalsFromEdb — reconstruct the { phase: status } map the belief saw for one
// ticket from the tick-locked obs_signal snapshot. Same shape readPhaseSignals returns,
// but sourced from the EDB (no live-disk read) → no mid-tick input skew (CTL-1058).
// Deterministic MIN(fact_id) tie-break on duplicate (tick_id,ticket,phase), matching
// R16's latest_sig CTE (rules.mjs:632).
export function readSignalsFromEdb(db, tickId, ticket) {
  const out = {};
  if (!db || tickId == null) return out;
  const rows = db
    .query(
      "SELECT phase, status FROM obs_signal WHERE tick_id = ? AND ticket = ? ORDER BY fact_id ASC",
    )
    .all(tickId, ticket);
  for (const r of rows) {
    if (!Object.prototype.hasOwnProperty.call(out, r.phase)) {
      out[r.phase] = r.status ?? null; // first (MIN fact_id) wins
    }
  }
  return out;
}

// readVerdictFromEdb — the verify verdict the belief saw for one ticket, from the
// tick-locked obs_verdict snapshot. Null verdicts have no row ⇒ return null.
export function readVerdictFromEdb(db, tickId, ticket) {
  if (!db || tickId == null) return null;
  const row = db
    .query("SELECT verdict FROM obs_verdict WHERE tick_id = ? AND ticket = ? LIMIT 1")
    .get(tickId, ticket);
  return row?.verdict ?? null;
}

// readCycleFromEdb — the remediate cycle count the belief saw for one ticket, from the
// tick-locked obs_cycle snapshot. No row ⇒ 0 (count=0 is normally inserted, but stay safe).
export function readCycleFromEdb(db, tickId, ticket) {
  if (!db || tickId == null) return 0;
  const row = db
    .query("SELECT remediate_count FROM obs_cycle WHERE tick_id = ? AND ticket = ? LIMIT 1")
    .get(tickId, ticket);
  return row?.remediate_count ?? 0;
}

// signalsSummary — a compact { phase: status } map for the disagreement payload.
function signalsSummary(signals) {
  const out = {};
  for (const [phase, status] of Object.entries(signals ?? {})) out[phase] = status;
  return out;
}

// compareAdvancement — pure comparison for ONE ticket. Returns null on agreement,
// else a disagreement record. The belief side: advance_to.to (or null when no
// advance_to belief exists). The procedural side: deriveAdvancement's return
// (a phase string, "remediate", or null). They AGREE iff procedural === beliefTo
// (both null counts as agreement). cycle_exhausted is compared as a secondary
// signal: the belief fires it exactly when the oracle returns null AT the cap on a
// failed verify verdict — a mismatch there is also a disagreement.
//
//   procedural : string | "remediate" | null   (deriveAdvancement output)
//   beliefTo   : string | "remediate" | null   (advance_to.value.to or null)
//   beliefExhausted : boolean                   (cycle_exhausted belief present)
//   expectExhausted : boolean                   (the oracle's cap condition)
export function compareAdvancement({
  ticket,
  signals,
  procedural,
  beliefTo,
  beliefExhausted,
  expectExhausted,
  verdict,
  cycleCount,
}) {
  const advanceAgrees = procedural === beliefTo;
  const exhaustAgrees = !!beliefExhausted === !!expectExhausted;
  if (advanceAgrees && exhaustAgrees) return null;
  return {
    ticket,
    procedural,
    belief: beliefTo,
    procedural_exhausted: !!expectExhausted,
    belief_exhausted: !!beliefExhausted,
    signals: signalsSummary(signals),
    differingInput: { verdict: verdict ?? null, remediateCycleCount: cycleCount ?? 0 },
  };
}

// runAdvanceShadow — the daemon-facing comparator. For each in-flight ticket,
// compute the procedural oracle and compare it to the belief. Appends a
// `beliefs.advance_shadow.disagree` operator event per disagreement and an
// optional `beliefs.advance_shadow.tick` summary. Returns { agree, disagree,
// disagreements }. NEVER acts on the result.
//
// Injected seams (so it stays pure + testable, mirroring the scheduler sweep):
//   listInFlight(orchDir)               -> ticket[]
//   readSignals(orchDir, ticket)        -> { phase: status }
//   readVerdict({ ticket, orchDir })    -> "pass" | "fail" | null
//   countCycles({ ticket })             -> integer
//   deriveAdvancement(signals, opts)    -> string | "remediate" | null
//   capOf()                             -> REMEDIATE_CYCLE_CAP
//   appendEvent(evt)                    -> void | null   (operator-event seam)
export function runAdvanceShadow(
  db,
  tickId,
  {
    orchDir,
    listInFlight,
    readSignals,
    readVerdict,
    countCycles,
    deriveAdvancement,
    cap,
    appendEvent = null,
    emitTickSummary = false,
  } = {},
) {
  const result = { agree: 0, disagree: 0, disagreements: [] };
  if (!db || tickId == null) return result;

  const { advanceTo, cycleExhausted } = readAdvanceBeliefs(db, tickId);

  // CTL-1063 Phase 4: hoist rules_sha read once per run (not per ticket) so
  // the event payloads include the rules version active when this tick ran.
  const rulesShaTick =
    db.query("SELECT rules_sha FROM tick WHERE tick_id = ?").get(tickId)?.rules_sha ?? null;

  let tickets = [];
  try {
    tickets = listInFlight(orchDir) ?? [];
    // listInFlightTickets returns a Set; normalize to an array.
    if (!Array.isArray(tickets)) tickets = Array.from(tickets);
  } catch {
    tickets = [];
  }

  for (const ticket of tickets) {
    try {
      const signals = readSignals(orchDir, ticket) ?? {};
      const verdict = readVerdict({ ticket, orchDir }) ?? null;
      const cycleCount = countCycles({ ticket }) ?? 0;
      // The PROCEDURAL oracle — the exact call the advancement sweep makes.
      const procedural = deriveAdvancement(signals, {
        verifyVerdict: verdict,
        remediateCycleCount: cycleCount,
      });
      // The oracle's cap condition (mirrors maybeEscalateRemediateExhausted's
      // trigger): verify done + verdict fail + cycleCount >= cap.
      const expectExhausted =
        signals.verify === "done" && verdict === "fail" && cycleCount >= cap;

      const beliefVal = advanceTo.get(ticket) ?? null;
      const beliefTo = beliefVal?.to ?? null;
      const beliefExhausted = cycleExhausted.has(ticket);

      const disagreement = compareAdvancement({
        ticket,
        signals,
        procedural,
        beliefTo,
        beliefExhausted,
        expectExhausted,
        verdict,
        cycleCount,
      });

      if (disagreement) {
        result.disagree += 1;
        result.disagreements.push(disagreement);
        if (typeof appendEvent === "function") {
          try {
            appendEvent({
              "event.name": "beliefs.advance_shadow.disagree",
              payload: { ...disagreement, rules_sha: rulesShaTick },
            });
          } catch {
            /* operator-event append is best-effort — never breaks the tick */
          }
        }
      } else {
        result.agree += 1;
      }
    } catch {
      // one bad ticket must not abort the comparison of the rest (shadow contract)
    }
  }

  if (emitTickSummary && typeof appendEvent === "function" && (result.agree || result.disagree)) {
    try {
      appendEvent({
        "event.name": "beliefs.advance_shadow.tick",
        payload: { agree: result.agree, disagree: result.disagree, rules_sha: rulesShaTick },
      });
    } catch {
      /* best-effort */
    }
  }

  return result;
}
