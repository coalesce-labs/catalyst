// beliefs/rules.mjs — CTL-934 belief-store Step 1: the 12 stratified Datalog
// rules (R1–R12) hand-compiled to parameterized SQL over the CTL-933 fact
// schema, with mandatory provenance (rule_id + source_fact_ids) on every
// derived belief row. Behavior-neutral SHADOW: nothing gates on beliefs.
//
// Spec: thoughts/shared/research/2026-06-09-belief-store-step1-datalog.md
//   §2 time model (now is a per-tick fact; recency = arithmetic guard; windows
//       are cfg facts; "no X within window" = stratified negation)
//   §3 the 12 rules in Datalog, 4 strata
//   §4 the SQL compilation pattern (the R4 exemplar is reproduced verbatim
//       below as the canonical shape every rule follows)
//
// ── Stratification ──────────────────────────────────────────────────────────
//   S1 ground correlations           R1 R2 R3 R7   (read obs_* only)
//   S2 liveness verdicts             R4 R5 R6 R9   (negation over S1 beliefs)
//   S3 capacity aggregation          R8            (aggregate over S2 + obs_agent)
//   S4 escalation ladder             R10 R11 R12   (negation over intent)
//
// No recursion crosses a negation. Each stratum's statements read only the
// strata strictly below it (and the obs_* EDB), so when an S2 rule's NOT EXISTS
// queries belief WHERE name='turn_started', every S1 belief for the tick has
// ALREADY been inserted — the complete-lower-stratum invariant the tests pin.
//
// Provenance contract (spec §4): source_fact_ids is a json_array of the
// fact_id / belief_id refs the rule actually consumed, built INSIDE the SELECT
// with json_array(...). Run as constants with a single bound :tick parameter
// (no SQL string concatenation).
//
// REF TAGGING (deviation from spec §4's bare integers — see PR body): belief_id,
// the per-table obs_* fact_id, the tick_id, and the intent_id are SEPARATE
// AUTOINCREMENT spaces that all start at 1, so a bare integer ref is ambiguous
// (belief #1 vs obs_signal fact #1 vs tick #1 — they genuinely collide, and the
// §5 CTE silently mis-resolves them). EACH obs_* table ALSO has its own
// AUTOINCREMENT space, so a generic 'fact' tag would still collide
// (obs_signal#1 vs obs_agent#1). Refs are therefore TAGGED with a one-char
// kind prefix, per source TABLE, so the trace is unambiguous and deterministic:
//   b belief   t tick   i intent
//   s obs_signal   a obs_agent   j obs_job   r obs_transcript
//   h obs_heartbeat   l obs_linear
// json_array values become these tagged TEXT tokens; why.mjs maps prefix→table.
//
// Subject convention:
//   per-phase beliefs   →  ticket || '/' || phase     (e.g. 'CTL-722/plan')
//   capacity beliefs    →  'host:' || host            (e.g. 'host:mini')

// ── Stratum 1: ground correlations ──────────────────────────────────────────

// R1 session_registered — the signal's bg job appears in the agents listing as
// a background session. Provenance: the signal row + the agent row.
//   session_registered(T,P,Sid) :- obs_signal(T,P,_,Job,_),
//       short_of(Job,Short), obs_agent(Sid,Short,kind:"background").
const R1_session_registered = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
SELECT t.tick_id, 1, 'session_registered', s.ticket || '/' || s.phase,
       json_object('session_id', a.session_id, 'short_id', a.short_id),
       'R1', json_array('s' || s.fact_id, 'a' || a.fact_id)
FROM tick t
JOIN obs_signal s ON s.tick_id = t.tick_id AND s.bg_job_id IS NOT NULL
JOIN obs_agent  a ON a.tick_id = t.tick_id AND a.short_id = s.bg_job_id
                 AND a.kind = 'background'
