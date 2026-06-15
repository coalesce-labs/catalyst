// beliefs/free-slots-shadow.mjs — CTL-935 Phase 2: free-slots / R8 shadow
// comparator. Compares the procedural freeSlots value (captured from
// schedulerTick's return after the pass-2 liveness/drain gates) against the
// R8 free_slots belief for the current tick, dual-writing to the event log AND
// the shadow_comparison table. SHADOW ONLY — never dispatches or writes signals.

// readFreeSlotsBelief — read the R8 free_slots belief for this tick. Returns
// the parsed JSON value object or null if absent/unreadable.
export function readFreeSlotsBelief(db, tickId) {
  if (!db || tickId == null) return null;
  try {
    const row = db
      .query(
        "SELECT value FROM belief WHERE tick_id = ? AND name = 'free_slots' LIMIT 1",
      )
      .get(tickId);
    if (!row?.value) return null;
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

// compareFreeSlots — pure comparison. Returns null on agreement, else a
// disagreement record. Priority for differingInput:
//   1. max_parallel mismatch (cfg-staleness drift)
//   2. bg_session_count mismatch (liveness-filtered vs raw count — CTL-657)
//   3. lease_valid_count mismatch
export function compareFreeSlots({ proceduralFreeSlots, belief, host, proceduralInputs } = {}) {
  if (!belief) return null;
  if (proceduralFreeSlots === belief.free_slots) return null;

  let differingInput = { name: "unknown" };
  if (proceduralInputs) {
    const { maxParallel, inFlightCount } = proceduralInputs;
    if (Number.isFinite(maxParallel) && maxParallel !== belief.max_parallel) {
      differingInput = { name: "max_parallel", procedural: maxParallel, belief: belief.max_parallel };
    } else if (Number.isFinite(inFlightCount) && inFlightCount !== belief.bg_session_count) {
      differingInput = { name: "bg_session_count", procedural: inFlightCount, belief: belief.bg_session_count };
    } else if (belief.lease_valid_count != null && inFlightCount !== belief.lease_valid_count) {
      differingInput = { name: "lease_valid_count", procedural: inFlightCount, belief: belief.lease_valid_count };
    }
  }

  return {
    host,
    procedural: proceduralFreeSlots,
    belief: belief.free_slots,
    differingInput,
  };
}

// runFreeSlotsShadow — daemon-facing driver. Reads the R8 belief for this tick,
// compares it to the procedural freeSlots anchor, and dual-writes to the event
// log + shadow_comparison table. Returns { agree, disagree }.
export function runFreeSlotsShadow(db, tickId, {
  proceduralFreeSlots = null,
  proceduralInputs = null,
  appendEvent = null,
  writeComparison = null,
  emitTickSummary = false,
} = {}) {
  const result = { agree: 0, disagree: 0 };
  if (!db || tickId == null) return result;

  try {
    const tickRow = db.query("SELECT host, rules_sha FROM tick WHERE tick_id = ?").get(tickId);
    if (!tickRow) return result;
    const host = tickRow.host;
    const rulesShaTick = tickRow.rules_sha ?? null;

    const belief = readFreeSlotsBelief(db, tickId);

    const disagreement = compareFreeSlots({ proceduralFreeSlots, belief, host, proceduralInputs });

    if (disagreement) {
      result.disagree += 1;
      if (typeof appendEvent === "function") {
        try {
          appendEvent({
            "event.name": "beliefs.free_slots_shadow.disagree",
            payload: { tickId, ...disagreement, rules_sha: rulesShaTick },
          });
        } catch {
          /* best-effort */
        }
      }
      if (typeof writeComparison === "function") {
        try {
          writeComparison({
            tickId,
            dimension: "free_slots",
            subject: `host:${host}`,
            agree: 0,
            procedural: disagreement.procedural,
            belief: disagreement.belief,
            differingInput: disagreement.differingInput,
            ruleId: "R8",
            rulesSha: rulesShaTick,
          });
        } catch {
          /* best-effort */
        }
      }
    } else {
      result.agree += 1;
      if (typeof writeComparison === "function") {
        try {
          writeComparison({
            tickId,
            dimension: "free_slots",
            subject: `host:${host}`,
            agree: 1,
            procedural: proceduralFreeSlots,
            belief: belief?.free_slots ?? null,
            ruleId: "R8",
            rulesSha: rulesShaTick,
          });
        } catch {
          /* best-effort */
        }
      }
    }

    if (emitTickSummary && typeof appendEvent === "function") {
      try {
        appendEvent({
          "event.name": "beliefs.free_slots_shadow.tick",
          payload: { agree: result.agree, disagree: result.disagree, rules_sha: rulesShaTick },
        });
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* shadow contract: a comparator error must never break a daemon tick */
  }

  return result;
}
