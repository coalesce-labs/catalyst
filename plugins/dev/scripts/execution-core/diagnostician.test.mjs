// diagnostician.test.mjs — CTL-937: TDD tests for the diagnostician wiring.
//
// Coverage:
//  1. wake_diagnostician belief (never-started) → diagnostician runs once,
//     captures evidence (fake 'claude logs' returns the 'Unknown command'
//     banner), records the wake intent in beliefs.db
//  2. Cooldown → does NOT re-run next tick for the same subject
//  3. Unresolved/ineffective → needs-human applied WITH evidence attached,
//     NOT before the diagnostician ran
//  4. Stalled-alive variant (lease_expired + job state="working")
//  5. Gating flag OFF → no diagnostician runs (pure shadow of the belief)
//
// All tests use frozen time (tick rows) and injected fakes — no real process
// spawning, no real DB on disk, no real 'claude logs' invocation.
//
// The diagnostician wiring reads wake_diagnostician beliefs from beliefs.db
// (the CTL-933/934 SQLite store, already opened by the caller). It does NOT
// depend on CTL-936's intent reconciler; it reads belief rows directly.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./beliefs/schema.mjs";
import { evaluateBeliefs } from "./beliefs/rules.mjs";
import {
  processDiagnosticianWakes,
  __resetDiagnosticianForTests,
} from "./diagnostician.mjs";

// ── frozen time ───────────────────────────────────────────────────────────
const NOW = 1781030108000; // 2026-06-09T18:35:08Z
const HOUR = 3_600_000;
const MIN = 60_000;

// ── test directory management ─────────────────────────────────────────────
const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl937-diag-"));
  tmps.push(d);
  return d;
}