WHERE t.tick_id = :tick`;

// R2 turn_started — the registered session has a transcript: the prompt became
// a turn. Healthy sessions create it ~0.3s after spawn; wedged ones never do.
// Joins signal→agent(short_id)→transcript(session_id), exists_flag = 1.
//   turn_started(T,P) :- obs_signal(T,P,_,Job,_), session_of(Job,Sid),
//       obs_transcript(Sid, exists:1).
const R2_turn_started = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
SELECT t.tick_id, 1, 'turn_started', s.ticket || '/' || s.phase,
       json_object('session_id', a.session_id, 'bytes', tr.bytes),
       'R2', json_array('s' || s.fact_id, 'a' || a.fact_id, 'r' || tr.fact_id)
FROM tick t
JOIN obs_signal     s  ON s.tick_id = t.tick_id AND s.bg_job_id IS NOT NULL
JOIN obs_agent      a  ON a.tick_id = t.tick_id AND a.short_id = s.bg_job_id
JOIN obs_transcript tr ON tr.tick_id = t.tick_id AND tr.session_id = a.session_id
                      AND tr.exists_flag = 1
WHERE t.tick_id = :tick`;

// R3 progress_evidence — latest positive evidence of work, any channel:
// max() over worker.heartbeat ts, transcript mtime, signal updatedAt. One
// belief per phase carrying the freshest timestamp; value records which
// channel won so the lease rules (R5/R6) and `why` can explain it.
//   progress_evidence(T,P,max(Ts)) :- obs_heartbeat(T,P,_,_,Ts)
//       ; obs_transcript(session_of_signal(T,P), mtime:Ts)
//       ; obs_signal(T,P, updated_at:Ts).
//
// Compiled as a UNION ALL of the candidate channels, then the per-subject MAX.
// source_fact_ids is the json_array of every contributing fact for the chosen
// subject (the MAX picks the value; provenance keeps the full evidence set).
const R3_progress_evidence = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
WITH evidence(tick_id, subject, ts, ref, channel) AS (
  -- signal updatedAt (always present for a running phase). ref is pre-TAGGED
  -- per channel ('s'/'r'/'h') so the per-table fact_id collision can't bite.
  SELECT t.tick_id, s.ticket || '/' || s.phase, s.updated_at_ms, 's' || s.fact_id, 'signal'
  FROM tick t JOIN obs_signal s ON s.tick_id = t.tick_id
  WHERE t.tick_id = :tick AND s.updated_at_ms IS NOT NULL
  UNION ALL
  -- transcript mtime, mapped phase←signal(bg)←agent(short)→transcript(session)
  SELECT t.tick_id, s.ticket || '/' || s.phase, tr.mtime_ms, 'r' || tr.fact_id, 'transcript'
  FROM tick t
  JOIN obs_signal     s  ON s.tick_id = t.tick_id AND s.bg_job_id IS NOT NULL
  JOIN obs_agent      a  ON a.tick_id = t.tick_id AND a.short_id = s.bg_job_id
  JOIN obs_transcript tr ON tr.tick_id = t.tick_id AND tr.session_id = a.session_id
                        AND tr.exists_flag = 1 AND tr.mtime_ms IS NOT NULL
  WHERE t.tick_id = :tick
  UNION ALL
  -- worker.heartbeat ts (own time axis; matched by ticket/phase)
  SELECT t.tick_id, s.ticket || '/' || s.phase, h.ts_ms, 'h' || h.fact_id, 'heartbeat'
  FROM tick t
  JOIN obs_signal s ON s.tick_id = t.tick_id
  JOIN obs_heartbeat h ON h.ticket = s.ticket AND h.phase = s.phase
  WHERE t.tick_id = :tick
)
SELECT e.tick_id, 1, 'progress_evidence', e.subject,
       json_object('ts_ms', mx.ts),
       'R3', (SELECT json_group_array(ref) FROM evidence e2 WHERE e2.subject = e.subject)
FROM evidence e
JOIN (SELECT subject, MAX(ts) AS ts FROM evidence GROUP BY subject) mx
  ON mx.subject = e.subject AND mx.ts = e.ts
