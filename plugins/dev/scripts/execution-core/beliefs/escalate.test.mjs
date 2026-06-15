// beliefs/escalate.test.mjs — CTL-962: the single escalate_human executor.
//
// Two kinds of tests:
//   (i)  UNIT — executeEscalations behavior in shadow vs enforce: shadow applies
//        no label / no flip / no emit; enforce pages EXACTLY ONCE (label +
//        escalate.human event) and flips the matching capped wake-diagnostician
//        intent to 'escalated'; a second call on the next tick does not page
//        again (intent already 'escalated' → R11/R12 stop firing).
//   (ii) MULTI-TICK LADDER (the centerpiece) — drives the REAL production tick
//        order across multiple ticks: collectTickFacts (evaluateBeliefs THEN
//        reconcileIntents) → processDiagnosticianWakes → executeEscalations, with
//        injected fakes, so R4 → R10 → R11 → R12 derive in the real order and the
//        executor pages exactly once. Per-tick hand-computed expectations inline.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openBeliefsDb } from "./schema.mjs";
import { evaluateBeliefs } from "./rules.mjs";
import { executeEscalations } from "./escalate.mjs";
import { collectTickFacts, __resetBeliefsCollectorForTests } from "./collector.mjs";
import { processDiagnosticianWakes, __resetDiagnosticianForTests } from "../diagnostician.mjs";

// ── frozen time ───────────────────────────────────────────────────────────
const NOW = 1781030108000; // 2026-06-09T18:35:08Z
const HOUR = 3_600_000;
const MIN = 60_000;

const tmps = [];
function scratch() {
  const d = mkdtempSync(join(tmpdir(), "ctl962-escalate-"));
  tmps.push(d);
  return d;
}

