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
  FLEET_IDENTITY_UNRECOGNIZED: "fleet-identity-not-observed-on-this-ticket",
  DISPATCH_VETO_DISABLED: "dispatch-veto-disabled",
  NO_CURRENT_STATE: "current-state-unreadable",
  PHASE_WRITES_NO_STATUS: "phase-writes-no-status",
  // CTL-2070 — the timely per-ticket actor source (fleet write-ledger). Two verdicts…
  TIMELY_FLEET_OWNS: "timely-fleet-owns-current-state",
  TIMELY_LANE_CLAIM: "timely-lane-claim-regression",
  // …and the diagnostic reasons classifyTimelyOwnership returns so an operator can tell
  // WHY the timely source did or did not fire (each names one branch of the model).
  LEDGER_UNAVAILABLE: "fleet-write-ledger-unavailable",
  NO_CURRENT_TIMESTAMP: "current-updated-at-unreadable",
  NO_FLEET_WRITE: "fleet-never-wrote-this-ticket",
  FLEET_WRITE_SUPERSEDES: "fleet-write-newer-than-replica-observation",
  FLEET_WROTE_CURRENT: "fleet-write-matches-current-state",
  FOREIGN_AFTER_FLEET: "foreign-move-after-fleet-write",
  OUTSIDE_TIMELY_WINDOW: "current-state-older-than-recency-bound",
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
 * classifyTimelyOwnership — pure. CTL-2070. Answers ONE question — "who established the state
 * the ticket is in RIGHT NOW?" — from three TIMELY inputs, none of which is the ~201 s-lagged
 * `issue_history` table the legacy ladder leans on.
 *
 * ⛔ WHY A TIMELY SOURCE AT ALL. CTL-1847 measured the two feeds this guard straddles:
 * `issues.state` is webhook-fed and lands in ~11 s, while `issue_history` is reconcile-only and
 * lands in ~201 s — an ~18× gap. CTL-2068 made the guard HONEST across that gap (STALE_HISTORY
 * declines a history row whose to_state disagrees with the current state) but honest means it
 * ABSTAINS for the ~200 s right after a claim — the exact 74 s window CTC-787 collided in — and
 * it can see no actor at all for the 140 fleet tickets that carry no history rows. This source
 * fills that window from the daemon's OWN write-ledger: the fleet knows every state it set,
 * because it set it, so it needs no history rows and is independent of `botUserIds`.
 *
 * The verdict is three-valued exactly like `fleetEverWroteState`, and ONLY ever produces a
 * positive `fleet`/`lane` on evidence — on any doubt it returns `unknown` so the caller falls
 * through to the entire existing ladder verbatim.
 *
 * @param {object} o
 * @param {string|null} o.currentState the ticket's state right now (a NAME), from `issues.state`.
 * @param {number|undefined} o.currentUpdatedAtMs `issues.updated_at` epoch-ms — the timely
 *   observation the supersession test compares the fleet's write against. Not a number (reader
 *   miss/throw) → the test can't run → `unknown`; never refuse without it.
 * @param {{toState: string|null, atMs: number}|null|undefined} o.fleetWrite the durable ledger
 *   entry for this ticket. `undefined` = ledger reader unavailable/threw (→ `unknown`, fall
 *   through). `null` = the durable ledger has NO entry, the fleet never wrote this ticket (→
 *   `lane`). An entry = the supersession test.
 * @param {number|undefined} o.nowMs wall clock for the recency bound; omitted → bound skipped.
 * @param {number|undefined} o.recencyMs the timely window; omitted → bound skipped. When both
 *   are present and `nowMs - currentUpdatedAtMs > recencyMs`, the ledger is no longer
 *   authoritative (the now-caught-up `issue_history` ladder should govern) → `unknown`.
 * @returns {{owner: "fleet"|"lane"|"unknown", effectiveCurrentState?: string|null, reason: string}}
 */