GROUP BY e.subject`;

// R7 worker_dead — CC's own durable verdict: the job dir is gone, OR
// firstTerminalAt is set, OR state ∈ {stopped,failed,done,blocked}.
//   worker_dead(T,P) :- obs_signal(T,P,_,Job,_),
//       ( obs_job(Job, exists:0)
//       ; obs_job(Job, first_terminal_at:FT), FT != null
//       ; obs_job(Job, state:S), S in [...] ).
const R7_worker_dead = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
SELECT t.tick_id, 1, 'worker_dead', s.ticket || '/' || s.phase,
       json_object('reason',
         CASE
           WHEN j.exists_flag = 0 THEN 'job_gone'
           WHEN j.first_terminal_at IS NOT NULL THEN 'first_terminal_at'
           ELSE 'state:' || j.state
         END),
       'R7', json_array('s' || s.fact_id, 'j' || j.fact_id)
FROM tick t
JOIN obs_signal s ON s.tick_id = t.tick_id AND s.bg_job_id IS NOT NULL
JOIN obs_job    j ON j.tick_id = t.tick_id AND j.bg_job_id = s.bg_job_id
WHERE t.tick_id = :tick
  AND ( j.exists_flag = 0
     OR j.first_terminal_at IS NOT NULL
     OR j.state IN ('stopped','failed','done','blocked') )`;

// ── Stratum 2: liveness verdicts (stratified negation over S1) ───────────────

// R4 wedged_never_started — registered, old enough, no turn ever started, not
// dead. THE 2026-06-09 class. cfg never_started_ms = 120000. This is the spec
// §4 exemplar reproduced verbatim (subject/provenance shape every rule copies):
//   wedged_never_started(T,P) :- session_registered(T,P,_),
//       obs_signal(T,P, started_at:S), older(S, cfg(never_started_ms)),
//       not turn_started(T,P), not worker_dead(T,P).
const R4_wedged_never_started = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, rule_id, source_fact_ids)
SELECT t.tick_id, 2, 'wedged_never_started', s.ticket || '/' || s.phase, 'R4',
       json_array('b' || sr.belief_id, 's' || s.fact_id, 't' || t.tick_id)
FROM tick t
JOIN obs_signal s ON s.tick_id = t.tick_id AND s.status = 'running'
JOIN belief sr    ON sr.tick_id = t.tick_id AND sr.name = 'session_registered'
                 AND sr.subject = s.ticket || '/' || s.phase
JOIN cfg c        ON c.key = 'never_started_ms'
WHERE t.tick_id = :tick
  AND s.started_at_ms IS NOT NULL
  AND t.now_ms - s.started_at_ms > c.value_int
  AND NOT EXISTS (SELECT 1 FROM belief b WHERE b.tick_id = t.tick_id
                  AND b.name = 'turn_started' AND b.subject = sr.subject)
  AND NOT EXISTS (SELECT 1 FROM belief b WHERE b.tick_id = t.tick_id
                  AND b.name = 'worker_dead' AND b.subject = sr.subject)`;

// R5 lease_valid — a running phase with progress evidence inside its phase-class
// window, and not dead. Windows are cfg facts (build phases 30m, doc phases
// 45m). doc phases per CTL-927/board taxonomy: triage, research, plan, pr,
// monitor-merge, monitor-deploy. Everything else (implement, verify, review,
// remediate, flat numeric phases) uses the build window.
//   lease_valid(T) :- obs_signal(T,P,status:"running"),
//       progress_evidence(T,P,Ts), not older(Ts, lease_window(P)),
//       not worker_dead(T,P).
const R5_lease_valid = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
SELECT t.tick_id, 2, 'lease_valid', s.ticket || '/' || s.phase,
       json_object('evidence_ts_ms', CAST(json_extract(pe.value, '$.ts_ms') AS INTEGER),
                   'window_ms', win.value_int),
       'R5', json_array('b' || pe.belief_id, 's' || s.fact_id, 't' || t.tick_id)
FROM tick t
JOIN obs_signal s ON s.tick_id = t.tick_id AND s.status = 'running'
JOIN belief pe    ON pe.tick_id = t.tick_id AND pe.name = 'progress_evidence'
                 AND pe.subject = s.ticket || '/' || s.phase
JOIN cfg win ON win.key = CASE
      WHEN s.phase IN ('triage','research','plan','pr','monitor-merge','monitor-deploy')
        THEN 'lease_window_doc_ms' ELSE 'lease_window_build_ms' END
WHERE t.tick_id = :tick
  AND t.now_ms - CAST(json_extract(pe.value, '$.ts_ms') AS INTEGER) <= win.value_int
  AND NOT EXISTS (SELECT 1 FROM belief b WHERE b.tick_id = t.tick_id
                  AND b.name = 'worker_dead' AND b.subject = s.ticket || '/' || s.phase)`;

