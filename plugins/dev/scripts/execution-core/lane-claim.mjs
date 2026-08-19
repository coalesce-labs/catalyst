// lane-claim.mjs — CTL-2068. "A claim another automation can overwrite is not a claim."
//
// Twice in two nights (CTC-776, CTC-787) a fleet worker built a ticket a human-facing lane
// was already building, after the lane claimed it exactly as the rule says. The second time
// is the one that explains the mechanism, and it is on the replica:
//
//   1787132205283  Ryan Rozich    Validate  -> Implement     <- the lane claims it
//   1787132279778  Catalyst Cloud Implement -> Research      <- 74 s later, the pipeline
//                                                               drags it BACKWARDS
//   ...                                                      <- Research is a candidate
//                                                               state, so it dispatches
//
// The regression is the load-bearing step: it is what puts the ticket back into a state the
// dispatcher looks at. CTL-758 already has a backward-write guard, but it only refuses a
// write when the CURRENT state is TERMINAL (Done/Canceled) — Implement -> Research sails
// straight through it. This module generalizes that guard along the one axis that makes it
// safe to widen.
//
// ⛔ WHY THE ACTOR CHECK IS LOAD-BEARING, AND WHY A BLANKET "NEVER REGRESS" IS WRONG.
// The pipeline legitimately re-runs earlier phases (the L3 destroy-and-recreate on
// research/plan, the verify<->remediate cycle), and those writes ARE backward moves. A rule
// that refused every regression would break recovery. The property that separates the two is
// not the direction of the move — it is WHO last moved the ticket. So: a regression is
// refused only when the most recent state change was made by someone who is not the fleet.
//
// ⭐ HOW A LANE IS DISTINGUISHED FROM THE FLEET, MEASURED RATHER THAN ASSUMED.
// Lanes write state through `linearis` with Ryan's key, so their changes carry a HUMAN user
// id; the daemon writes as the app-actor ("Catalyst Cloud"), whose id is the already-
// configured botUserId. On CTC-787 those are c2a8cc92… (Ryan Rozich) and 78f8f491…
// (Catalyst Cloud) respectively. This module takes that Set as input and never hardcodes it.
//
// ⛔ THE FAIL DIRECTION IS ALLOW, AND EVERY DECLINE IS NAMED.
// This is a REFUSAL guard on the pipeline's own state writes, so a guard that cannot answer
// must not block: a replica outage or an unconfigured botUserIds set would otherwise wedge
// every phase transition on the fleet. Every such case returns INCONCLUSIVE with a reason
// rather than a quiet ALLOW, so "I could not look" is never recorded as "nothing is wrong".
//
// ⚠️ The empty-botUserIds case deserves naming on its own: with no known fleet ids, EVERY
// actor looks non-fleet and the guard would refuse the pipeline's every legitimate backward
// move. That is the dangerous direction, so an empty/absent Set is INCONCLUSIVE, never a
// licence to refuse.

import { PHASES, PHASE_LINEAR_KEY } from "../lib/phase-fsm.mjs";

export const VERDICT = Object.freeze({
  ALLOW: "allow",
  REFUSE: "refuse",
  INCONCLUSIVE: "inconclusive",
});

// The reason a decision was reached. Named so a log line, an event and a test can all agree,
// and so an operator reading "allow" can tell a judged allow from an unanswerable one.
export const REASON = Object.freeze({
  REGRESSION_AGAINST_LANE_CLAIM: "regression-against-lane-claim",
  NOT_A_REGRESSION: "not-a-regression",
  LAST_CHANGE_BY_FLEET: "last-change-by-fleet",
  NO_BOT_IDS: "no-bot-ids-configured",
  NO_HISTORY: "no-state-change-history",
  NO_ACTOR: "last-change-has-no-actor",
  UNRANKED_CURRENT: "current-state-not-in-pipeline",
  UNRANKED_TARGET: "target-state-not-in-pipeline",
  BAD_INPUT: "malformed-input",
  STALE_HISTORY: "history-row-does-not-match-current-state",
  DISPATCH_VETO_DISABLED: "dispatch-veto-disabled",
  NO_CURRENT_STATE: "current-state-unreadable",
  PHASE_WRITES_NO_STATUS: "phase-writes-no-status",
});