export function classifyTimelyOwnership({
  currentState,
  currentUpdatedAtMs,
  fleetWrite,
  nowMs,
  recencyMs,
} = {}) {
  // `undefined` is the "could not look" sentinel — the ledger reader was absent or threw. Never
  // an objection; fall through to today's ladder.
  if (fleetWrite === undefined) return { owner: "unknown", reason: REASON.LEDGER_UNAVAILABLE };
  // The supersession test is the heart of this classifier and it cannot run without the timely
  // observation. No timestamp → no verdict (never refuse on a missing clock).
  if (typeof currentUpdatedAtMs !== "number" || !Number.isFinite(currentUpdatedAtMs)) {
    return { owner: "unknown", reason: REASON.NO_CURRENT_TIMESTAMP };
  }
  // ⚠️ Recency bound (config, default on) — the ledger is authoritative ONLY while
  // `issue_history` is still lagging. Past the window the ladder has caught up and should
  // govern, so an entry that would otherwise say `lane` yields `unknown` here. Bounds the new
  // REFUSE to the exact window the ticket cares about and shrinks a lost/pruned entry's blast
  // radius to tickets moved in the last few minutes. Skipped when either clock input is absent
  // (pure tests omit them).
  if (
    typeof nowMs === "number" &&
    typeof recencyMs === "number" &&
    nowMs - currentUpdatedAtMs > recencyMs
  ) {
    return { owner: "unknown", reason: REASON.OUTSIDE_TIMELY_WINDOW };
  }
  // `null` = a DURABLE "no entry": the fleet never wrote this ticket, so whoever set the current
  // state is not the fleet → a lane owns it. This is the branch that covers the 140 history-less
  // tickets the legacy ladder is blind to.
  if (fleetWrite === null) {
    return { owner: "lane", effectiveCurrentState: currentState, reason: REASON.NO_FLEET_WRITE };
  }
  // An entry: the supersession test. `atMs` is the fleet write's own timestamp.
  const toState = fleetWrite.toState ?? null;
  const atMs = fleetWrite.atMs;
  // ⛔ THE TRAP THIS TICKET NAMES. A naive `toState === currentState` equality would REFUSE the
  // fleet's own in-flight write here: the fleet just wrote `toState` but the replica's
  // `issues.state` has not caught up (its own ~11 s write-propagation delay), so `currentState`
  // is still the OLD value. The fleet's write is newer than the observation → it owns the
  // soon-to-be current state; the effective current state is what the fleet just set.
  if (typeof atMs === "number" && atMs > currentUpdatedAtMs) {
    return { owner: "fleet", effectiveCurrentState: toState, reason: REASON.FLEET_WRITE_SUPERSEDES };
  }
  // The observation is at/after the fleet's write. If they agree, the fleet owns the current
  // state (its recovery/re-run move — verify⇄remediate, L3 recreate — is not a lane claim).
  if (toState === currentState) {
    return {
      owner: "fleet",
      effectiveCurrentState: currentState,
      reason: REASON.FLEET_WROTE_CURRENT,
    };
  }
  // The observation is at/after the fleet's write AND differs — a foreign actor moved it after
  // the fleet last did. A lane owns the current state.
  return { owner: "lane", effectiveCurrentState: currentState, reason: REASON.FOREIGN_AFTER_FLEET };
}

/**
 * judgeRegression — pure. The shared `targetRank < currentRank` comparison + result shaping, so
 * the timely-lane and the legacy rank REFUSE paths cannot drift (CTL-2070 refactor).
 */