// R6 lease_expired — a running phase that is NOT lease_valid and NOT dead:
// evidence is stale (or never existed). Stratified negation over R5 (same
// stratum — R5 inserts before R6 in the run order, so the NOT EXISTS sees the
// complete lease_valid set for the tick).
//   lease_expired(T,P) :- obs_signal(T,P,status:"running"),
//       not lease_valid(T), not worker_dead(T,P).
const R6_lease_expired = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, rule_id, source_fact_ids)
SELECT t.tick_id, 2, 'lease_expired', s.ticket || '/' || s.phase, 'R6',
       json_array('s' || s.fact_id, 't' || t.tick_id)
FROM tick t
JOIN obs_signal s ON s.tick_id = t.tick_id AND s.status = 'running'
WHERE t.tick_id = :tick
  AND NOT EXISTS (SELECT 1 FROM belief b WHERE b.tick_id = t.tick_id
                  AND b.name = 'lease_valid' AND b.subject = s.ticket || '/' || s.phase)
  AND NOT EXISTS (SELECT 1 FROM belief b WHERE b.tick_id = t.tick_id
                  AND b.name = 'worker_dead' AND b.subject = s.ticket || '/' || s.phase)`;

// R9 board_drift — Linear disagrees with the durable running signal state.
// Write-side dual of CTL-929. Terminal Done exempt per CTL-758. We record the
// drift (have vs want) without re-deriving the full state map: the belief
// fires when a phase is running but Linear's read-back state is non-null,
// non-terminal, and not a recognized in-flight state for that phase.
//   board_drift(T,Want) :- obs_signal(T,P,status:"running"),
//       linear_key_for(P,Want), obs_linear(T,Have), Have != Want,
//       not linear_terminal(Have).
//
// linear_key_for(phase) maps the active phase to the Linear state it implies.
// Done/Canceled are terminal and exempt (never backward-written).
const R9_board_drift = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
SELECT t.tick_id, 2, 'board_drift', s.ticket,
       json_object('have', l.state, 'want', want.k, 'phase', s.phase),
       'R9', json_array('s' || s.fact_id, 'l' || l.fact_id)
FROM tick t
JOIN obs_signal s ON s.tick_id = t.tick_id AND s.status = 'running'
JOIN obs_linear l ON l.tick_id = t.tick_id AND l.ticket = s.ticket
                 AND l.state IS NOT NULL
JOIN (SELECT 'triage' AS phase, 'Research' AS k UNION ALL
      SELECT 'research','Research' UNION ALL
      SELECT 'plan','Plan' UNION ALL
      SELECT 'implement','Implement' UNION ALL
      SELECT 'verify','Validate' UNION ALL
      SELECT 'review','Validate' UNION ALL
      SELECT 'remediate','Validate' UNION ALL
      SELECT 'pr','PR' UNION ALL
      SELECT 'monitor-merge','PR' UNION ALL
      SELECT 'monitor-deploy','PR') want ON want.phase = s.phase
WHERE t.tick_id = :tick
  AND l.state <> want.k
  AND l.state NOT IN ('Done','Canceled','Cancelled')`;

// ── Stratum 3: capacity aggregation ─────────────────────────────────────────

// R8 free_slots — leases are the capacity unit; the session cap is the
// over-spawn guard (counts ALL registered background sessions, wedged or not).
// ONE belief per host, value records BOTH bounds separately — the decision
// record for admission that replaces today's silent slots-full branch.
//   free_slots = max(0, min(cfg(max_parallel) - count{lease_valid},
//                           cfg(session_cap)  - count{bg agents})).
const R8_free_slots = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
SELECT t.tick_id, 3, 'free_slots', 'host:' || t.host,
       json_object(
         'free_slots', MAX(0, MIN(mp.value_int - lv.n, sc.value_int - bg.n)),
         'by_lease',   mp.value_int - lv.n,
         'by_session_cap', sc.value_int - bg.n,
         'max_parallel', mp.value_int,
         'session_cap', sc.value_int,
         'lease_valid_count', lv.n,
         'bg_session_count', bg.n),
       'R8',
       json_array(
         (SELECT json_group_array('b' || belief_id) FROM belief
            WHERE tick_id = t.tick_id AND name = 'lease_valid'),
         (SELECT json_group_array('a' || fact_id) FROM obs_agent
            WHERE tick_id = t.tick_id AND kind = 'background'))