let db;
beforeEach(() => {
  __resetBeliefsCollectorForTests();
  __resetDiagnosticianForTests();
  db = openBeliefsDb({ path: join(scratch(), "b.db") });
});
afterEach(() => {
  __resetBeliefsCollectorForTests();
  __resetDiagnosticianForTests();
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

// ── fixture builders ────────────────────────────────────────────────────────
function insertTick(now = NOW, host = "mini") {
  db.run("INSERT INTO tick (now_ms, host) VALUES (?, ?)", [now, host]);
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}
function seedCfg(key, valueInt) {
  db.run("INSERT OR REPLACE INTO cfg (key, value_int) VALUES (?, ?)", [key, valueInt]);
}
// Insert an escalate_human belief row directly (UNIT tests — no rule run needed).
function insertEscalateHuman(tickId, subject, why = "stalled-alive") {
  db.run(
    `INSERT INTO belief (tick_id, stratum, name, subject, value, rule_id, source_fact_ids)
     VALUES (?, 4, 'escalate_human', ?, ?, 'R12', '[]')`,
    [tickId, subject, JSON.stringify({ why })],
  );
}
// Insert a wake-diagnostician intent row directly (UNIT tests).
function insertWakeIntent(tickId, subject, { attempts = 2, outcome = null } = {}) {
  db.run(
    "INSERT INTO intent (tick_id, kind, subject, attempts, outcome) VALUES (?, ?, ?, ?, ?)",
    [tickId, "wake-diagnostician", subject, attempts, outcome],
  );
  return db.query("SELECT last_insert_rowid() AS id").get().id;
}

// A writeStatus fake whose applyLabel records every call so we can count pages.
function makeWriteStatus(calls) {
  return {
    applyLabel: ({ ticket, label }) => {
      calls.push({ ticket, label });
      return { applied: true };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// (i) UNIT TESTS
// ──────────────────────────────────────────────────────────────────────────
describe("executeEscalations — shadow mode (enforce=false)", () => {
  test("applies NO label, does NOT flip the intent, emits nothing", () => {
    seedCfg("max_attempts", 2);
    const t = insertTick(NOW);
    const subject = "CTL-1/implement";
    insertEscalateHuman(t, subject);
    const intentId = insertWakeIntent(t, subject, { attempts: 2, outcome: null });

    const labelCalls = [];
    const events = [];
    const res = executeEscalations(db, t, {
      orchDir: scratch(),
      writeStatus: makeWriteStatus(labelCalls),
      appendEvent: (e) => events.push(e),
      enforce: false,
    });

    // record-only: nothing happens to the world
    expect(labelCalls).toHaveLength(0);
    expect(events).toHaveLength(0);
    expect(res.paged).toBe(0);
    expect(res.escalated).toBe(0);
    expect(res.skipped).toBe(1);

    // intent untouched (still open + capped) so the operator-visible state is intact
    const row = db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(intentId);
    expect(row.outcome).toBeNull();
  });
});

describe("executeEscalations — enforce mode (enforce=true)", () => {
  test("pages EXACTLY ONCE: label applied, escalate.human emitted, intent flipped to escalated", () => {
    seedCfg("max_attempts", 2);
    const t = insertTick(NOW);
    const subject = "CTL-1/implement";
    insertEscalateHuman(t, subject, "stalled-alive");
    const intentId = insertWakeIntent(t, subject, { attempts: 2, outcome: null });

    // Injected labelOnce fake — records every (ticket,label) it is asked to apply,
    // and marks a marker set so a second call is a no-op (mimics labelOnce's
    // per-(ticket,label) idempotency without touching the filesystem).
    const labelMarkers = new Set();
    const labelOnceCalls = [];
    const labelOnceFn = (orchDir, ticket, label) => {
      labelOnceCalls.push({ ticket, label });
      labelMarkers.add(`${ticket}:${label}`); // marker — second apply is suppressed
    };

    const events = [];
    const res = executeEscalations(db, t, {
      orchDir: scratch(),
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn,
    });

    // (a) escalate.human event emitted with subject/ticket/why
    expect(events).toHaveLength(1);
    expect(events[0]["event.name"]).toBe("escalate.human");
    expect(events[0].payload.subject).toBe(subject);
    expect(events[0].payload.ticket).toBe("CTL-1");
    expect(events[0].payload.why).toBe("stalled-alive");

    // (b) label applied EXACTLY ONCE via the injected labelOnce fake
    expect(labelOnceCalls).toHaveLength(1);
    expect(labelOnceCalls[0]).toEqual({ ticket: "CTL-1", label: "needs-human" });
    expect(labelMarkers.has("CTL-1:needs-human")).toBe(true);
    expect(res.paged).toBe(1);

    // (c) the capped wake-diagnostician intent flipped to 'escalated'
    const row = db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(intentId);
    expect(row.outcome).toBe("escalated");
    expect(res.escalated).toBe(1);
  });

  test("second call on the next tick does NOT page again (intent already escalated)", () => {
    seedCfg("max_attempts", 2);
    const t1 = insertTick(NOW);
    const subject = "CTL-1/implement";
    insertEscalateHuman(t1, subject);
    const intentId = insertWakeIntent(t1, subject, { attempts: 2, outcome: null });

    const labelOnceCalls = [];
    const labelOnceFn = (_o, ticket, label) => labelOnceCalls.push({ ticket, label });
    const events = [];

    // First escalation tick — pages once, flips the intent.
    executeEscalations(db, t1, {
      orchDir: scratch(),
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn,
    });
    expect(db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(intentId).outcome).toBe(
      "escalated",
    );

    // Next tick: with the intent now 'escalated', R11 (outcome IS NULL) no longer
    // matches, so R12 would not re-derive. Simulate that the rule layer therefore
    // produced NO escalate_human belief for t2 → executor pages nothing.
    const t2 = insertTick(NOW + 5 * MIN);
    const res2 = executeEscalations(db, t2, {
      orchDir: scratch(),
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn,
    });
    // No belief this tick → no new page, no new flip.
    expect(res2.paged).toBe(0);
    expect(res2.escalated).toBe(0);
    expect(labelOnceCalls).toHaveLength(1); // STILL exactly one page across both ticks
    expect(events).toHaveLength(1); // STILL exactly one escalate.human event
  });

  test("cooldown RE-ARM: R12 re-fires on a later tick but the event + paged stay bounded to once (CTL-962)", () => {
    // A persistently-stuck ticket re-derives R12 every cooldown period: the
    // diagnostician records a FRESH wake intent, it caps, R11/R12 co-occur again.
    // The intent flip only bounds the immediate-next tick; the cooldown re-arm is
    // a brand-new escalate_human belief on a brand-new tick with a freshly-capped
    // intent the flip never touched. Without gating on labelOnce's return, a new
    // escalate.human event would emit and `paged` would overcount every re-arm.
    seedCfg("max_attempts", 2);

    // A labelOnce fake that mirrors the REAL marker idempotency: first apply for
    // (ticket,label) returns true (fresh write); every later apply returns false.
    const applied = new Set();
    const labelOnceFn = (_o, ticket, label, writeStatus) => {
      const key = `${ticket}:${label}`;
      if (applied.has(key)) return false; // marker exists → no-op (real labelOnce)
      applied.add(key);
      writeStatus.applyLabel({ ticket, label });
      return true; // first application
    };

    const labelCalls = [];
    const events = [];
    const subject = "CTL-1/implement";

    // ── tick 1: first escalation — pages once, emits once ──
    const t1 = insertTick(NOW);
    insertEscalateHuman(t1, subject);
    insertWakeIntent(t1, subject, { attempts: 2, outcome: null });
    const res1 = executeEscalations(db, t1, {
      orchDir: scratch(),
      writeStatus: makeWriteStatus(labelCalls),
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn,
    });
    expect(res1.paged).toBe(1);
    expect(events.filter((e) => e["event.name"] === "escalate.human")).toHaveLength(1);
    expect(labelCalls).toHaveLength(1);

    // ── tick 2 (RE-ARM): a NEW capped wake intent + a NEW escalate_human belief.
    // R12 fires again, but needs-human is already applied → NO new event/page. ──
    const t2 = insertTick(NOW + 10 * MIN);
    insertEscalateHuman(t2, subject); // R12 re-derived this tick
    insertWakeIntent(t2, subject, { attempts: 2, outcome: null }); // fresh capped intent
    const res2 = executeEscalations(db, t2, {
      orchDir: scratch(),
      writeStatus: makeWriteStatus(labelCalls),
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn,
    });
    // The intent flip still fires (escalated>0) but the page/event are suppressed.
    expect(res2.paged).toBe(0);
    expect(res2.escalated).toBeGreaterThanOrEqual(1);

    // ── tick 3 (RE-ARM again): same — still bounded ──
    const t3 = insertTick(NOW + 20 * MIN);
    insertEscalateHuman(t3, subject);
    insertWakeIntent(t3, subject, { attempts: 2, outcome: null });
    const res3 = executeEscalations(db, t3, {
      orchDir: scratch(),
      writeStatus: makeWriteStatus(labelCalls),
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn,
    });
    expect(res3.paged).toBe(0);

    // ── exactly-once across ALL THREE ticks: one label write, one event ──
    expect(labelCalls).toHaveLength(1);
    expect(events.filter((e) => e["event.name"] === "escalate.human")).toHaveLength(1);
  });

  test("a fresh (uncapped) wake intent is NOT prematurely flipped", () => {
    seedCfg("max_attempts", 2);
    const t = insertTick(NOW);
    const subject = "CTL-1/implement";
    insertEscalateHuman(t, subject);
    // attempts below the cap → flipIntent's `attempts >= max_attempts` excludes it
    const freshId = insertWakeIntent(t, subject, { attempts: 1, outcome: null });

    const res = executeEscalations(db, t, {
      orchDir: scratch(),
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: () => {},
      enforce: true,
      labelOnceFn: () => {},
    });
    // We still page (R12 fired), but the uncapped intent stays open.
    expect(res.paged).toBe(1);
    expect(res.escalated).toBe(0);
    expect(db.query("SELECT outcome FROM intent WHERE intent_id = ?").get(freshId).outcome).toBeNull();
  });

  test("never throws — a writeStatus that throws is isolated per subject", () => {
    seedCfg("max_attempts", 2);
    const t = insertTick(NOW);
    insertEscalateHuman(t, "CTL-1/implement");
    insertWakeIntent(t, "CTL-1/implement", { attempts: 2, outcome: null });

    const res = executeEscalations(db, t, {
      orchDir: scratch(),
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: () => {
        throw new Error("event sink exploded");
      },
      enforce: true,
      labelOnceFn: () => {},
    });
    // appendEvent threw but the label + flip still happened, and we recorded the error.
    expect(res.paged).toBe(1);
    expect(res.escalated).toBe(1);
    expect(res.errors.some((e) => e.phase === "appendEvent")).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// (ii) MULTI-TICK LADDER — the real production tick order, injected fakes.
// ──────────────────────────────────────────────────────────────────────────
//
// We drive the SAME functions the daemon's runTick drives, in the SAME order:
//   collectTickFacts (evaluateBeliefs THEN reconcileIntents)   [collector.mjs]
//   processDiagnosticianWakes                                  [diagnostician.mjs]
//   executeEscalations                                         [escalate.mjs]
//
// Fixture: a single stuck worker CTL-722/plan that is registered (R1), old
// enough (R4 wedged_never_started), with no transcript (¬R2) and a live job
// (¬R7). diag_cooldown_ms is set SMALL (1s) so R10 wake_diagnostician re-fires
// every tick; max_attempts=2.
//
// Tick cadence (each tick advances `now` by 10s, well over the 1s cooldown):
//
//  tick 1 (t=NOW):        evaluateBeliefs → R4, R10(wake). No wake-diag intent
//                         yet → no R11/R12. reconcile: no open intents.
//                         diagnostician: records wake-diag intent #1 (attempts=1,
//                         outcome NULL). executeEscalations: no R12 → 0 pages.
//
//  tick 2 (t=NOW+10s):    evaluateBeliefs sees intent#1 attempts=1 (<2) → R11
//                         does NOT fire yet; R4 + R10 fire. reconcile increments
//                         intent#1 → attempts=2 (open). diagnostician (cooldown
//                         1s already elapsed) records wake-diag intent #2
//                         (attempts=1). executeEscalations: no R12 → 0 pages.
//
//  tick 3 (t=NOW+20s):    evaluateBeliefs NOW sees intent#1 attempts=2 outcome
//                         NULL → R11 action_ineffective fires; R10 wake also
//                         fires (intent#1 is 20s old > 1s cooldown). R11 + R10
//                         co-occur → R12 escalate_human fires. (reconcile then
//                         increments intent#2 → 2 and re-counts intent#1 as
//                         capped.) processDiagnosticianWakes: R12 present + action
//                         ineffective → supplies evidence (NO label).
//                         executeEscalations: R12 present → pages ONCE, emits
//                         escalate.human, flips the capped wake-diag intents to
//                         'escalated'.
//
//  tick 4 (t=NOW+30s):    evaluateBeliefs: the wake-diag intents are now
//                         'escalated' (outcome NOT NULL) → R11 does NOT fire →
//                         R12 does NOT fire. executeEscalations: no R12 → 0 pages.
//                         Exactly-once is proven across the whole sequence.

function wedgeSources(nowMs) {
  // CTL-722/plan: registered, started ~9h ago, no transcript, job working.
  return {
    getAgents: () => [
      {
        sessionId: "5ad5c1ff-1111-2222-3333-444455556666",
        kind: "background",
        status: "idle",
        state: "blocked",
        startedAt: nowMs - 9 * HOUR,
      },
    ],
    readSignals: () => [
      {
        ticket: "CTL-722",
        phase: "plan",
        status: "running",
        liveness: { kind: "bg", value: "5ad5c1ff" },
        startedAt: nowMs - 9 * HOUR,
        updatedAt: nowMs - 9 * HOUR,
        raw: { generation: 3, startedAt: nowMs - 9 * HOUR },
      },
    ],
    readJobState: (bgJobId) =>
      bgJobId === "5ad5c1ff"
        ? { exists: true, state: "working", tempo: "blocked", detail: "stuck on a startup dialog" }
        : { exists: false },
    findTranscriptFn: () => null, // no transcript → ¬R2 → R4 fires
  };
}

function runRealTick(now, { orchDir, labelOnceFn, events, labelCalls }) {
  // 1. collector: evaluateBeliefs THEN reconcileIntents (the real order)
  const res = collectTickFacts({
    orchDir,
    db,
    now,
    host: "mini",
    env: { CATALYST_BELIEFS_SHADOW: "1", CATALYST_INTENTS_ENFORCE: "1" },
    eventLogPath: join(scratch(), "absent.jsonl"),
    linearCache: { get: () => undefined },
    ...wedgeSources(now),
  });
  const tickId = res.tickId;

  // 2. diagnostician: supplies evidence, applies NO label (CTL-962)
  const diag = processDiagnosticianWakes(db, tickId, {
    env: { CATALYST_DIAGNOSTICIAN: "1" },
    captureLogs: () => "⏺ Unknown command: /catalyst-dev:phase-plan",
    readJobState: () => ({ exists: true, state: "working", tempo: "blocked" }),
    // NO applyNeedsHuman — escalate.mjs owns the label now.
  });

  // 3. executor: the single label owner
  const esc = executeEscalations(db, tickId, {
    orchDir,
    writeStatus: makeWriteStatus(labelCalls),
    appendEvent: (e) => events.push(e),
    enforce: true,
    labelOnceFn,
  });

  return { tickId, diag, esc };
}

function beliefRows(tickId, name) {
  return db.query("SELECT * FROM belief WHERE tick_id = ? AND name = ?").all(tickId, name);
}

describe("MULTI-TICK LADDER — R4 → R10 → R11 → R12 in real tick order, paged once", () => {
  test("derives R11+R12 rows and pages exactly once across the sequence", () => {
    seedCfg("diag_cooldown_ms", 1000); // SMALL: lets R10 re-fire every tick
    seedCfg("max_attempts", 2);

    const orchDir = scratch();
    const labelMarkers = new Set();
    const labelCalls = []; // writeStatus.applyLabel calls (would be real Linear writes)
    const labelOnceCalls = []; // labelOnce invocations (idempotency-guarded)
    const events = [];
    // Injected idempotent labelOnce fake: applies once per (ticket,label), marker-guarded.
    const labelOnceFn = (_o, ticket, label, writeStatus) => {
      const key = `${ticket}:${label}`;
      if (labelMarkers.has(key)) return; // already applied this lifetime → no-op
      labelMarkers.add(key);
      labelOnceCalls.push({ ticket, label });
      writeStatus.applyLabel({ ticket, label }); // mirror the real labelOnce flow
    };

    // ── tick 1 ── R4 + R10, no R11/R12 yet ────────────────────────────────
    const t1 = runRealTick(NOW, { orchDir, labelOnceFn, events, labelCalls });
    expect(beliefRows(t1.tickId, "wedged_never_started")).toHaveLength(1); // R4
    expect(beliefRows(t1.tickId, "wake_diagnostician")).toHaveLength(1); // R10
    expect(beliefRows(t1.tickId, "action_ineffective")).toHaveLength(0); // no intent capped yet
    expect(beliefRows(t1.tickId, "escalate_human")).toHaveLength(0); // R12 not yet
    expect(t1.esc.paged).toBe(0);
    // diagnostician recorded the first wake-diag intent (attempts=1)
    const afterT1 = db
      .query("SELECT * FROM intent WHERE kind='wake-diagnostician' ORDER BY intent_id")
      .all();
    expect(afterT1).toHaveLength(1);
    expect(afterT1[0].attempts).toBe(1);
    expect(afterT1[0].outcome).toBeNull();

    // ── tick 2 ── R4 + R10 still; reconcile caps intent#1 → attempts=2 ─────
    const t2 = runRealTick(NOW + 10_000, { orchDir, labelOnceFn, events, labelCalls });
    expect(beliefRows(t2.tickId, "wake_diagnostician")).toHaveLength(1); // R10 re-fired
    // evaluateBeliefs ran BEFORE reconcile, when intent#1 was still attempts=1 →
    // R11 had nothing capped this tick.
    expect(beliefRows(t2.tickId, "action_ineffective")).toHaveLength(0);
    expect(beliefRows(t2.tickId, "escalate_human")).toHaveLength(0);
    expect(t2.esc.paged).toBe(0);
    // After tick 2's reconcile, intent#1 is capped at attempts=2, still open.
    const intent1 = db
      .query("SELECT * FROM intent WHERE kind='wake-diagnostician' ORDER BY intent_id")
      .all()[0];
    expect(intent1.attempts).toBe(2);
    expect(intent1.outcome).toBeNull();

    // ── tick 3 ── R11 + R12 CO-OCCUR → executor pages once ────────────────
    const t3 = runRealTick(NOW + 20_000, { orchDir, labelOnceFn, events, labelCalls });
    // R10 still fires (intent#1 is 20s old > 1s cooldown)
    expect(beliefRows(t3.tickId, "wake_diagnostician")).toHaveLength(1);
    // R11 action_ineffective fires now (intent#1 attempts=2, outcome NULL)
    const r11 = beliefRows(t3.tickId, "action_ineffective");
    expect(r11).toHaveLength(1);
    expect(r11[0].rule_id).toBe("R11");
    expect(r11[0].subject).toBe("wake-diagnostician:CTL-722/plan");
    // R11 provenance cites the intent ('i<intent_id>')
    expect(JSON.parse(r11[0].source_fact_ids)[0]).toMatch(/^i\d+$/);
    // R12 escalate_human fires (R10 + R11 co-occur)
    const r12 = beliefRows(t3.tickId, "escalate_human");
    expect(r12).toHaveLength(1);
    expect(r12[0].rule_id).toBe("R12");
    expect(r12[0].subject).toBe("CTL-722/plan");
    // R12 provenance cites the wake belief AND the action_ineffective belief
    const wd = beliefRows(t3.tickId, "wake_diagnostician")[0];
    expect(JSON.parse(r12[0].source_fact_ids).sort()).toEqual(
      [`b${wd.belief_id}`, `b${r11[0].belief_id}`].sort(),
    );
    // executor pages ONCE this tick
    expect(t3.esc.paged).toBe(1);
    expect(t3.esc.escalated).toBeGreaterThanOrEqual(1); // capped intent(s) → 'escalated'
    expect(events.filter((e) => e["event.name"] === "escalate.human")).toHaveLength(1);

    // ── tick 4 ── intent escalated → R11/R12 stop → no second page ────────
    const t4 = runRealTick(NOW + 30_000, { orchDir, labelOnceFn, events, labelCalls });
    expect(beliefRows(t4.tickId, "action_ineffective")).toHaveLength(0); // intent escalated
    expect(beliefRows(t4.tickId, "escalate_human")).toHaveLength(0);
    expect(t4.esc.paged).toBe(0);

    // ── EXACTLY ONE needs-human application across the whole sequence ──────
    expect(labelOnceCalls).toHaveLength(1);
    expect(labelCalls).toHaveLength(1);
    expect(labelCalls[0]).toEqual({ ticket: "CTL-722", label: "needs-human" });
    expect(events.filter((e) => e["event.name"] === "escalate.human")).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// CTL-1130: typed-union explanation in escalate.human events
// ──────────────────────────────────────────────────────────────────────────
import { validateExplanation } from "../escalation-explanation.mjs";

describe("CTL-1130: executeEscalations emits typed-union explanation", () => {
  test("R12 page emits a typed-union explanation (authorization by default)", () => {
    seedCfg("max_attempts", 2);
    const tickId = insertTick(NOW);
    const subject = "CTL-7/implement";
    insertEscalateHuman(tickId, subject, "stalled-alive");
    insertWakeIntent(tickId, subject, { attempts: 2, outcome: null });

    const events = [];
    const evidenceBySubject = {
      "CTL-7/implement": {
        logsOutput: "Error: tsc failed with 3 errors",
        jobState: { elapsedMin: 42, commitCount: 0, bgJobId: "ab12ef34" },
      },
    };

    executeEscalations(db, tickId, {
      orchDir: scratch(),
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn: () => true,
      evidenceBySubject,
    });

    const ev = events.find((e) => e["event.name"] === "escalate.human");
    expect(ev).toBeTruthy();
    const expl = ev.payload.explanation;
    expect(validateExplanation(expl).valid).toBe(true);
    expect(["manual", "authorization", "decision"]).toContain(expl.escalation_type);
    // observed passthrough: bgJobId must survive (D1)
    expect(expl.observed?.bgJobId).toBe("ab12ef34");
    // why still present on the event payload (backward compat)
    expect(ev.payload.why).toBe("stalled-alive");
  });

  test("page builds MANUAL when evidence carries canExecute:false + blockedCapability", () => {
    seedCfg("max_attempts", 2);
    const tickId = insertTick(NOW);
    const subject = "CTL-7/pr";
    insertEscalateHuman(tickId, subject, "push-rejected");
    insertWakeIntent(tickId, subject, { attempts: 1, outcome: null });

    const events = [];
    executeEscalations(db, tickId, {
      orchDir: scratch(),
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn: () => true,
      evidenceBySubject: {
        "CTL-7/pr": {
          canExecute: false,
          blockedCapability: "host token lacks workflow OAuth scope",
          logsOutput: "push rejected: missing workflow scope",
          jobState: {},
        },
      },
    });

    const ev = events.find((e) => e["event.name"] === "escalate.human");
    expect(ev).toBeTruthy();
    expect(ev.payload.explanation.escalation_type).toBe("manual");
    expect(validateExplanation(ev.payload.explanation).valid).toBe(true);
  });

  test("page builds DECISION when evidence carries escalation_type:'decision'", () => {
    seedCfg("max_attempts", 2);
    const tickId = insertTick(NOW);
    const subject = "CTL-7/implement";
    insertEscalateHuman(tickId, subject, "stalled-alive");
    insertWakeIntent(tickId, subject, { attempts: 2, outcome: null });

    const events = [];
    executeEscalations(db, tickId, {
      orchDir: scratch(),
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn: () => true,
      evidenceBySubject: {
        "CTL-7/implement": {
          escalation_type: "decision",
          options: [
            { label: "re-dispatch", tradeoff: "may fail again" },
            { label: "abandon", tradeoff: "lose progress" },
          ],
          why_you: "priority call the scheduler cannot compute",
          logsOutput: "dispatch exhausted",
          jobState: {},
        },
      },
    });

    const ev = events.find((e) => e["event.name"] === "escalate.human");
    expect(ev).toBeTruthy();
    expect(ev.payload.explanation.escalation_type).toBe("decision");
    expect(validateExplanation(ev.payload.explanation).valid).toBe(true);
  });

  test("missing evidence degrades to a valid DECISION (never manual)", () => {
    seedCfg("max_attempts", 2);
    const tickId = insertTick(NOW);
    const subject = "CTL-7/implement";
    insertEscalateHuman(tickId, subject, "stalled-alive");
    insertWakeIntent(tickId, subject, { attempts: 2, outcome: null });

    const events = [];
    executeEscalations(db, tickId, {
      orchDir: scratch(),
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn: () => true,
      // no evidenceBySubject
    });

    const ev = events.find((e) => e["event.name"] === "escalate.human");
    expect(ev).toBeTruthy();
    const expl = ev.payload.explanation;
    expect(validateExplanation(expl).valid).toBe(true);
    expect(expl.escalation_type).not.toBe("manual");
    expect(expl.call_to_action).toContain("CTL-7");
  });
});

// ─── CTL-1131: executeEscalations persists explanation + needsHumanSince to the phase signal ───
describe("CTL-1131: executeEscalations (enforce) writes explanation + needsHumanSince to signal", () => {
  const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

  function seedSignal(orchDir, ticket, phase, extra = {}) {
    const dir = join(orchDir, "workers", ticket);
    mkdirSync(dir, { recursive: true });
    const sig = { ticket, phase, status: "running", ...extra };
    writeFileSync(join(dir, `phase-${phase}.json`), JSON.stringify(sig, null, 2) + "\n");
  }

  function readSignal(orchDir, ticket, phase) {
    return JSON.parse(readFileSync(join(orchDir, "workers", ticket, `phase-${phase}.json`), "utf8"));
  }

  test("first page: signal gains explanation + needsHumanSince; prior fields preserved", () => {
    seedCfg("max_attempts", 2);
    const t = insertTick(NOW);
    const ticket = "CTL-1131x", phase = "implement";
    const subject = `${ticket}/${phase}`;
    insertEscalateHuman(t, subject, "stalled-alive");
    insertWakeIntent(t, subject, { attempts: 2, outcome: null });

    const orchDir = scratch();
    seedSignal(orchDir, ticket, phase, { bg_job_id: "abc123" });

    const events = [];
    executeEscalations(db, t, {
      orchDir,
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn: () => {},
    });

    const sig = readSignal(orchDir, ticket, phase);
    expect(sig.explanation).toBeTruthy();
    expect(typeof sig.needsHumanSince).toBe("string");
    expect(ISO_RE.test(sig.needsHumanSince)).toBe(true);
    // prior fields preserved
    expect(sig.status).toBe("running");
    expect(sig.bg_job_id).toBe("abc123");
    // explanation matches what was appended to the event
    const ev = events.find((e) => e["event.name"] === "escalate.human");
    expect(sig.explanation).toEqual(ev.payload.explanation);
  });

  test("missing signal file: no throw, escalation still returns paged=1", () => {
    seedCfg("max_attempts", 2);
    const t = insertTick(NOW);
    const ticket = "CTL-1131y", phase = "implement";
    const subject = `${ticket}/${phase}`;
    insertEscalateHuman(t, subject, "stalled-alive");
    insertWakeIntent(t, subject, { attempts: 2, outcome: null });

    const orchDir = scratch(); // no signal file seeded → best-effort miss
    const events = [];
    const res = executeEscalations(db, t, {
      orchDir,
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: (e) => events.push(e),
      enforce: true,
      labelOnceFn: () => {},
    });

    expect(res.paged).toBe(1);
    expect(events).toHaveLength(1);
  });

  test("re-arm (firstPage=false via labelOnceFn returning false): signal NOT rewritten", () => {
    seedCfg("max_attempts", 2);
    const t = insertTick(NOW);
    const ticket = "CTL-1131z", phase = "implement";
    const subject = `${ticket}/${phase}`;
    insertEscalateHuman(t, subject, "stalled-alive");
    insertWakeIntent(t, subject, { attempts: 2, outcome: null });

    const orchDir = scratch();
    seedSignal(orchDir, ticket, phase, { needsHumanSince: "2026-06-14T01:00:00Z" });

    // labelOnceFn returns false → firstPage=false → signal write must not run
    executeEscalations(db, t, {
      orchDir,
      writeStatus: { applyLabel: () => ({ applied: true }) },
      appendEvent: () => {},
      enforce: true,
      labelOnceFn: () => false,
    });

    const sig = readSignal(orchDir, ticket, phase);
    // needsHumanSince must not be overwritten by the re-arm path
    expect(sig.needsHumanSince).toBe("2026-06-14T01:00:00Z");
    // explanation must not have been written by the re-arm path
    expect(sig.explanation).toBeUndefined();
  });
});
