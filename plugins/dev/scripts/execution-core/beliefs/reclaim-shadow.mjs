// beliefs/reclaim-shadow.mjs — CTL-935 Phase 3: reclaim-verdict / R4-R7 shadow
// comparator.  Captures raw per-signal reclaimDeadWork outcomes (before the
// lossy switch in schedulerTick) and compares them to the R4/R5/R6/R7 belief
// verdicts for each ticket/phase at this tick, naming both the legacy guard and
// the belief rule on disagreement.  SHADOW ONLY — never dispatches or writes signals.

import { GUARD_ONLY_NO_RULE } from "./guards.mjs";

// Belief precedence order (higher index = higher priority in reduceBeliefVerdict).
const PRECEDENCE = ["lease_valid", "lease_expired", "worker_dead", "wedged_never_started"];

// reduceBeliefVerdict — given multiple belief names for the same subject, return
// the highest-precedence one. "Higher" belief class = more severe.
function reduceBeliefVerdict(names) {
  let best = null;
  let bestIdx = -1;
  for (const n of names) {
    const idx = PRECEDENCE.indexOf(n);
    if (idx > bestIdx) { bestIdx = idx; best = n; }
  }
  return best;
}

// readReclaimBeliefs — for this tick, read all R4/R5/R6/R7 beliefs and reduce
// each subject to a single verdict via PRECEDENCE. Returns Map<subject, verdict>.
export function readReclaimBeliefs(db, tickId) {
  const out = new Map();
  if (!db || tickId == null) return out;
  try {
    const rows = db
      .query(
        "SELECT name, subject FROM belief WHERE tick_id = ? AND name IN ('wedged_never_started','worker_dead','lease_expired','lease_valid')",
      )
      .all(tickId);
    const bySubject = new Map();
    for (const r of rows) {
      if (!bySubject.has(r.subject)) bySubject.set(r.subject, []);
      bySubject.get(r.subject).push(r.name);
    }
    for (const [subj, names] of bySubject) {
      out.set(subj, reduceBeliefVerdict(names));
    }
  } catch {
    /* null-safe */
  }
  return out;
}

// GUARD → EXPECTED-BELIEF-CLASS for attribution.
// "null" means a disagreement vs the named belief should be classified with this rule_id.
const GUARD_EXPECTED_BELIEF = {
  "reclaimed":             "worker_dead",
  "terminal-short-circuit": null,    // guard-only-no-rule
  "revived":               "worker_dead",
  "wedged-redispatched":   "wedged_never_started",
  "revive-suppressed":     "worker_dead",
  "no-progress-stopped":  "worker_dead",
  "escalated":             null,     // ambiguous — stamp differingInput.escalateAmbiguous
  "escalation-suppressed": null,     // guard-only-no-rule
  "rate-limited-deferred": null,     // guard-only-no-rule
  "alive-suppressed":      "lease_valid",  // procedural=alive; disagrees with R6/R7
  "reclaim-failed":        "worker_dead",
  "inert-stale":           "worker_dead",
  "superseded-noop":       null,     // guard-only-no-rule
  "noop":                  "lease_valid",
};

// BELIEF → RULE_ID for attribution in the disagreement record.
const BELIEF_RULE = {
  "wedged_never_started": "R4",
  "lease_valid":          "R5",
  "lease_expired":        "R6",
  "worker_dead":          "R7",
};