FROM tick t
JOIN cfg mp ON mp.key = 'max_parallel'
JOIN cfg sc ON sc.key = 'session_cap'
JOIN (SELECT COUNT(*) AS n FROM belief
        WHERE tick_id = :tick AND name = 'lease_valid') lv
JOIN (SELECT COUNT(*) AS n FROM obs_agent
        WHERE tick_id = :tick AND kind = 'background') bg
WHERE t.tick_id = :tick`;

// ── Stratum 4: escalation ladder (stratified negation over intent) ───────────

// R10 wake_diagnostician — states we cannot resolve deterministically; the
// daemon detects, the agent interprets (CTL-792 Layer-4, expressed as a rule).
// Cooldown is itself a fact (intent rows), so storms are structurally
// impossible (CTL-638 by construction).
//   wake_diagnostician(T,P,"never-started") :- wedged_never_started(T,P),
//       not recent_intent("wake-diagnostician",T,P,cfg(diag_cooldown_ms)).
//   wake_diagnostician(T,P,"stalled-alive") :- lease_expired(T,P),
//       obs_job(job_of(T,P), state:"working"),
//       not recent_intent("wake-diagnostician",T,P,cfg(diag_cooldown_ms)).
//
// recent_intent: an intent kind='wake-diagnostician' for the same subject whose
// tick is within diag_cooldown_ms of now. cfg(diag_cooldown_ms) defaults below.
const R10a_wake_diagnostician_never_started = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
SELECT t.tick_id, 4, 'wake_diagnostician', w.subject,
       json_object('reason', 'never-started'),
       'R10', json_array('b' || w.belief_id)
FROM tick t
JOIN belief w ON w.tick_id = t.tick_id AND w.name = 'wedged_never_started'
WHERE t.tick_id = :tick
  AND NOT EXISTS (
    SELECT 1 FROM intent i JOIN tick it ON it.tick_id = i.tick_id, cfg c
    WHERE c.key = 'diag_cooldown_ms'
      AND i.kind = 'wake-diagnostician' AND i.subject = w.subject
      AND t.now_ms - it.now_ms <= c.value_int)`;

const R10b_wake_diagnostician_stalled_alive = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
SELECT t.tick_id, 4, 'wake_diagnostician', le.subject,
       json_object('reason', 'stalled-alive'),
       'R10', json_array('b' || le.belief_id, 'j' || j.fact_id)
FROM tick t
JOIN belief le ON le.tick_id = t.tick_id AND le.name = 'lease_expired'
JOIN obs_signal s ON s.tick_id = t.tick_id AND s.ticket || '/' || s.phase = le.subject
JOIN obs_job   j  ON j.tick_id = t.tick_id AND j.bg_job_id = s.bg_job_id
                 AND j.state = 'working'
WHERE t.tick_id = :tick
  AND NOT EXISTS (SELECT 1 FROM belief b WHERE b.tick_id = t.tick_id
                  AND b.name = 'wake_diagnostician' AND b.subject = le.subject)
  AND NOT EXISTS (
    SELECT 1 FROM intent i JOIN tick it ON it.tick_id = i.tick_id, cfg c
    WHERE c.key = 'diag_cooldown_ms'
      AND i.kind = 'wake-diagnostician' AND i.subject = le.subject
      AND t.now_ms - it.now_ms <= c.value_int)`;

// R11 action_ineffective — we acted, the world didn't change: an intent with
// attempts >= cfg(max_attempts) and no outcome. Kills the 8-hour stop-storm
// class (2 attempts, no observed effect → stop retrying this channel).
//   action_ineffective(Kind,Subj) :- intent(Kind,Subj,attempts:N,outcome:null),
//       N >= cfg(max_attempts).
// CTL-962: the reconciler (intent.mjs) deliberately LEAVES outcome NULL at the
// cap (it no longer flips to 'ineffective'), so this `outcome IS NULL` predicate
// keeps matching until escalate.mjs pages once and flips outcome='escalated'.
const R11_action_ineffective = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
SELECT t.tick_id, 4, 'action_ineffective', i.kind || ':' || i.subject,
       json_object('kind', i.kind, 'attempts', i.attempts),
       'R11', json_array('i' || i.intent_id)
FROM tick t
JOIN cfg c ON c.key = 'max_attempts'
JOIN intent i ON i.outcome IS NULL AND i.attempts >= c.value_int
WHERE t.tick_id = :tick`;