/**
 * buildStateRank — pure. Orders the Linear state NAMES the pipeline itself writes, by the
 * earliest pipeline phase that writes them.
 *
 * Derived from PHASE_LINEAR_KEY (phase -> linear key) composed with the caller's stateMap
 * (linear key -> state name). Several phases share a key (pr / monitor-merge /
 * monitor-deploy / teardown all write `inReview`), so the rank is the MINIMUM phase index —
 * "the earliest point in the pipeline at which a ticket can legitimately hold this state".
 *
 * ⛔ Deliberately ranks ONLY the states the pipeline writes. `Todo`, `Backlog`, `Triage`,
 * `Done` and anything a workspace has invented are absent, and an absent state makes the
 * verdict INCONCLUSIVE rather than ordering it at some invented position. That is what keeps
 * the ordinary Todo -> Research start from being read as a regression out of an unranked
 * state, and it is why this function does not fall back to `indexOf`-style -1 defaults.
 *
 * ⚠️ It reads ONE rung of the state-name chain (the caller's stateMap), NOT the four-rung
 * precedence chain that linear-transition.sh owns (per-project > global > registry >
 * built-in). Re-implementing that chain here would make this a second source of truth for
 * what "inProgress" means. Declining to rank an unmapped name means this guard can only ever
 * abstain where the chain would have disagreed — it can never contradict it.
 *
 * @param {Record<string,string>} stateMap linear key -> Linear state name
 * @returns {Map<string, number>} state name -> earliest phase index
 */
export function buildStateRank(stateMap) {
  const rank = new Map();
  if (stateMap === null || typeof stateMap !== "object" || Array.isArray(stateMap)) return rank;
  for (let i = 0; i < PHASES.length; i += 1) {
    const key = PHASE_LINEAR_KEY[PHASES[i]];
    if (!key) continue; // triage writes no status
    const name = stateMap[key];
    if (typeof name !== "string" || name.length === 0) continue;
    const prior = rank.get(name);
    if (prior === undefined || i < prior) rank.set(name, i);
  }
  return rank;
}

/**
 * buildKeyRank — pure. The TARGET side of the comparison, ranked straight off the phase
 * this write belongs to.
 *
 * ⭐ Why the target is ranked by LINEAR KEY and the current state by NAME. The write path
 * always knows the key it is writing (`research`, `inProgress`, …) — it is the function's
 * own argument — whereas the target's state NAME only exists after `--resolve-only`, which
 * runs on the proxy path and not on the shell path. Ranking the target from the key means
 * the guard needs no state name for it at all, so it evaluates identically on BOTH
 * transports with no extra subprocess. Anchoring the guard to whichever transport happened
 * to be configured is exactly the "held by an accident of configuration" shape this ticket
 * is about.
 *
 * Same MIN-index rule as buildStateRank, and derived from the same PHASE_LINEAR_KEY, so the
 * two sides of the comparison can never disagree about where a phase sits.
 *
 * @returns {Map<string, number>} linear key -> earliest phase index
 */
export function buildKeyRank() {
  const rank = new Map();
  for (let i = 0; i < PHASES.length; i += 1) {
    const key = PHASE_LINEAR_KEY[PHASES[i]];
    if (!key) continue;
    const prior = rank.get(key);
    if (prior === undefined || i < prior) rank.set(key, i);
  }
  return rank;
}

/**
 * resolveStateMap — pure. Walks an ordered list of `[label, path]` candidates and returns the
 * FIRST that yields a non-empty `catalyst.linear.stateMap`, with the label that produced it.
 *
 * ⛔ Exists because the first cut of this guard read ONE path and shipped INERT on half the
 * fleet. Measured after that ship: `ranked_states: 0` on `mini`, meaning the guard could never
 * refuse anything. `configPath` is `CATALYST_CONFIG_FILE || <cwd>/.catalyst/config.json`, and
 * the two hosts differ — mini-2 pins the env var, mini does not and its daemon's cwd is HOME,
 * where a `.catalyst/config.json` exists carrying no `catalyst.linear` at all. The read
 * SUCCEEDED and returned nothing, which is worse than failing: a throw would have been visible.
 *
 * ⚠️ So an empty or absent map is treated as NO ANSWER and the walk continues. A file that
 * parses is not evidence it is the right file.
 *
 * @param {Array<[string, string|null]>} candidates ordered [label, path] pairs
 * @param {(path: string) => string} readFile throwing reader (node:fs readFileSync)
 * @returns {{ stateMap: object|null, source: string }} source is "none" when nothing resolved
 */
export function resolveStateMap(candidates, readFile) {
  for (const entry of candidates ?? []) {
    const label = entry?.[0];
    const path = entry?.[1];
    if (typeof path !== "string" || path.length === 0) continue;
    let map = null;
    try {
      map = JSON.parse(readFile(path))?.catalyst?.linear?.stateMap ?? null;
    } catch {
      continue; // unreadable/malformed → not an answer, keep walking
    }
    if (map && typeof map === "object" && !Array.isArray(map) && Object.keys(map).length > 0) {
      return { stateMap: map, source: String(label ?? "?") };
    }
  }
  return { stateMap: null, source: "none" };
}