// compareReclaim — pure comparison for one (ticket/phase, outcome) pair.
// Returns null on agreement, else a disagreement/guard-only record.
export function compareReclaim({ outcome, beliefVerdict } = {}) {
  if (!outcome) return null;

  // Guard-only-no-rule: provably load-bearing, not a disagreement.
  if (GUARD_ONLY_NO_RULE.has(outcome)) {
    return { agree: false, guardOnlyNoRule: true, legacyGuard: outcome, ruleId: null };
  }

  // "escalated" is ambiguous — stamp a warning flag but don't call it a firm disagree.
  if (outcome === "escalated") {
    if (!beliefVerdict || beliefVerdict === "lease_valid") return null;
    return {
      agree: false,
      guardOnlyNoRule: false,
      legacyGuard: outcome,
      ruleId: BELIEF_RULE[beliefVerdict] ?? null,
      differingInput: { legacyGuard: outcome, beliefVerdict, escalateAmbiguous: true },
    };
  }

  const expected = GUARD_EXPECTED_BELIEF[outcome];
  if (expected === undefined) return null; // unknown outcome — ignore

  // Agreement: the expected belief class matches what actually fired
  // (or the guard is a dead/alive category that aligns with the belief).
  const actualAgreement = (() => {
    switch (outcome) {
      // Procedural=dead family: agree if belief is worker_dead OR lease_expired
      case "reclaimed":
      case "revived":
      case "revive-suppressed":
      case "no-progress-stopped":
      case "reclaim-failed":
      case "inert-stale":
        return beliefVerdict === "worker_dead" || beliefVerdict === "lease_expired";
      // Procedural=wedge: agree only on wedged_never_started
      case "wedged-redispatched":
        return beliefVerdict === "wedged_never_started";
      // Procedural=alive: agree only on lease_valid (alive) or null (no relevant belief)
      case "alive-suppressed":
        return !beliefVerdict || beliefVerdict === "lease_valid";
      case "noop":
        return !beliefVerdict || beliefVerdict === "lease_valid";
      default:
        return beliefVerdict === expected;
    }
  })();

  if (actualAgreement) return null;

  // ruleId: attribute to the higher-precedence (more severe) belief between what
  // the guard expected and what actually fired. e.g. wedged-redispatched expected
  // wedged_never_started (R4) but got lease_valid (R5) → ruleId=R4, not R5.
  const expectedIdx = PRECEDENCE.indexOf(expected ?? "");
  const actualIdx = PRECEDENCE.indexOf(beliefVerdict ?? "");
  const severeBelief = expectedIdx >= actualIdx ? expected : beliefVerdict;
  const ruleId = BELIEF_RULE[severeBelief] ?? null;

  return {
    agree: false,
    guardOnlyNoRule: false,
    legacyGuard: outcome,
    ruleId,
    differingInput: { legacyGuard: outcome, beliefVerdict: beliefVerdict ?? null },
  };
}

// makeReclaimShadowRecorder — returns a per-tick driver that accepts a Map<subject,
// rawOutcome> from the reclaim sweep (before the lossy switch) and processes each
// entry against the belief for that tick. Dual-writes event log + shadow_comparison.
export function makeReclaimShadowRecorder(db, tickId, {
  appendEvent = null,
  writeComparison = null,
} = {}) {
  if (!db || tickId == null) {
    return () => {};
  }

  let beliefMap = null;
  let rulesShaTick = null;

  return function recordReclaimOutcomes(reclaimOutcomes) {
    if (!reclaimOutcomes?.size) return;
    try {
      if (!beliefMap) {
        beliefMap = readReclaimBeliefs(db, tickId);
        rulesShaTick = db.query("SELECT rules_sha FROM tick WHERE tick_id = ?").get(tickId)?.rules_sha ?? null;
      }
    } catch {
      return;
    }

    for (const [subject, outcome] of reclaimOutcomes) {
      try {
        const beliefVerdict = beliefMap.get(subject) ?? null;
        const cmp = compareReclaim({ outcome, beliefVerdict });

        if (cmp === null) {
          // Explicit agreement
          if (typeof writeComparison === "function") {
            try {
              writeComparison({
                tickId,
                dimension: "reclaim",
                subject,
                agree: 1,
                procedural: outcome,
                belief: beliefVerdict,
                legacyGuard: outcome,
                ruleId: BELIEF_RULE[beliefVerdict] ?? null,
                rulesSha: rulesShaTick,
                differingInput: null,
              });
            } catch { /* best-effort */ }
          }
          continue;
        }

        if (cmp.guardOnlyNoRule) {
          // Provably load-bearing — write the row but don't emit disagree event
          if (typeof writeComparison === "function") {
            try {
              writeComparison({
                tickId,
                dimension: "reclaim",
                subject,
                agree: 0,
                procedural: outcome,
                belief: beliefVerdict,
                legacyGuard: outcome,
                ruleId: null,
                rulesSha: rulesShaTick,
                differingInput: JSON.stringify({ guardOnlyNoRule: true }),
                guardOnlyNoRule: true,
              });
            } catch { /* best-effort */ }
          }
          continue;
        }

        // Genuine disagreement
        if (typeof appendEvent === "function") {
          try {
            appendEvent({
              "event.name": "beliefs.reclaim_shadow.disagree",
              payload: {
                subject,
                legacyGuard: outcome,
                beliefVerdict,
                ruleId: cmp.ruleId,
                rules_sha: rulesShaTick,
                differingInput: cmp.differingInput,
              },
            });
          } catch { /* best-effort */ }
        }
        if (typeof writeComparison === "function") {
          try {
            writeComparison({
              tickId,
              dimension: "reclaim",
              subject,
              agree: 0,
              procedural: outcome,
              belief: beliefVerdict,
              legacyGuard: outcome,
              ruleId: cmp.ruleId,
              rulesSha: rulesShaTick,
              differingInput: JSON.stringify(cmp.differingInput ?? { legacyGuard: outcome, beliefVerdict }),
            });
          } catch { /* best-effort */ }
        }
      } catch {
        // per-subject isolation: one bad subject must not abort the rest
      }
    }
  };
}