// R12 escalate_human — second line: the diagnostician already ran (or its
// action was ineffective) and the state persists. needs-human is now a
// CONCLUSION with a provenance chain, not a label write lost in a branch.
//   escalate_human(T,P,Why) :- ( diagnosis_unresolved(T,P,Why)
//       ; wake_diagnostician(T,P,Why), action_ineffective("wake-diagnostician",T/P) ).
//
// Branch implemented: wake_diagnostician fired AND its action is ineffective
// (the deterministic, fact-grounded arm; diagnosis_unresolved needs the
// diagnostician runner's verdict, out of Step-1 scope).
const R12_escalate_human = `
INSERT OR IGNORE INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
SELECT t.tick_id, 4, 'escalate_human', wd.subject,
       json_object('why', json_extract(wd.value, '$.reason')),
       'R12', json_array('b' || wd.belief_id, 'b' || ai.belief_id)
FROM tick t
JOIN belief wd ON wd.tick_id = t.tick_id AND wd.name = 'wake_diagnostician'
JOIN belief ai ON ai.tick_id = t.tick_id AND ai.name = 'action_ineffective'
              AND ai.subject = 'wake-diagnostician:' || wd.subject
WHERE t.tick_id = :tick`;

// STRATA — the run order. Each inner array is one stratum; statements within a
// stratum run in array order (R6 after R5; R10b after R10a) so same-stratum
// negation sees the complete lower set. The tick loop runs strata in order
// inside the existing transaction.
export const STRATA = [
  // S1 ground correlations
  [
    ["R1", R1_session_registered],
    ["R2", R2_turn_started],
    ["R3", R3_progress_evidence],
    ["R7", R7_worker_dead],
  ],
  // S2 liveness verdicts (negation over S1)
  [
    ["R4", R4_wedged_never_started],
    ["R5", R5_lease_valid],
    ["R6", R6_lease_expired],
    ["R9", R9_board_drift],
  ],
  // S3 capacity aggregation
  [["R8", R8_free_slots]],
  // S4 escalation ladder (negation over intent)
  [
    ["R10a", R10a_wake_diagnostician_never_started],
    ["R10b", R10b_wake_diagnostician_stalled_alive],
    ["R11", R11_action_ineffective],
    ["R12", R12_escalate_human],
  ],
];

// CFG_SEED additions the rules need beyond schema.mjs's CFG_SEED. openBeliefsDb
// seeds the schema set; evaluateBeliefs INSERT OR IGNOREs these so an existing
// db gains them without clobbering operator-tuned values.
export const RULE_CFG_SEED = [
  ["diag_cooldown_ms", 600000], // 10m — wake-diagnostician cooldown (CTL-638)
  ["max_attempts", 2], // R11 — 2 ineffective attempts → escalate (CTL stop-storm)
];

// evaluateBeliefs — run all four strata over ONE tick, inside the caller's
// transaction. Pure given the tick row's facts (no clock read; recency uses
// tick.now_ms via the SQL). Returns { inserted } counts per rule_id for the
// shadow-comparison log. NEVER opens/commits/rolls back — the collector owns
// the transaction so facts + beliefs land atomically.
export function evaluateBeliefs(db, tickId) {
  // Ensure rule-only cfg exists (idempotent; never clobbers tuned values).
  const seed = db.prepare("INSERT OR IGNORE INTO cfg (key, value_int) VALUES (?, ?)");
  for (const [key, valueInt] of RULE_CFG_SEED) seed.run(key, valueInt);

  const inserted = {};
  for (const stratum of STRATA) {
    for (const [ruleId, sql] of stratum) {
      const before = db.query("SELECT COUNT(*) AS n FROM belief WHERE tick_id = ?").get(tickId).n;
      db.query(sql).run({ ":tick": tickId });
      const after = db.query("SELECT COUNT(*) AS n FROM belief WHERE tick_id = ?").get(tickId).n;
      inserted[ruleId] = after - before;
    }
  }
  return { inserted };
}
