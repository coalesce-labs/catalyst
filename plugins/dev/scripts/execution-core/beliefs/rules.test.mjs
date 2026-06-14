// rules.test.mjs — CTL-934 belief-store Step 1: the 12 stratified rules.
//
// Every test seeds the EXACT obs_* fixture facts into a fresh in-memory schema,
// runs evaluateBeliefs over ONE tick with FROZEN time (now is an injected tick
// fact, spec §2), and asserts the derived belief rows — name, subject, rule_id,
// and the source_fact_ids provenance chain — against hand-computed expectations.
//
// The keystone is the full §5 CTL-722 fixture: signal running 9h / agent
// state=blocked / job tempo=blocked / transcript exists=0 must derive
// R1 → ¬R2 → ¬R7 → R4 → R8(both bounds) → R10 with a verifiable provenance chain.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { evaluateBeliefs } from "./rules.mjs";

const NOW = 1781030108000; // spec §5 tick: 2026-06-09T18:35:08Z
const HOUR = 3_600_000;
const MIN = 60_000;

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl934-rules-"));
  tmps.push(d);
  return d;
}
let db;
beforeEach(() => {
  db = openBeliefsDb({ path: join(scratch(), "b.db") });
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  while (tmps.length) {
    try {
      rmSync(tmps.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── fixture builders (return the inserted fact_id so provenance is checkable) ──
function tick(now = NOW, host = "mini") {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [now, host]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function signal(tickId, o) {
  db.run(
    `INSERT INTO obs_signal (tick_id, ticket, phase, status, bg_job_id, generation, started_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tickId,
      o.ticket,
      o.phase,
      o.status ?? "running",
      o.bg_job_id ?? null,
      o.generation ?? null,
      o.started_at_ms ?? null,
      o.updated_at_ms ?? null,
    ],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function agent(tickId, o) {
  db.run(
    `INSERT INTO obs_agent (tick_id, session_id, short_id, kind, status, state, started_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      tickId,
      o.session_id,
      o.short_id,
      o.kind ?? "background",
      o.status ?? null,
      o.state ?? null,
      o.started_at_ms ?? null,
    ],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function job(tickId, o) {
  db.run(
    `INSERT INTO obs_job (tick_id, bg_job_id, state, tempo, detail, needs, first_terminal_at, exists_flag)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tickId,
      o.bg_job_id,
      o.state ?? null,
      o.tempo ?? null,
      o.detail ?? null,
      o.needs ?? null,
      o.first_terminal_at ?? null,
      o.exists_flag ?? 1,
    ],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function transcript(tickId, o) {
  db.run(
    "INSERT INTO obs_transcript (tick_id, session_id, exists_flag, mtime_ms, bytes) VALUES (?, ?, ?, ?, ?)",
    [tickId, o.session_id, o.exists_flag, o.mtime_ms ?? null, o.bytes ?? null],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function heartbeat(o) {
  db.run(
    "INSERT INTO obs_heartbeat (ticket, phase, generation, kind, ts_ms) VALUES (?, ?, ?, ?, ?)",
    [o.ticket, o.phase, o.generation ?? null, o.kind ?? "tool", o.ts_ms],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function linear(tickId, ticket, state) {
  db.run("INSERT INTO obs_linear (tick_id, ticket, state) VALUES (?, ?, ?)", [tickId, ticket, state]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function intent(tickId, o) {
  db.run(
    "INSERT INTO intent (tick_id, kind, subject, attempts, outcome) VALUES (?, ?, ?, ?, ?)",
    [tickId, o.kind, o.subject, o.attempts ?? 0, o.outcome ?? null],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}

function beliefs(name) {
  const sql = name
    ? "SELECT * FROM belief WHERE name = ? ORDER BY subject"
    : "SELECT * FROM belief ORDER BY stratum, name, subject";
  return name ? db.query(sql).all(name) : db.query(sql).all();
}
function oneBelief(name, subject) {
  return db.query("SELECT * FROM belief WHERE name = ? AND subject = ?").get(name, subject);
}

// ── S1 ───────────────────────────────────────────────────────────────────────
describe("S1 ground correlations", () => {
  test("R1 session_registered: signal bg job present in agents listing", () => {
    const t = tick();
    const fSig = signal(t, { ticket: "CTL-1", phase: "plan", bg_job_id: "abc1" });
    const fAg = agent(t, { session_id: "abc1-sid", short_id: "abc1", kind: "background" });
    evaluateBeliefs(db, t);
    const b = oneBelief("session_registered", "CTL-1/plan");
    expect(b).toBeTruthy();
    expect(b.rule_id).toBe("R1");
    expect(b.stratum).toBe(1);
    expect(JSON.parse(b.source_fact_ids).sort()).toEqual([`s${fSig}`, `a${fAg}`].sort());
  });

  test("R1 does NOT fire when the agent is not background", () => {
    const t = tick();
    signal(t, { ticket: "CTL-1", phase: "plan", bg_job_id: "abc1" });
    agent(t, { session_id: "abc1-sid", short_id: "abc1", kind: "interactive" });
    evaluateBeliefs(db, t);
    expect(beliefs("session_registered")).toHaveLength(0);
  });

  test("R2 turn_started: registered session has a transcript (exists=1)", () => {
    const t = tick();
    const fSig = signal(t, { ticket: "CTL-1", phase: "plan", bg_job_id: "abc1" });
    const fAg = agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    const fTr = transcript(t, { session_id: "abc1-sid", exists_flag: 1, mtime_ms: NOW - MIN, bytes: 99 });
    evaluateBeliefs(db, t);
    const b = oneBelief("turn_started", "CTL-1/plan");
    expect(b.rule_id).toBe("R2");
    expect(JSON.parse(b.source_fact_ids).sort()).toEqual([`s${fSig}`, `a${fAg}`, `r${fTr}`].sort());
  });

  test("R2 does NOT fire when transcript exists_flag=0", () => {
    const t = tick();
    signal(t, { ticket: "CTL-1", phase: "plan", bg_job_id: "abc1" });
    agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    transcript(t, { session_id: "abc1-sid", exists_flag: 0 });
    evaluateBeliefs(db, t);
    expect(beliefs("turn_started")).toHaveLength(0);
  });

  test("R3 progress_evidence: max() across signal/transcript/heartbeat channels", () => {
    const t = tick();
    const fSig = signal(t, {
      ticket: "CTL-1",
      phase: "implement",
      bg_job_id: "abc1",
      updated_at_ms: NOW - 5 * MIN,
    });
    const fAg = agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    const fTr = transcript(t, { session_id: "abc1-sid", exists_flag: 1, mtime_ms: NOW - 2 * MIN });
    const fHb = heartbeat({ ticket: "CTL-1", phase: "implement", kind: "commit", ts_ms: NOW - 1 * MIN });
    evaluateBeliefs(db, t);
    const b = oneBelief("progress_evidence", "CTL-1/implement");
    expect(b.rule_id).toBe("R3");
    // heartbeat is the freshest → value carries its ts
    expect(JSON.parse(b.value).ts_ms).toBe(NOW - 1 * MIN);
    // provenance keeps ALL contributing facts, not just the winner
    expect(JSON.parse(b.source_fact_ids).sort()).toEqual([`s${fSig}`, `r${fTr}`, `h${fHb}`].sort());
    expect(fAg).toBeGreaterThan(0); // agent is the mapping hop, not a provenance leaf for R3
  });

  test("R7 worker_dead fires on each terminal signal independently", () => {
    const t = tick();
    signal(t, { ticket: "CTL-A", phase: "plan", bg_job_id: "ja", status: "running" });
    signal(t, { ticket: "CTL-B", phase: "plan", bg_job_id: "jb", status: "running" });
    signal(t, { ticket: "CTL-C", phase: "plan", bg_job_id: "jc", status: "running" });
    signal(t, { ticket: "CTL-D", phase: "plan", bg_job_id: "jd", status: "running" });
    job(t, { bg_job_id: "ja", exists_flag: 0 }); // job gone
    job(t, { bg_job_id: "jb", state: "working", first_terminal_at: "2026-06-09T10:00:00Z" });
    job(t, { bg_job_id: "jc", state: "failed" }); // terminal state
    job(t, { bg_job_id: "jd", state: "working" }); // alive → NOT dead
    evaluateBeliefs(db, t);
    const dead = beliefs("worker_dead").map((b) => b.subject).sort();
    expect(dead).toEqual(["CTL-A/plan", "CTL-B/plan", "CTL-C/plan"]);
    expect(JSON.parse(oneBelief("worker_dead", "CTL-A/plan").value).reason).toBe("job_gone");
    expect(JSON.parse(oneBelief("worker_dead", "CTL-B/plan").value).reason).toBe("first_terminal_at");
    expect(JSON.parse(oneBelief("worker_dead", "CTL-C/plan").value).reason).toBe("state:failed");
  });
});

// ── S2 ───────────────────────────────────────────────────────────────────────
describe("S2 liveness verdicts (stratified negation over S1)", () => {
  test("R4 wedged_never_started: registered, old, ¬turn_started, ¬worker_dead", () => {
    const t = tick(NOW);
    const fSig = signal(t, {
      ticket: "CTL-1",
      phase: "plan",
      status: "running",
      bg_job_id: "abc1",
      started_at_ms: NOW - 9 * HOUR, // ≫ never_started_ms (120s)
    });
    agent(t, { session_id: "abc1-sid", short_id: "abc1" }); // → R1 fires
    job(t, { bg_job_id: "abc1", state: "working" }); // alive → ¬R7
    // no transcript row → ¬R2
    evaluateBeliefs(db, t);
    const b = oneBelief("wedged_never_started", "CTL-1/plan");
    expect(b.rule_id).toBe("R4");
    expect(b.stratum).toBe(2);
    const sr = oneBelief("session_registered", "CTL-1/plan");
    // spec §4 exemplar provenance: [session_registered.belief_id, signal.fact_id, tick_id]
    expect(JSON.parse(b.source_fact_ids)).toEqual([`b${sr.belief_id}`, `s${fSig}`, `t${t}`]);
  });

  test("R4 SUPPRESSED when turn_started (sees the complete S1 stratum)", () => {
    const t = tick(NOW);
    signal(t, { ticket: "CTL-1", phase: "plan", status: "running", bg_job_id: "abc1", started_at_ms: NOW - 9 * HOUR });
    agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    transcript(t, { session_id: "abc1-sid", exists_flag: 1, mtime_ms: NOW - MIN }); // → R2 fires
    evaluateBeliefs(db, t);
    expect(beliefs("turn_started")).toHaveLength(1);
    expect(beliefs("wedged_never_started")).toHaveLength(0); // negation honored
  });

  test("R4 SUPPRESSED when worker_dead, and when too young", () => {
    // dead
    let t = tick(NOW);
    signal(t, { ticket: "CTL-1", phase: "plan", status: "running", bg_job_id: "j1", started_at_ms: NOW - 9 * HOUR });
    agent(t, { session_id: "s1", short_id: "j1" });
    job(t, { bg_job_id: "j1", state: "failed" });
    evaluateBeliefs(db, t);
    expect(beliefs("wedged_never_started")).toHaveLength(0);
    // too young (60s < 120s never_started_ms)
    t = tick(NOW);
    signal(t, { ticket: "CTL-2", phase: "plan", status: "running", bg_job_id: "j2", started_at_ms: NOW - 60_000 });
    agent(t, { session_id: "s2", short_id: "j2" });
    job(t, { bg_job_id: "j2", state: "working" });
    evaluateBeliefs(db, t);
    expect(beliefs("wedged_never_started").filter((b) => b.subject === "CTL-2/plan")).toHaveLength(0);
  });

  test("R5 lease_valid: running with recent progress evidence inside the window", () => {
    const t = tick(NOW);
    const fSig = signal(t, {
      ticket: "CTL-1",
      phase: "implement", // build window 30m
      status: "running",
      bg_job_id: "abc1",
      updated_at_ms: NOW - 5 * MIN, // recent
    });
    agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    job(t, { bg_job_id: "abc1", state: "working" });
    evaluateBeliefs(db, t);
    const b = oneBelief("lease_valid", "CTL-1/implement");
    expect(b.rule_id).toBe("R5");
    expect(JSON.parse(b.value).window_ms).toBe(1800000); // build window
    const pe = oneBelief("progress_evidence", "CTL-1/implement");
    expect(JSON.parse(b.source_fact_ids)).toContain(`b${pe.belief_id}`);
    expect(fSig).toBeGreaterThan(0);
  });

  test("R5 uses the DOC window for doc-class phases (plan)", () => {
    const t = tick(NOW);
    signal(t, { ticket: "CTL-1", phase: "plan", status: "running", bg_job_id: "abc1", updated_at_ms: NOW - 40 * MIN });
    agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    evaluateBeliefs(db, t);
    // 40m stale: would EXPIRE under the 30m build window, but plan gets 45m doc.
    const b = oneBelief("lease_valid", "CTL-1/plan");
    expect(b).toBeTruthy();
    expect(JSON.parse(b.value).window_ms).toBe(2700000);
  });

  test("R6 lease_expired: running, ¬lease_valid, ¬worker_dead (negation over R5, same stratum)", () => {
    const t = tick(NOW);
    signal(t, {
      ticket: "CTL-1",
      phase: "implement",
      status: "running",
      bg_job_id: "abc1",
      updated_at_ms: NOW - 2 * HOUR, // ≫ 30m build window → stale
    });
    agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    job(t, { bg_job_id: "abc1", state: "working" }); // alive → ¬R7
    evaluateBeliefs(db, t);
    expect(beliefs("lease_valid")).toHaveLength(0);
    const b = oneBelief("lease_expired", "CTL-1/implement");
    expect(b.rule_id).toBe("R6");
  });

  test("R6 SUPPRESSED when lease_valid; SUPPRESSED when worker_dead", () => {
    // valid lease → no expired
    let t = tick(NOW);
    signal(t, { ticket: "CTL-1", phase: "implement", status: "running", bg_job_id: "j1", updated_at_ms: NOW - MIN });
    agent(t, { session_id: "s1", short_id: "j1" });
    evaluateBeliefs(db, t);
    expect(beliefs("lease_valid")).toHaveLength(1);
    expect(beliefs("lease_expired")).toHaveLength(0);
    // dead → neither expired nor valid (R7 wins)
    t = tick(NOW);
    signal(t, { ticket: "CTL-2", phase: "implement", status: "running", bg_job_id: "j2", updated_at_ms: NOW - 2 * HOUR });
    agent(t, { session_id: "s2", short_id: "j2" });
    job(t, { bg_job_id: "j2", state: "stopped" });
    evaluateBeliefs(db, t);
    expect(beliefs("lease_expired").filter((b) => b.subject === "CTL-2/implement")).toHaveLength(0);
  });

  test("R9 board_drift: Linear disagrees with the running phase; terminal Done exempt", () => {
    const t = tick(NOW);
    const fS1 = signal(t, { ticket: "CTL-1", phase: "implement", status: "running", bg_job_id: "j1" });
    const fL1 = linear(t, "CTL-1", "Plan"); // running implement but board says Plan → drift
    signal(t, { ticket: "CTL-2", phase: "implement", status: "running", bg_job_id: "j2" });
    linear(t, "CTL-2", "Done"); // terminal → exempt
    signal(t, { ticket: "CTL-3", phase: "implement", status: "running", bg_job_id: "j3" });
    linear(t, "CTL-3", "Implement"); // agrees → no drift
    evaluateBeliefs(db, t);
    const drift = beliefs("board_drift");
    expect(drift.map((b) => b.subject)).toEqual(["CTL-1"]);
    expect(JSON.parse(drift[0].value)).toMatchObject({ have: "Plan", want: "Implement" });
    expect(JSON.parse(drift[0].source_fact_ids).sort()).toEqual([`s${fS1}`, `l${fL1}`].sort());
  });
});

// ── S3 ───────────────────────────────────────────────────────────────────────
describe("S3 capacity aggregation", () => {
  test("R8 free_slots reports by_lease and by_session_cap SEPARATELY", () => {
    const t = tick(NOW);
    // 2 valid leases, 4 background sessions registered (incl wedged ones).
    for (let i = 1; i <= 2; i++) {
      signal(t, { ticket: `CTL-${i}`, phase: "implement", status: "running", bg_job_id: `liv${i}`, updated_at_ms: NOW - MIN });
      agent(t, { session_id: `s-liv${i}`, short_id: `liv${i}`, kind: "background" });
    }
    // 2 more background agents that are NOT leaseholders (wedged / idle)
    agent(t, { session_id: "s-w1", short_id: "w1", kind: "background" });
    agent(t, { session_id: "s-w2", short_id: "w2", kind: "background" });
    evaluateBeliefs(db, t);
    const b = oneBelief("free_slots", "host:mini");
    expect(b.rule_id).toBe("R8");
    expect(b.stratum).toBe(3);
    const v = JSON.parse(b.value);
    expect(v.lease_valid_count).toBe(2);
    expect(v.bg_session_count).toBe(4);
    expect(v.by_lease).toBe(6 - 2); // max_parallel 6 − leases 2 = 4
    expect(v.by_session_cap).toBe(10 - 4); // session_cap 10 − bg 4 = 6
    expect(v.free_slots).toBe(4); // min(4, 6)
  });

  test("R8 the §5 drain scenario: 6 wedged sessions, 0 leases → min(6-0, 10-6)=4 (board drains)", () => {
    const t = tick(NOW);
    for (let i = 1; i <= 6; i++) {
      // running but evidence is ancient → no lease; plenty old enough but here
      // we just want zero leases and six bg sessions.
      signal(t, { ticket: `CTL-${i}`, phase: "plan", status: "running", bg_job_id: `j${i}`, updated_at_ms: NOW - 10 * HOUR });
      agent(t, { session_id: `s${i}`, short_id: `j${i}`, kind: "background" });
    }
    evaluateBeliefs(db, t);
    const v = JSON.parse(oneBelief("free_slots", "host:mini").value);
    expect(v.lease_valid_count).toBe(0);
    expect(v.bg_session_count).toBe(6);
    expect(v.by_lease).toBe(6);
    expect(v.by_session_cap).toBe(4);
    expect(v.free_slots).toBe(4); // min(6, 4) — the board drains instead of starving
  });

  test("R8 clamps free_slots at 0 (never negative)", () => {
    const t = tick(NOW);
    // 12 background sessions, 0 leases → by_session_cap = 10-12 = -2 → clamp 0.
    for (let i = 1; i <= 12; i++) agent(t, { session_id: `s${i}`, short_id: `j${i}`, kind: "background" });
    evaluateBeliefs(db, t);
    const v = JSON.parse(oneBelief("free_slots", "host:mini").value);
    expect(v.by_session_cap).toBe(-2);
    expect(v.free_slots).toBe(0);
  });
});

// ── S4 ───────────────────────────────────────────────────────────────────────
describe("S4 escalation ladder (negation over intent)", () => {
  test("R10 wake_diagnostician('never-started') from R4, no recent intent", () => {
    const t = tick(NOW);
    signal(t, { ticket: "CTL-1", phase: "plan", status: "running", bg_job_id: "abc1", started_at_ms: NOW - 9 * HOUR });
    agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    job(t, { bg_job_id: "abc1", state: "working" });
    evaluateBeliefs(db, t);
    const b = oneBelief("wake_diagnostician", "CTL-1/plan");
    expect(b.rule_id).toBe("R10");
    expect(b.stratum).toBe(4);
    expect(JSON.parse(b.value).reason).toBe("never-started");
    const wns = oneBelief("wedged_never_started", "CTL-1/plan");
    expect(JSON.parse(b.source_fact_ids)).toEqual([`b${wns.belief_id}`]);
  });

  test("R10 SUPPRESSED by a recent wake-diagnostician intent (cooldown fact)", () => {
    const t = tick(NOW);
    signal(t, { ticket: "CTL-1", phase: "plan", status: "running", bg_job_id: "abc1", started_at_ms: NOW - 9 * HOUR });
    agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    job(t, { bg_job_id: "abc1", state: "working" });
    // a wake-diagnostician intent from THIS tick (within 10m cooldown)
    intent(t, { kind: "wake-diagnostician", subject: "CTL-1/plan" });
    evaluateBeliefs(db, t);
    expect(beliefs("wedged_never_started")).toHaveLength(1); // R4 still fires
    expect(beliefs("wake_diagnostician")).toHaveLength(0); // R10 cooled down
  });

  test("R10 wake_diagnostician('stalled-alive') from R6 + job state=working", () => {
    const t = tick(NOW);
    signal(t, { ticket: "CTL-1", phase: "implement", status: "running", bg_job_id: "abc1", updated_at_ms: NOW - 2 * HOUR });
    agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    job(t, { bg_job_id: "abc1", state: "working" }); // alive but stalled
    evaluateBeliefs(db, t);
    expect(beliefs("lease_expired")).toHaveLength(1);
    const b = oneBelief("wake_diagnostician", "CTL-1/implement");
    expect(JSON.parse(b.value).reason).toBe("stalled-alive");
  });

  test("R11 action_ineffective: intent with attempts >= max_attempts and null outcome", () => {
    const t = tick(NOW);
    const i1 = intent(t, { kind: "wake-diagnostician", subject: "CTL-1/plan", attempts: 2, outcome: null });
    intent(t, { kind: "kill", subject: "CTL-2/plan", attempts: 1, outcome: null }); // below threshold
    intent(t, { kind: "kill", subject: "CTL-3/plan", attempts: 5, outcome: "done" }); // resolved
    evaluateBeliefs(db, t);
    const b = beliefs("action_ineffective");
    expect(b.map((x) => x.subject)).toEqual(["wake-diagnostician:CTL-1/plan"]);
    expect(b[0].rule_id).toBe("R11");
    expect(JSON.parse(b[0].source_fact_ids)).toEqual([`i${i1}`]);
  });

  test("R12 escalate_human: wake_diagnostician fired AND its action is ineffective", () => {
    const t = tick(NOW);
    // a fresh wedge → R4 → R10 fires THIS tick. But to fire R10 we must NOT
    // have a recent intent; the ineffective intent is what R11/R12 key off.
    // Use the stalled-alive arm with a non-cooldown'd PRIOR-tick intent so R10
    // still fires while R11 sees attempts>=2.
    const prior = tick(NOW - 20 * MIN); // older than 10m cooldown
    intent(prior, { kind: "wake-diagnostician", subject: "CTL-1/implement", attempts: 2, outcome: null });
    signal(t, { ticket: "CTL-1", phase: "implement", status: "running", bg_job_id: "abc1", updated_at_ms: NOW - 2 * HOUR });
    agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    job(t, { bg_job_id: "abc1", state: "working" });
    evaluateBeliefs(db, t);
    const wd = oneBelief("wake_diagnostician", "CTL-1/implement");
    expect(wd).toBeTruthy(); // prior intent is 20m old > 10m cooldown → R10 fires
    const ai = oneBelief("action_ineffective", "wake-diagnostician:CTL-1/implement");
    expect(ai).toBeTruthy();
    const esc = oneBelief("escalate_human", "CTL-1/implement");
    expect(esc.rule_id).toBe("R12");
    expect(JSON.parse(esc.value).why).toBe("stalled-alive");
    expect(JSON.parse(esc.source_fact_ids).sort()).toEqual([`b${wd.belief_id}`, `b${ai.belief_id}`].sort());
  });
});

// ── KEYSTONE: the full §5 CTL-722 fixture, replayed ───────────────────────────
describe("KEYSTONE — §5 CTL-722 why-trace, replayed from recorded facts", () => {
  test("f101–f104 derive R1 → ¬R2 → ¬R7 → R4 → R8(both bounds) → R10, provenance verified", () => {
    const t = tick(NOW, "mini"); // 2026-06-09T18:35:08Z
    // f101 obs_signal CTL-722/plan running, bg 5ad5c1ff, started 08:56:24Z (~9h39m)
    const f101 = signal(t, {
      ticket: "CTL-722",
      phase: "plan",
      status: "running",
      bg_job_id: "5ad5c1ff",
      generation: 3,
      started_at_ms: Date.parse("2026-06-09T08:56:24Z"),
      updated_at_ms: Date.parse("2026-06-09T08:56:30Z"),
    });
    // f102 obs_agent 5ad5c1ff background, status idle, state=blocked
    const f102 = agent(t, {
      session_id: "5ad5c1ff-1111-2222-3333-444455556666",
      short_id: "5ad5c1ff",
      kind: "background",
      status: "idle",
      state: "blocked",
    });
    // f103 obs_job 5ad5c1ff state=working tempo=blocked, firstTerminalAt=null
    const f103 = job(t, {
      bg_job_id: "5ad5c1ff",
      state: "working",
      tempo: "blocked",
      detail: "stuck on a startup dialog",
      first_terminal_at: null,
    });
    // f104 obs_transcript exists=0 (THE turn-zero discriminator)
    const f104 = transcript(t, {
      session_id: "5ad5c1ff-1111-2222-3333-444455556666",
      exists_flag: 0,
    });

    const { inserted } = evaluateBeliefs(db, t);

    // R1 session_registered ← {f101, f102} → b1
    const b1 = oneBelief("session_registered", "CTL-722/plan");
    expect(b1.rule_id).toBe("R1");
    expect(JSON.parse(b1.source_fact_ids).sort()).toEqual([`s${f101}`, `a${f102}`].sort());

    // R2 turn_started: NO row (f104 exists=0)
    expect(beliefs("turn_started")).toHaveLength(0);
    expect(inserted.R2).toBe(0);

    // R7 worker_dead: NO row (state=working, no firstTerminalAt)
    expect(beliefs("worker_dead")).toHaveLength(0);

    // R4 wedged_never_started ← {b1, f101, tick} → b2
    const b2 = oneBelief("wedged_never_started", "CTL-722/plan");
    expect(b2.rule_id).toBe("R4");
    expect(JSON.parse(b2.source_fact_ids)).toEqual([`b${b1.belief_id}`, `s${f101}`, `t${t}`]);

    // R8 free_slots reports BOTH bounds separately (one wedged bg session, 0 leases)
    const slots = JSON.parse(oneBelief("free_slots", "host:mini").value);
    expect(slots.lease_valid_count).toBe(0);
    expect(slots.bg_session_count).toBe(1);
    expect(slots.by_lease).toBe(6 - 0);
    expect(slots.by_session_cap).toBe(10 - 1);
    expect(slots.free_slots).toBe(6); // min(6, 9)

    // R10 wake_diagnostician('never-started') ← {b2} → intent-worthy belief
    const b3 = oneBelief("wake_diagnostician", "CTL-722/plan");
    expect(b3.rule_id).toBe("R10");
    expect(JSON.parse(b3.value).reason).toBe("never-started");
    expect(JSON.parse(b3.source_fact_ids)).toEqual([`b${b2.belief_id}`]);

    // The full provenance CHAIN: b3 ← b2 ← b1 ← {f101, f102}; b2 also ← f101,tick.
    expect(JSON.parse(b3.source_fact_ids)).toContain(`b${b2.belief_id}`);
    expect(JSON.parse(b2.source_fact_ids)).toContain(`b${b1.belief_id}`);
    expect(f103).toBeGreaterThan(0); // f103 informs R7's NON-firing (state=working)
    expect(f104).toBeGreaterThan(0); // f104 informs R2's NON-firing (exists=0)
  });
});

// ── stratified-negation soundness ─────────────────────────────────────────────
describe("stratified negation correctness", () => {
  test("S2 sees the COMPLETE S1 belief set — no rule reads a half-populated stratum", () => {
    // Two phases of one ticket in one tick: A is wedged (no transcript), B has a
    // transcript. If R4 ran before R2 fully populated turn_started, A could be
    // misclassified or B leak a wedge. Assert the clean split.
    const t = tick(NOW);
    signal(t, { ticket: "CTL-1", phase: "plan", status: "running", bg_job_id: "ja", started_at_ms: NOW - 9 * HOUR });
    agent(t, { session_id: "sa", short_id: "ja" });
    job(t, { bg_job_id: "ja", state: "working" });
    signal(t, { ticket: "CTL-1", phase: "implement", status: "running", bg_job_id: "jb", started_at_ms: NOW - 9 * HOUR });
    agent(t, { session_id: "sb", short_id: "jb" });
    job(t, { bg_job_id: "jb", state: "working" });
    transcript(t, { session_id: "sb", exists_flag: 1, mtime_ms: NOW - MIN });
    evaluateBeliefs(db, t);
    expect(beliefs("session_registered").map((b) => b.subject).sort()).toEqual([
      "CTL-1/implement",
      "CTL-1/plan",
    ]);
    expect(beliefs("turn_started").map((b) => b.subject)).toEqual(["CTL-1/implement"]);
    // only the no-transcript phase is wedged
    expect(beliefs("wedged_never_started").map((b) => b.subject)).toEqual(["CTL-1/plan"]);
  });

  test("'no progress within window' = derive-positive(R5)-then-negate(R6)", () => {
    // Same phase-class, two tickets: one recent (lease_valid), one stale
    // (lease_expired). R6 must derive ONLY for the one R5 did not cover.
    const t = tick(NOW);
    signal(t, { ticket: "CTL-1", phase: "implement", status: "running", bg_job_id: "j1", updated_at_ms: NOW - MIN });
    agent(t, { session_id: "s1", short_id: "j1" });
    signal(t, { ticket: "CTL-2", phase: "implement", status: "running", bg_job_id: "j2", updated_at_ms: NOW - 2 * HOUR });
    agent(t, { session_id: "s2", short_id: "j2" });
    job(t, { bg_job_id: "j2", state: "working" });
    evaluateBeliefs(db, t);
    expect(beliefs("lease_valid").map((b) => b.subject)).toEqual(["CTL-1/implement"]);
    expect(beliefs("lease_expired").map((b) => b.subject)).toEqual(["CTL-2/implement"]);
  });

  test("frozen time: re-running the SAME tick is idempotent (INSERT OR IGNORE), beliefs stable", () => {
    const t = tick(NOW);
    signal(t, { ticket: "CTL-1", phase: "plan", status: "running", bg_job_id: "abc1", started_at_ms: NOW - 9 * HOUR });
    agent(t, { session_id: "abc1-sid", short_id: "abc1" });
    job(t, { bg_job_id: "abc1", state: "working" });
    const first = evaluateBeliefs(db, t);
    const countAfterFirst = db.query("SELECT COUNT(*) AS n FROM belief").get().n;
    const second = evaluateBeliefs(db, t);
    const countAfterSecond = db.query("SELECT COUNT(*) AS n FROM belief").get().n;
    expect(countAfterSecond).toBe(countAfterFirst); // no duplicates
    expect(first.inserted.R4).toBe(1);
    expect(second.inserted.R4).toBe(0); // already present
  });
});