/**
 * classifyLaneClaimWrite — pure. Decides whether the pipeline may write `targetState` over
 * `currentState`, given who last changed the ticket's state.
 *
 * @param {object} o
 * @param {string|null} o.currentState  the ticket's state right now (a NAME)
 * @param {number|undefined} o.targetRank rank of the state this write would set, from
 *   buildKeyRank() — see there for why the target is ranked by key and not by name
 * @param {{actorId: string|null, toState: string|null}|null} o.lastChange the most recent
 *   state change on the ticket, or null when history is unavailable.
 *
 *   ⛔ `toState` IS consulted, and that is the whole of the CTL-2068 Codex P1 fix. The two
 *   inputs come from sources with very different latency, measured in this repo by CTL-1847
 *   (`linear-feed-diff.mjs`): `issues.state` — where `currentState` comes from — is
 *   webhook-fed and lands in ~11 s, while `issue_history` is RECONCILE-ONLY and lands in
 *   ~201 s, an 18× gap. So during exactly the short claim-to-dispatch window this guard
 *   exists for, the newest available history row is the transition BEFORE the lane's claim —
 *   often one the fleet itself made. Trusting its actor would return LAST_CHANGE_BY_FLEET
 *   and cheerfully permit the regression: a guard that is wrong precisely when it matters.
 *
 *   The row is therefore trusted ONLY when its `toState` equals the state the ticket is
 *   actually in. A row that does not describe the current state is not evidence about who
 *   put it there, and saying so (STALE_HISTORY) is the difference between a named blind spot
 *   somebody can count and a silent false negative.
 * @param {Set<string>} o.botUserIds    known fleet actor ids
 * @param {Map<string,number>} o.rank   from buildStateRank
 * @returns {{verdict: string, reason: string, currentRank?: number, targetRank?: number,
 *            actorId?: string|null}}
 */
export function classifyLaneClaimWrite({
  currentState,
  targetRank,
  lastChange,
  botUserIds,
  rank,
} = {}) {
  if (!(rank instanceof Map)) return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.BAD_INPUT };

  // ⛔ Order matters: the unconfigured-fleet case is checked FIRST, because with no known
  // fleet ids every actor below would read as a lane and every regression would be refused.
  if (!(botUserIds instanceof Set) || botUserIds.size === 0) {
    return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.NO_BOT_IDS };
  }
  if (lastChange === null || lastChange === undefined) {
    return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.NO_HISTORY };
  }
  const actorId = lastChange.actorId ?? null;
  if (typeof actorId !== "string" || actorId.length === 0) {
    return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.NO_ACTOR, actorId: null };
  }
  // ⛔ The row must DESCRIBE the state we are judging. See the `lastChange` doc above: the
  // history table lags the state table by ~18×, so a row whose toState is not the current
  // state is a row from before whatever put the ticket where it is now.
  //
  // ⚠️ This DECLINES (inconclusive → the write proceeds); it does not refuse. That is the
  // correct fail direction and it is also an honest admission: the ~200 s immediately after
  // a claim is NOT covered by this guard, and no timely actor source exists in the replica
  // to cover it (measured: `issues.bot_actor_name` is empty for 4,478 of 4,481 issues, so
  // the one webhook-fed actor column does not discriminate). Tracked as follow-up work.
  const rowState = lastChange.toState ?? null;
  if (typeof rowState === "string" && rowState.length > 0 && rowState !== currentState) {
    return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.STALE_HISTORY, actorId };
  }

  if (botUserIds.has(actorId)) {
    // The fleet itself made the last move, so there is no lane claim to protect. Recovery's
    // legitimate backward moves land here — this is the branch that keeps them working.
    return { verdict: VERDICT.ALLOW, reason: REASON.LAST_CHANGE_BY_FLEET, actorId };
  }

  const currentRank = rank.get(currentState);
  if (currentRank === undefined) {
    // Todo / Backlog / Triage / Done / an unmapped name. Unordered, so "backwards" is not a
    // question this guard can answer — and NOT answering is what lets the fleet legitimately
    // start work a human queued into Todo.
    return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.UNRANKED_CURRENT, actorId };
  }
  if (typeof targetRank !== "number") {
    return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.UNRANKED_TARGET, actorId, currentRank };
  }

  if (targetRank < currentRank) {
    return {
      verdict: VERDICT.REFUSE,
      reason: REASON.REGRESSION_AGAINST_LANE_CLAIM,
      actorId,
      currentRank,
      targetRank,
    };
  }
  return {
    verdict: VERDICT.ALLOW,
    reason: REASON.NOT_A_REGRESSION,
    actorId,
    currentRank,
    targetRank,
  };
}

