// beliefs/incident-replay.mjs — CTL-935 Phase 4: incident replay harness.
// Provides frozen INCIDENTS fixtures for CTL-722, CTL-657, CTL-604 (+ cap variant)
// and replayIncident() which seeds a fresh db, evaluates beliefs, and checks assertions.
// PURE module — no live-IO, no beliefs.db, no event log.

import { evaluateBeliefs } from "./rules.mjs";

// ── NOW anchor — frozen spec §5 tick ─────────────────────────────────────────
const NOW_MS = 1781030108000; // 2026-06-09T18:35:08Z
const HOUR = 3_600_000;

// ── inline fixture seeders (mirrors rules.test.mjs but never imported from it) ─

function insertTick(db, nowMs, host = "mini") {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [nowMs, host]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function seedSignal(db, tickId, o) {
  db.run(
    "INSERT INTO obs_signal (tick_id, ticket, phase, status, bg_job_id, generation, started_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [tickId, o.ticket, o.phase, o.status ?? "running", o.bg_job_id ?? null, o.generation ?? null, o.started_at_ms ?? null, o.updated_at_ms ?? null],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function seedAgent(db, tickId, o) {
  db.run(
    "INSERT INTO obs_agent (tick_id, session_id, short_id, kind, status, state, started_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [tickId, o.session_id, o.short_id, o.kind ?? "background", o.status ?? null, o.state ?? null, o.started_at_ms ?? null],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function seedJob(db, tickId, o) {
  db.run(
    "INSERT INTO obs_job (tick_id, bg_job_id, state, tempo, detail, needs, first_terminal_at, exists_flag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [tickId, o.bg_job_id, o.state ?? null, o.tempo ?? null, o.detail ?? null, o.needs ?? null, o.first_terminal_at ?? null, o.exists_flag ?? 1],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function seedTranscript(db, tickId, o) {
  db.run(
    "INSERT INTO obs_transcript (tick_id, session_id, exists_flag, mtime_ms, bytes) VALUES (?, ?, ?, ?, ?)",
    [tickId, o.session_id, o.exists_flag, o.mtime_ms ?? null, o.bytes ?? null],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function seedVerdict(db, tickId, o) {
  db.run("INSERT INTO obs_verdict (tick_id, ticket, verdict) VALUES (?, ?, ?)", [tickId, o.ticket, o.verdict]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function seedCycle(db, tickId, o) {
  db.run("INSERT INTO obs_cycle (tick_id, ticket, remediate_count) VALUES (?, ?, ?)", [tickId, o.ticket, o.remediate_count]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}

// ── expect[] checker ──────────────────────────────────────────────────────────

// runCheck — evaluate one expect item against the belief rows. Returns {pass, ...detail}.
function runCheck(beliefs, chk) {
  const { name, subject, present = true, rule_id, valuePath, valueEquals } = chk;
  const row = beliefs.find((b) => b.name === name && b.subject === subject);
  const exists = !!row;

  if (!present) {
    return { name, subject, pass: !exists, expected: "absent", got: exists ? "present" : "absent" };
  }
  if (!exists) {
    return { name, subject, pass: false, expected: "present", got: "absent" };
  }
  if (rule_id !== undefined && row.rule_id !== rule_id) {
    return { name, subject, pass: false, expected: `rule_id=${rule_id}`, got: `rule_id=${row.rule_id}` };
  }
  if (valuePath !== undefined) {
    let actual;
    try {
      const parsed = typeof row.value === "string" ? JSON.parse(row.value) : (row.value ?? {});
      // Walk a simple $.x path
      const key = valuePath.replace(/^\$\./, "");
      actual = parsed[key];
    } catch {
      return { name, subject, pass: false, expected: `${valuePath}=${JSON.stringify(valueEquals)}`, got: "parse-error" };
    }
    if (valueEquals !== undefined && actual !== valueEquals) {
      return { name, subject, pass: false, expected: `${valuePath}=${JSON.stringify(valueEquals)}`, got: `${valuePath}=${JSON.stringify(actual)}` };
    }
  }
  return { name, subject, pass: true };
}

// ── INCIDENTS — frozen fixture catalog ────────────────────────────────────────

export const INCIDENTS = Object.freeze({
  // ── CTL-722: turn-zero wedge (9h-blocked worker, no transcript) ──────────
  "CTL-722": Object.freeze({
    id: "CTL-722",
    title: "Wedge fleet: 9h-blocked turn-zero worker",
    nowMs: NOW_MS,
    seed(db, tickId) {
      // f101 obs_signal CTL-722/plan running, bg 5ad5c1ff, started 08:56:24Z (~9h39m)
      seedSignal(db, tickId, {
        ticket: "CTL-722", phase: "plan", status: "running",
        bg_job_id: "5ad5c1ff", generation: 3,
        started_at_ms: Date.parse("2026-06-09T08:56:24Z"),
        updated_at_ms: Date.parse("2026-06-09T08:56:30Z"),
      });
      // f102 obs_agent 5ad5c1ff background, state=blocked
      seedAgent(db, tickId, {
        session_id: "5ad5c1ff-1111-2222-3333-444455556666",
        short_id: "5ad5c1ff", kind: "background", status: "idle", state: "blocked",
      });
      // f103 obs_job state=working tempo=blocked, no firstTerminalAt (wedge, NOT dead)
      seedJob(db, tickId, {
        bg_job_id: "5ad5c1ff", state: "working", tempo: "blocked",
        detail: "stuck on a startup dialog", first_terminal_at: null,
      });
      // f104 obs_transcript exists=0 (THE turn-zero discriminator)
      seedTranscript(db, tickId, {
        session_id: "5ad5c1ff-1111-2222-3333-444455556666", exists_flag: 0,
      });
    },
    expect: [
      { name: "session_registered", subject: "CTL-722/plan", present: true, rule_id: "R1" },
      { name: "turn_started", subject: "CTL-722/plan", present: false },
      { name: "worker_dead", subject: "CTL-722/plan", present: false },
      { name: "wedged_never_started", subject: "CTL-722/plan", present: true, rule_id: "R4" },
      { name: "wake_diagnostician", subject: "CTL-722/plan", present: true, rule_id: "R10", valuePath: "$.reason", valueEquals: "never-started" },
      { name: "free_slots", subject: "host:mini", present: true, valuePath: "$.by_lease", valueEquals: 6 },
      { name: "free_slots", subject: "host:mini", present: true, valuePath: "$.by_session_cap", valueEquals: 9 },
      { name: "free_slots", subject: "host:mini", present: true, valuePath: "$.free_slots", valueEquals: 6 },
      { name: "free_slots", subject: "host:mini", present: true, valuePath: "$.lease_valid_count", valueEquals: 0 },
      { name: "free_slots", subject: "host:mini", present: true, valuePath: "$.bg_session_count", valueEquals: 1 },
    ],
  }),

  // ── CTL-657: over-spawn — 6 workers dead (first_terminal_at 51-77h) ─────
  "CTL-657": Object.freeze({
    id: "CTL-657",
    title: "Over-spawn: 6 workers dead (first_terminal_at 51-77h before nowMs)",
    nowMs: NOW_MS,
    seed(db, tickId, nowMs) {
      const N = nowMs ?? NOW_MS;
      for (let i = 1; i <= 6; i++) {
        const jobId = `dead-job-${i}`;
        const sessId = `${jobId}-sess`;
        // obs_signal — status running (the daemon still lists them as in-flight)
        seedSignal(db, tickId, {
          ticket: `CTL-657-${i}`, phase: "implement", status: "running",
          bg_job_id: jobId,
          started_at_ms: N - (77 + i) * HOUR,
          updated_at_ms: N - (51 + i) * HOUR,
        });
        // obs_agent — visible in `claude agents` (that's the bug: they look alive)
        seedAgent(db, tickId, {
          session_id: sessId, short_id: jobId, kind: "background",
          status: "idle", state: "blocked",
        });
        // obs_job — first_terminal_at set (51-57h ago): definitive dead signal
        seedJob(db, tickId, {
          bg_job_id: jobId, state: "working",
          first_terminal_at: N - (51 + i) * HOUR,
        });
      }
    },
    expect: [
      // All 6 are worker_dead (R7 via first_terminal_at)
      { name: "worker_dead", subject: "CTL-657-1/implement", present: true, rule_id: "R7" },
      { name: "worker_dead", subject: "CTL-657-2/implement", present: true, rule_id: "R7" },
      { name: "worker_dead", subject: "CTL-657-3/implement", present: true, rule_id: "R7" },
      { name: "worker_dead", subject: "CTL-657-4/implement", present: true, rule_id: "R7" },
      { name: "worker_dead", subject: "CTL-657-5/implement", present: true, rule_id: "R7" },
      { name: "worker_dead", subject: "CTL-657-6/implement", present: true, rule_id: "R7" },
      // R5/R6 are both suppressed by R7
      { name: "lease_valid", subject: "CTL-657-1/implement", present: false },
      { name: "lease_expired", subject: "CTL-657-1/implement", present: false },
      // R8: 6 agents listed (bg_session_count=6), lease_valid_count=0 → free_slots=4
      { name: "free_slots", subject: "host:mini", present: true, valuePath: "$.lease_valid_count", valueEquals: 0 },
      { name: "free_slots", subject: "host:mini", present: true, valuePath: "$.bg_session_count", valueEquals: 6 },
      { name: "free_slots", subject: "host:mini", present: true, valuePath: "$.by_lease", valueEquals: 6 },
      { name: "free_slots", subject: "host:mini", present: true, valuePath: "$.by_session_cap", valueEquals: 4 },
      { name: "free_slots", subject: "host:mini", present: true, valuePath: "$.free_slots", valueEquals: 4 },
    ],
  }),

  // ── CTL-604: orphan takeover — verify→remediate detour (cap not reached) ─
  "CTL-604": Object.freeze({
    id: "CTL-604",
    title: "Orphan takeover: verify-fail advances to remediate (R16 arm A, remediate_count=0)",
    nowMs: NOW_MS,
    seed(db, tickId) {
      // verify phase is highest-rank present; status=done so R16 checks it
      seedSignal(db, tickId, {
        ticket: "CTL-604", phase: "verify", status: "done",
        bg_job_id: "verify-job-604", started_at_ms: NOW_MS - 2 * HOUR,
        updated_at_ms: NOW_MS - HOUR,
      });
      // obs_verdict: fail — triggers arm A (verify→remediate)
      seedVerdict(db, tickId, { ticket: "CTL-604", verdict: "fail" });
      // obs_cycle: remediate_count=0 < cap(3) → arm A fires, R17 absent
      seedCycle(db, tickId, { ticket: "CTL-604", remediate_count: 0 });
      // NO remediate obs_signal — arm A's last gate: no remediate already dispatched
    },
    expect: [
      { name: "advance_to", subject: "CTL-604", present: true, rule_id: "R16", valuePath: "$.to", valueEquals: "remediate" },
      { name: "cycle_exhausted", subject: "CTL-604", present: false },
    ],
  }),

  // ── CTL-604-cap: same incident but remediate_count at cap (3) → R17 ──────
  "CTL-604-cap": Object.freeze({
    id: "CTL-604-cap",
    title: "Orphan takeover: cycle exhausted (remediate_count=3 >= cap 3) — R17 fires, advance_to absent",
    nowMs: NOW_MS,
    seed(db, tickId) {
      seedSignal(db, tickId, {
        ticket: "CTL-604", phase: "verify", status: "done",
        bg_job_id: "verify-job-604-cap", started_at_ms: NOW_MS - 2 * HOUR,
        updated_at_ms: NOW_MS - HOUR,
      });
      seedVerdict(db, tickId, { ticket: "CTL-604", verdict: "fail" });
      // remediate_count = cap → arm A does NOT fire; R17 fires instead
      seedCycle(db, tickId, { ticket: "CTL-604", remediate_count: 3 });
    },
    expect: [
      { name: "advance_to", subject: "CTL-604", present: false },
      { name: "cycle_exhausted", subject: "CTL-604", present: true, rule_id: "R17" },
    ],
  }),
});

// ── replayIncident ────────────────────────────────────────────────────────────

// replayIncident(db, fixture) → { id, title, tickId, inserted, beliefs, checks, passed }
// Seeds the fixture into a FRESH tick in `db`, runs evaluateBeliefs, evaluates all
// expect[] checks, and returns structured results. Never throws — a fixture that
// can't pass returns { passed: false } rather than propagating errors.
export function replayIncident(db, fixture) {
  const { id, title, nowMs = NOW_MS, seed, expect: expects = [] } = fixture;
  try {
    const tickId = insertTick(db, nowMs, "mini");
    seed(db, tickId, nowMs);
    const { inserted } = evaluateBeliefs(db, tickId);
    const beliefs = db.query("SELECT * FROM belief WHERE tick_id = ?").all(tickId);
    const checks = expects.map((chk) => runCheck(beliefs, chk));
    const passed = checks.every((c) => c.pass);
    return { id, title, tickId, inserted, beliefs, checks, passed };
  } catch (err) {
    return { id, title, tickId: null, inserted: {}, beliefs: [], checks: [], passed: false, error: err?.message };
  }
}