let db;
beforeEach(() => {
  db = openBeliefsDb({ path: join(scratch(), "b.db") });
  __resetDiagnosticianForTests();
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

// ── fixture builders (mirror rules.test.mjs patterns) ────────────────────
function insertTick(now = NOW, host = "mini") {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [now, host]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function insertSignal(tickId, o) {
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
function insertAgent(tickId, o) {
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
function insertJob(tickId, o) {
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
function insertHeartbeat(o) {
  db.run(
    "INSERT INTO obs_heartbeat (ticket, phase, generation, kind, ts_ms) VALUES (?, ?, ?, ?, ?)",
    [o.ticket, o.phase, o.generation ?? null, o.kind ?? "tool", o.ts_ms],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}

// Seed a tick such that R4 (wedged_never_started) fires for CTL-T1/plan.
// Signal running for >never_started_ms (default 2min); agent registered; no
// transcript; job not terminal. Returns { tickId, bgJobId, sessionId, shortId }.
function seedNeverStartedTick({ now = NOW, ticket = "CTL-T1", phase = "plan" } = {}) {
  const bgJobId = `abc${ticket.replace(/\W/g, "")}`;
  const sessionId = `${bgJobId}-session`;
  const shortId = bgJobId.slice(0, 8);
  const tickId = insertTick(now);
  // Signal started 10 min ago — well past never_started_ms (120s)
  insertSignal(tickId, {
    ticket,
    phase,
    bg_job_id: shortId,
    started_at_ms: now - 10 * MIN,
    updated_at_ms: now - 10 * MIN,
  });
  // Agent registered as background, state blocked
  insertAgent(tickId, {
    session_id: sessionId,
    short_id: shortId,
    kind: "background",
    state: "blocked",
  });
  // Job exists, state=working, tempo=blocked (the 2026-06-09 class)
  insertJob(tickId, {
    bg_job_id: shortId,
    state: "working",
    tempo: "blocked",
    detail: "stuck on a startup dialog",
    needs: "open this session to continue setup",
  });
  // No transcript → R2 (turn_started) will NOT fire → R4 fires
  evaluateBeliefs(db, tickId);
  return { tickId, bgJobId: shortId, sessionId, shortId, ticket, phase };
}

// Seed a tick such that R10b (stalled-alive / lease_expired + job working) fires.
// Signal has progress evidence (stale), transcript EXISTS (so R4 never-started
// does NOT fire — agent started its turn), lease is expired (stale evidence).
// R10b fires: lease_expired AND job.state="working" AND NOT wake_diagnostician yet.
function seedStalledAliveTick({ now = NOW, ticket = "CTL-T2", phase = "implement" } = {}) {
  const bgJobId = `xyz${ticket.replace(/\W/g, "")}`;
  const shortId = bgJobId.slice(0, 8);
  const sessionId = `${shortId}-sess`;
  const tickId = insertTick(now);
  // Signal running; progress evidence is 2 hours stale (build window is 30min)
  insertSignal(tickId, {
    ticket,
    phase,
    bg_job_id: shortId,
    started_at_ms: now - 3 * HOUR,
    updated_at_ms: now - 2 * HOUR,
  });
  insertAgent(tickId, {
    session_id: sessionId,
    short_id: shortId,
    kind: "background",
    state: "blocked",
  });
  insertJob(tickId, {
    bg_job_id: shortId,
    state: "working",
    tempo: "blocked",
  });
  // Transcript EXISTS → R2 (turn_started) fires → R4 (wedged_never_started) does NOT fire
  // This ensures R10b (stalled-alive) fires instead of R10a (never-started)
  db.run(
    "INSERT INTO obs_transcript (tick_id, session_id, exists_flag, mtime_ms, bytes) VALUES (?, ?, ?, ?, ?)",
    [tickId, sessionId, 1, now - 2 * HOUR, 1234],
  );
  // Heartbeat exists but is stale (> lease_window_build_ms = 30min)
  insertHeartbeat({ ticket, phase, ts_ms: now - 2 * HOUR });
  evaluateBeliefs(db, tickId);
  return { tickId, bgJobId: shortId, shortId, ticket, phase };
}

// Helper: read all intent rows for a given kind+subject
function getIntents(kind, subject) {
  return db.query("SELECT * FROM intent WHERE kind = ? AND subject = ?").all(kind, subject);
}

// Helper: seed a prior wake-diagnostician intent for a subject (simulates
// cooldown: a previous tick fired and recorded the intent)
function seedPriorIntent(subject, priorNowMs = NOW - 5 * MIN) {
  const priorTickId = insertTick(priorNowMs);
  db.run(
    "INSERT INTO intent (tick_id, kind, subject, attempts, outcome) VALUES (?, ?, ?, ?, ?)",
    [priorTickId, "wake-diagnostician", subject, 1, null],
  );
}

// ── Fake evidence-capture that simulates 'claude logs <id>' returning
// the "Unknown command" banner (the 2026-06-09 wedge signature).
function fakeCaptureLogs(shortId) {
  return `⏺ Unknown command: /catalyst-dev:phase-plan\n⏺ Args from unknown skill: CTL-T1 --orch-dir /home/user/catalyst\nCtx: 0\n`;
}

// Fake job-state reader (no disk access)
function fakeReadJobState(bgJobId) {
  return {
    exists: true,
    state: "working",
    tempo: "blocked",
    detail: "stuck on a startup dialog",
    needs: "open this session to continue setup",
  };
}

// ── TESTS ─────────────────────────────────────────────────────────────────

describe("gating flag OFF", () => {
  test("no diagnostician runs when CATALYST_DIAGNOSTICIAN is unset", () => {
    const { tickId, shortId, ticket, phase } = seedNeverStartedTick();
    const subject = `${ticket}/${phase}`;

    // Confirm belief exists (shadow layer works)
    const wakeBeliefs = db
      .query("SELECT * FROM belief WHERE name = 'wake_diagnostician'")
      .all();
    expect(wakeBeliefs.length).toBeGreaterThan(0);

    // Run without the env flag set
    const result = processDiagnosticianWakes(db, tickId, {
      env: {},
      captureLogs: fakeCaptureLogs,
      readJobState: fakeReadJobState,
      applyNeedsHuman: () => {},
    });

    expect(result.skipped).toBe("disabled");
    expect(result.ran).toBeUndefined();
    // No intent recorded when gated off
    const intents = getIntents("wake-diagnostician", subject);
    expect(intents).toHaveLength(0);
  });

  test("no diagnostician runs when CATALYST_DIAGNOSTICIAN=0", () => {
    const { tickId, ticket, phase } = seedNeverStartedTick();
    const result = processDiagnosticianWakes(db, tickId, {
      env: { CATALYST_DIAGNOSTICIAN: "0" },
      captureLogs: fakeCaptureLogs,
      readJobState: fakeReadJobState,
      applyNeedsHuman: () => {},
    });
    expect(result.skipped).toBe("disabled");
  });
});

describe("never-started wake → diagnostician runs once, captures evidence", () => {
  test("processes a wake_diagnostician(never-started) belief and records intent", () => {
    const { tickId, shortId, ticket, phase } = seedNeverStartedTick();
    const subject = `${ticket}/${phase}`;

    const captured = [];
    const result = processDiagnosticianWakes(db, tickId, {
      env: { CATALYST_DIAGNOSTICIAN: "1" },
      captureLogs: (id) => {
        captured.push(id);
        return fakeCaptureLogs(id);
      },
      readJobState: fakeReadJobState,
      applyNeedsHuman: () => {},
    });

    // One diagnostician ran
    expect(result.ran).toHaveLength(1);
    expect(result.ran[0].subject).toBe(subject);
    expect(result.ran[0].reason).toBe("never-started");

    // Captured the 'claude logs' output for the short ID
    expect(captured).toContain(shortId);

    // Evidence is in the result
    const ev = result.ran[0].evidence;
    expect(ev.logsOutput).toContain("Unknown command");
    expect(ev.jobState.state).toBe("working");
    expect(ev.jobState.tempo).toBe("blocked");

    // Wake-diagnostician intent recorded in beliefs.db (the cooldown guard key)
    const intents = getIntents("wake-diagnostician", subject);
    expect(intents).toHaveLength(1);
    expect(intents[0].attempts).toBe(1);
    // Intent carries the postcondition for the reconciler
    expect(intents[0].postcondition).toBeTruthy();
  });

  test("exactly one wake intent is created per subject (not one per belief row)", () => {
    // Two ticks with beliefs for the same subject — only one intent expected
    const { tickId, ticket, phase } = seedNeverStartedTick({ now: NOW });
    const subject = `${ticket}/${phase}`;

    // Second tick with the same subject (simulates the same worker on next tick)
    const tickId2 = insertTick(NOW + 30 * 1000);
    insertSignal(tickId2, {
      ticket,
      phase,
      bg_job_id: "abcCTLT1",
      started_at_ms: NOW - 10 * MIN,
      updated_at_ms: NOW - 10 * MIN,
    });
    insertAgent(tickId2, { session_id: "abcCTLT1-session", short_id: "abcCTLT1", kind: "background" });
    insertJob(tickId2, { bg_job_id: "abcCTLT1", state: "working", tempo: "blocked" });
    evaluateBeliefs(db, tickId2);

    // Run on tick 1 → intent created
    processDiagnosticianWakes(db, tickId, {
      env: { CATALYST_DIAGNOSTICIAN: "1" },
      captureLogs: fakeCaptureLogs,
      readJobState: fakeReadJobState,
      applyNeedsHuman: () => {},
    });
    const intentsAfterTick1 = getIntents("wake-diagnostician", subject);
    expect(intentsAfterTick1).toHaveLength(1);
  });
});

describe("cooldown — does NOT re-run next tick for the same subject", () => {
  test("skips subject when a recent wake-diagnostician intent exists within cooldown window", () => {
    const { tickId, ticket, phase } = seedNeverStartedTick({ now: NOW });
    const subject = `${ticket}/${phase}`;

    // Simulate a prior intent (5 min ago — within 10min cooldown)
    seedPriorIntent(subject, NOW - 5 * MIN);

    const captured = [];
    const result = processDiagnosticianWakes(db, tickId, {
      env: { CATALYST_DIAGNOSTICIAN: "1" },
      captureLogs: (id) => {
        captured.push(id);
        return fakeCaptureLogs(id);
      },
      readJobState: fakeReadJobState,
      applyNeedsHuman: () => {},
    });

    // No new diagnostician runs (cooldown guards it)
    expect(result.ran ?? []).toHaveLength(0);
    expect(result.cooled).toBeDefined();
    expect(result.cooled).toContain(subject);

    // 'claude logs' was NOT invoked
    expect(captured).toHaveLength(0);

    // No new intent created (still just the one from before)
    const intents = getIntents("wake-diagnostician", subject);
    expect(intents).toHaveLength(1); // the seeded prior only
  });

  test("runs when prior intent is OUTSIDE the cooldown window", () => {
    const { tickId, ticket, phase } = seedNeverStartedTick({ now: NOW });
    const subject = `${ticket}/${phase}`;

    // Prior intent is 15 min ago — outside the 10min cooldown
    seedPriorIntent(subject, NOW - 15 * MIN);

    const captured = [];
    const result = processDiagnosticianWakes(db, tickId, {
      env: { CATALYST_DIAGNOSTICIAN: "1" },
      captureLogs: (id) => {
        captured.push(id);
        return fakeCaptureLogs(id);
      },
      readJobState: fakeReadJobState,
      applyNeedsHuman: () => {},
    });

    // Diagnostician ran because the prior intent is expired
    expect(result.ran).toHaveLength(1);
    expect(captured).toHaveLength(1);
    // A new intent was recorded
    const intents = getIntents("wake-diagnostician", subject);
    expect(intents).toHaveLength(2); // old + new
  });
});

describe("stalled-alive variant", () => {
  test("processes a wake_diagnostician(stalled-alive) belief", () => {
    const { tickId, shortId, ticket, phase } = seedStalledAliveTick();
    const subject = `${ticket}/${phase}`;

    // Confirm R10b fired (stalled-alive)
    const stalledBelief = db
      .query(
        "SELECT * FROM belief WHERE name = 'wake_diagnostician' AND subject = ?",
      )
      .get(subject);
    expect(stalledBelief).toBeTruthy();
    expect(JSON.parse(stalledBelief.value).reason).toBe("stalled-alive");

    const captured = [];
    const result = processDiagnosticianWakes(db, tickId, {
      env: { CATALYST_DIAGNOSTICIAN: "1" },
      captureLogs: (id) => {
        captured.push(id);
        return "stalled output";
      },
      readJobState: fakeReadJobState,
      applyNeedsHuman: () => {},
    });

    expect(result.ran).toHaveLength(1);
    expect(result.ran[0].reason).toBe("stalled-alive");
    expect(result.ran[0].evidence.logsOutput).toBe("stalled output");

    const intents = getIntents("wake-diagnostician", subject);
    expect(intents).toHaveLength(1);
    expect(intents[0].outcome).toBeNull(); // unresolved → reconciler decides later
  });
});

describe("second-line escalation — needs-human only AFTER diagnostician ran", () => {
  test("needs-human NOT called on first wake (diagnostician just ran)", () => {
    const { tickId, ticket, phase } = seedNeverStartedTick();
    const subject = `${ticket}/${phase}`;

    const humanCalls = [];
    processDiagnosticianWakes(db, tickId, {
      env: { CATALYST_DIAGNOSTICIAN: "1" },
      captureLogs: fakeCaptureLogs,
      readJobState: fakeReadJobState,
      applyNeedsHuman: (s, ev) => humanCalls.push({ s, ev }),
    });

    // Diagnostician ran but has not yet been deemed ineffective → no human paged
    expect(humanCalls).toHaveLength(0);
  });

  test("needs-human called WITH evidence when wake action is ineffective (attempts >= max_attempts)", () => {
    const { tickId, ticket, phase } = seedNeverStartedTick({ now: NOW });
    const subject = `${ticket}/${phase}`;

    // Simulate the diagnostician ran before (prior intent, max_attempts reached)
    // R11 (action_ineffective) fires when attempts >= max_attempts (default: 2)
    // We seed an intent that has max_attempts attempts with no outcome.
    const priorTickId = insertTick(NOW - 15 * MIN);
    db.run(
      "INSERT INTO intent (tick_id, kind, subject, attempts, outcome, postcondition) VALUES (?, ?, ?, ?, ?, ?)",
      [priorTickId, "wake-diagnostician", subject, 2, null, "diagnostician_ran"],
    );

    // Now also evaluate beliefs for the prior tick so R11 can fire
    // (R11 is computed over the intent table across all ticks — it uses
    // the CURRENT tick's belief evaluation, not a past tick's)
    // The current tick already has wake_diagnostician; we re-run evaluation
    // to pick up R11 + R12 for the current tickId
    // (evaluateBeliefs was already called in seedNeverStartedTick)
    // We need a fresh tick with R12 derived:
    const tick2 = insertTick(NOW + 5 * MIN);
    // Re-seed signal facts for the new tick so R4/R10 fire again
    insertSignal(tick2, {
      ticket,
      phase,
      bg_job_id: "abcCTLT1",
      started_at_ms: NOW - 10 * MIN,
      updated_at_ms: NOW - 10 * MIN,
    });
    insertAgent(tick2, { session_id: "abcCTLT1-session", short_id: "abcCTLT1", kind: "background" });
    insertJob(tick2, { bg_job_id: "abcCTLT1", state: "working", tempo: "blocked" });
    evaluateBeliefs(db, tick2);

    // Confirm R12 escalate_human fired for tick2
    const humanBelief = db
      .query("SELECT * FROM belief WHERE name = 'escalate_human' AND tick_id = ?")
      .get(tick2);
    expect(humanBelief).toBeTruthy();

    // Run processDiagnosticianWakes on tick2 — now the intent is "ineffective"
    // and R12 is present; needs-human should fire WITH evidence
    const humanCalls = [];
    const result = processDiagnosticianWakes(db, tick2, {
      env: { CATALYST_DIAGNOSTICIAN: "1" },
      captureLogs: fakeCaptureLogs,
      readJobState: fakeReadJobState,
      applyNeedsHuman: (s, ev) => humanCalls.push({ s, ev }),
    });

    // needs-human fired for the subject with evidence attached
    expect(humanCalls).toHaveLength(1);
    expect(humanCalls[0].s).toBe(subject);
    expect(humanCalls[0].ev).toBeDefined();
    // Evidence carries what the diagnostician captured
    expect(humanCalls[0].ev.reason).toBeDefined();
  });

  test("needs-human carries the diagnostician evidence, not a bare label", () => {
    const { ticket, phase } = seedNeverStartedTick({ now: NOW });
    const subject = `${ticket}/${phase}`;

    // Seed a maxed-out intent + second tick with R12
    const priorTickId = insertTick(NOW - 15 * MIN);
    db.run(
      "INSERT INTO intent (tick_id, kind, subject, attempts, outcome, postcondition) VALUES (?, ?, ?, ?, ?, ?)",
      [priorTickId, "wake-diagnostician", subject, 2, null, "diagnostician_ran"],
    );
    const tick2 = insertTick(NOW + 5 * MIN);
    insertSignal(tick2, {
      ticket,
      phase,
      bg_job_id: "abcCTLT1",
      started_at_ms: NOW - 10 * MIN,
      updated_at_ms: NOW - 10 * MIN,
    });
    insertAgent(tick2, { session_id: "abcCTLT1-session", short_id: "abcCTLT1", kind: "background" });
    insertJob(tick2, { bg_job_id: "abcCTLT1", state: "working", tempo: "blocked" });
    evaluateBeliefs(db, tick2);

    const humanCalls = [];
    processDiagnosticianWakes(db, tick2, {
      env: { CATALYST_DIAGNOSTICIAN: "1" },
      captureLogs: () => "⏺ Unknown command: /catalyst-dev:phase-implement",
      readJobState: fakeReadJobState,
      applyNeedsHuman: (s, ev) => humanCalls.push({ s, ev }),
    });

    expect(humanCalls).toHaveLength(1);
    const { ev } = humanCalls[0];
    // Evidence must carry diagnostic information (not just the subject)
    expect(ev).toHaveProperty("reason");
    expect(ev).toHaveProperty("logsOutput");
    expect(ev.logsOutput).toContain("Unknown command");
    expect(ev).toHaveProperty("jobState");
  });
});

describe("multiple subjects in one tick", () => {
  test("processes each fresh wake_diagnostician belief independently", () => {
    // Seed two different stuck workers on the same tick
    const t1 = seedNeverStartedTick({ ticket: "CTL-A", phase: "plan" });
    // For the second subject, use the SAME tickId but add more facts
    const tickId = insertTick(NOW + 1);
    insertSignal(tickId, {
      ticket: "CTL-B",
      phase: "implement",
      bg_job_id: "bbbshort",
      started_at_ms: NOW - 10 * MIN,
      updated_at_ms: NOW - 10 * MIN,
    });
    insertAgent(tickId, { session_id: "bbbshort-sess", short_id: "bbbshort", kind: "background" });
    insertJob(tickId, { bg_job_id: "bbbshort", state: "working", tempo: "blocked" });
    evaluateBeliefs(db, tickId);

    const captured = [];
    const result = processDiagnosticianWakes(db, tickId, {
      env: { CATALYST_DIAGNOSTICIAN: "1" },
      captureLogs: (id) => {
        captured.push(id);
        return `logs for ${id}`;
      },
      readJobState: fakeReadJobState,
      applyNeedsHuman: () => {},
    });

    // CTL-B/implement processed on tickId
    expect(result.ran).toHaveLength(1);
    expect(result.ran[0].subject).toBe("CTL-B/implement");
  });
});