function judgeRegression(currentRank, targetRank, actorId, refuseReason) {
  if (targetRank < currentRank) {
    return { verdict: VERDICT.REFUSE, reason: refuseReason, actorId, currentRank, targetRank };
  }
  return { verdict: VERDICT.ALLOW, reason: REASON.NOT_A_REGRESSION, actorId, currentRank, targetRank };
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
 * @param {boolean|undefined} o.fleetSeen POSITIVE CONTROL — has any KNOWN fleet id authored a
 *   state change on this ticket? `false` makes the guard abstain (it cannot tell the fleet
 *   from a lane here). `undefined` means the caller did not check, and is treated as "no
 *   objection" so existing callers are unaffected.
 * @param {{toState: string|null, atMs: number}|null|undefined} o.fleetWrite CTL-2070 — the
 *   durable fleet write-ledger entry for this ticket (see classifyTimelyOwnership). `undefined`
 *   (the default) makes the timely block a no-op, so every CTL-2068 caller is unaffected.
 * @param {number|undefined} o.currentUpdatedAtMs CTL-2070 — `issues.updated_at` epoch-ms.
 * @param {number|undefined} o.nowMs CTL-2070 — wall clock for the recency bound.
 * @param {number|undefined} o.recencyMs CTL-2070 — the timely-window bound.
 * @returns {{verdict: string, reason: string, currentRank?: number, targetRank?: number,
 *            actorId?: string|null, effectiveCurrentState?: string|null}}
 */
export function classifyLaneClaimWrite({
  currentState,
  targetRank,
  lastChange,
  botUserIds,
  rank,
  fleetSeen,
  fleetWrite,
  currentUpdatedAtMs,
  nowMs,
  recencyMs,
} = {}) {
  if (!(rank instanceof Map)) return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.BAD_INPUT };

  // ⭐ CTL-2070: the TIMELY source runs FIRST — before the NO_BOT_IDS gate — because the
  // write-ledger is a `botUserIds`-INDEPENDENT discriminator (it identifies the fleet by its own
  // writes, not by an app-actor id set), so it must work even when `botUserIds` is misconfigured,
  // the live CTL-2074 condition. It only ever produces a verdict on POSITIVE evidence; on `unknown`
  // the entire existing ladder below runs verbatim. `fleetWrite === undefined` (no caller wired
  // the source) short-circuits to `unknown`, so every CTL-2068 test passes unchanged.
  if (fleetWrite !== undefined) {
    const timely = classifyTimelyOwnership({
      currentState,
      currentUpdatedAtMs,
      fleetWrite,
      nowMs,
      recencyMs,
    });
    if (timely.owner === "fleet") {
      // The fleet's own recovery/re-run move (verify⇄remediate, L3 recreate) is not a lane claim.
      return {
        verdict: VERDICT.ALLOW,
        reason: REASON.TIMELY_FLEET_OWNS,
        effectiveCurrentState: timely.effectiveCurrentState ?? null,
      };
    }
    if (timely.owner === "lane") {
      const effective = timely.effectiveCurrentState ?? currentState;
      const currentRank = rank.get(effective);
      if (currentRank === undefined) {
        // Todo/Backlog/… — the fleet legitimately starts human-queued work; not a regression
        // this guard can answer, so abstain (same rule as the legacy UNRANKED_CURRENT below).
        return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.UNRANKED_CURRENT };
      }
      if (typeof targetRank !== "number") {
        return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.UNRANKED_TARGET, currentRank };
      }
      return judgeRegression(currentRank, targetRank, null, REASON.TIMELY_LANE_CLAIM);
    }
    // owner === "unknown" → fall through to the unchanged CTL-2068 ladder.
  }

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
  // ⛔⛔ POSITIVE CONTROL — can this guard tell the fleet from a lane ON THIS TICKET AT ALL?
  //
  // The whole verdict rests on "actorId ∈ botUserIds means the fleet". If the fleet's real
  // writing identity is not IN that set, every actor reads as a lane and the guard refuses
  // the fleet's own legitimate backward moves. That is not hypothetical — it was the live
  // state of the fleet when this guard first shipped. Measured on the replica, CTL tickets,
  // recent window:
  //
  //     c2a8cc92…  Ryan Rozich      103 state changes
  //     78f8f491…  Catalyst Cloud    11 state changes
  //     botUserIds = { 6dd38c1a…, ba2989f1… }   ← NEITHER of the two that actually write
  //
  // Those two ids are the host's legacy DIRECT-write app-actors; since CTL-1889 the hosts
  // write THROUGH the cloud proxy, which presents the cloud's app-actor instead. So the set
  // named two identities that never write and omitted the one that does.
  //
  // A guard whose discriminator cannot discriminate must not act. `fleetSeen` is the caller's
  // answer to "has any KNOWN fleet id authored a state change on this ticket?" — when it is
  // false the guard has no evidence it can tell the two apart here, and abstains. When the
  // set is correct this is true for any ticket the pipeline has touched, so the guard arms
  // itself exactly where it has the evidence to be right.
  if (fleetSeen === false) {
    return { verdict: VERDICT.INCONCLUSIVE, reason: REASON.FLEET_IDENTITY_UNRECOGNIZED, actorId };
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

  return judgeRegression(currentRank, targetRank, actorId, REASON.REGRESSION_AGAINST_LANE_CLAIM);
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
  // The DEFAULT map, used when no per-ticket resolver is supplied (tests, and any host with
  // a single project).
  stateMap,
  // ⛔ CTL-2068 (Codex P1): the per-TICKET map. A fleet registry holds several teams, each
  // with its own repoRoot and its own `.catalyst/config.json` — and `linear-write.mjs`
  // resolves repoRoot PER TICKET and hands that project's config to linear-transition.sh,
  // including its higher-precedence per-project overrides. Installing one map process-wide
  // therefore judged every team but the first against the wrong names: usually the current
  // state is simply unranked and the guard goes inconclusive, but where two teams reuse a
  // name at DIFFERENT phases it could veto a valid transition. The guard must rank a ticket
  // against the same map the writer will use for it.
  //
  // (ticket) => { stateMap, source } — ranks are cached per resolved source below, so a
  // registry read happens once per team, not once per evaluation.
  stateMapForTicket,
  botUserIds,
  readLastStateChange,
  // CTL-2068: the ticket's CURRENT state, for the dispatch veto (the write path already
  // holds this and passes it in; the dispatch path does not).
  readCurrentState,
  // CTL-2068 positive control: (ticket, botUserIds) => boolean|undefined — has a KNOWN
  // fleet id ever authored a state change on this ticket? See classifyLaneClaimWrite.
  readFleetSeen,
  // ⛔ The operator kill switch, and it covers the DISPATCH veto only. Refusing a state
  // write is benign — the write simply does not happen and the pipeline retries. Refusing
  // a DISPATCH is not: this rides the single choke point every phase dispatch passes
  // through, so a wrong verdict there withholds work rather than merely a status write.
  // On by default (a guard nobody arms is this repo's recurring failure), but an operator
  // who needs the fleet to plough through a claim can set
  // CATALYST_LANE_CLAIM_DISPATCH_GUARD=off without giving up the write-side protection.
  dispatchVeto = true,
} = {}) {
  const defaultRank = buildStateRank(stateMap);
  const keyRank = buildKeyRank();

  // source label -> rank map. The label, not the ticket, is the cache key: many tickets share
  // one project, and a project's map does not change within a daemon lifetime.
  const rankCache = new Map();
  const rankFor = (ticket) => {
    if (typeof stateMapForTicket !== "function" || !ticket) return defaultRank;
    let resolved;
    try {
      resolved = stateMapForTicket(ticket);
    } catch {
      return defaultRank; // a throwing resolver must not wedge a write
    }
    const label = resolved?.source ?? "none";
    if (!rankCache.has(label)) rankCache.set(label, buildStateRank(resolved?.stateMap));
    return rankCache.get(label);
  };

  const readFleet = (ticket) => {
    if (typeof readFleetSeen !== "function" || !ticket) return undefined;
    try {
      return readFleetSeen(ticket, botUserIds);
    } catch {
      return undefined; // "could not look" — never an objection, never a licence
    }
  };

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
    // `rank` is the DEFAULT map's rank. ⛔ Callers reporting how many states the guard can
    // actually rank must read THIS, never the raw stateMap's key count — buildStateRank
    // deliberately drops todo/backlog/triage/done, so a map of only those keys is nonzero
    // while the rank is empty. That is the false-healthy this whole PR exists to expose
    // (Codex P2).
    rank: defaultRank,
    keyRank,
    rankFor,
    dispatchVeto,

    // evaluate — the WRITE-path question: may the pipeline write `targetKey`'s state over
    // `currentState`? The caller supplies the current state because it has already read it.
    evaluate({ ticket, currentState, targetKey } = {}) {
      return classifyLaneClaimWrite({
        currentState,
        targetRank: keyRank.get(targetKey),
        lastChange: readLast(ticket),
        botUserIds,
        rank: rankFor(ticket),
        fleetSeen: readFleet(ticket),
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
        rank: rankFor(ticket),
        fleetSeen: readFleet(ticket),
      });
    },
  };
}