/**
 * buildLaneClaimGuard — assembles the production guard from its three inputs. Returns a
 * guard object with ONE method, `evaluate({ ticket, currentState, targetState })`, so the
 * write path never has to know where any of this came from.
 *
 * ⛔ A guard whose inputs are missing is still a guard — it just answers INCONCLUSIVE, and
 * the write proceeds. This is deliberately NOT a "return null if unconfigured" factory: a
 * null guard and a guard that abstains look identical at the call site, but only the second
 * one can say WHY in a log line, and "why" is the difference between an operator seeing
 * "no bot ids configured" and seeing nothing at all.
 *
 * @param {object} o
 * @param {Record<string,string>} o.stateMap  linear key -> Linear state name
 * @param {Set<string>} o.botUserIds          known fleet actor ids
 * @param {(ticket: string) => ({actorId: string|null}|undefined)} o.readLastStateChange
 *   the newest state change on a ticket. MUST fail open (return undefined) rather than
 *   throw — a replica outage may not wedge the pipeline's writes.
 */
export function buildLaneClaimGuard({
  stateMap,
  botUserIds,
  readLastStateChange,
  // CTL-2068: the ticket's CURRENT state, for the dispatch veto (the write path already
  // holds this and passes it in; the dispatch path does not).
  readCurrentState,
  // ⛔ The operator kill switch, and it covers the DISPATCH veto only. Refusing a state
  // write is benign — the write simply does not happen and the pipeline retries. Refusing
  // a DISPATCH is not: this rides the single choke point every phase dispatch passes
  // through, so a wrong verdict there withholds work rather than merely a status write.
  // On by default (a guard nobody arms is this repo's recurring failure), but an operator
  // who needs the fleet to plough through a claim can set
  // CATALYST_LANE_CLAIM_DISPATCH_GUARD=off without giving up the write-side protection.
  dispatchVeto = true,
} = {}) {
  const rank = buildStateRank(stateMap);
  const keyRank = buildKeyRank();

  const readLast = (ticket) => {
    if (typeof readLastStateChange !== "function" || !ticket) return null;
    try {
      return readLastStateChange(ticket) ?? null;
    } catch {
      // A throwing reader is "could not look", never "nothing there".
      return null;
    }
  };

  return {
    rank,
    keyRank,
    dispatchVeto,

    // evaluate — the WRITE-path question: may the pipeline write `targetKey`'s state over
    // `currentState`? The caller supplies the current state because it has already read it.
    evaluate({ ticket, currentState, targetKey } = {}) {
      return classifyLaneClaimWrite({
        currentState,
        targetRank: keyRank.get(targetKey),
        lastChange: readLast(ticket),
        botUserIds,
        rank,
      });
    },

    // evaluateDispatch — the DISPATCH-path question: may the pipeline run `phase` on this
    // ticket at all?
    //
    // ⭐ It is deliberately the SAME question as evaluate(), asked at a different site: if
    // the pipeline is not allowed to move a ticket back to a phase's state, it has no
    // business running that phase either. Refusing the write alone would have made the
    // CTC-787 collision merely VISIBLE — the state write would fail while the worker still
    // ran and still opened the duplicate PR. One rule, two enforcement points.
    evaluateDispatch({ ticket, phase } = {}) {
      if (!dispatchVeto)
        return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.DISPATCH_VETO_DISABLED };
      const targetKey = PHASE_LINEAR_KEY[phase];
      if (!targetKey) {
        // `triage` writes no status, so there is no state to compare against. Nothing to
        // judge — and triage is where fleet work legitimately BEGINS.
        return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.PHASE_WRITES_NO_STATUS };
      }
      let currentState = null;
      if (typeof readCurrentState === "function" && ticket) {
        try {
          currentState = readCurrentState(ticket) ?? null;
        } catch {
          currentState = null;
        }
      }
      if (typeof currentState !== "string" || currentState.length === 0) {
        return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.NO_CURRENT_STATE };
      }
      return classifyLaneClaimWrite({
        currentState,
        targetRank: keyRank.get(targetKey),
        lastChange: readLast(ticket),
        botUserIds,
        rank,
      });
    },
  };
}
